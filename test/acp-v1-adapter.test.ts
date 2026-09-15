import { describe, expect, test } from "bun:test";
import * as acp from "@agentclientprotocol/sdk";
import {
  createAcpV1Adapter,
} from "../src/adapters/acp-v1-adapter.ts";
import type { AcpV1ByteConnection } from "../src/adapters/acp-v1.ts";
import { createHarness, type HarnessRuntime } from "../src/runtime.ts";
import { createMemoryPersistence } from "../src/stores.ts";
import type { HarnessEvent, HarnessRunRequest, HarnessTurnStatus } from "../src/protocol.ts";
import { createAcpV1ConformanceFixture, runAdapterConformance } from "../src/testing/index.ts";

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of stream) values.push(value);
  return values;
}

interface FakeState {
  closes: number;
  initialize: acp.InitializeRequest[];
  sessions: Array<acp.NewSessionRequest | acp.LoadSessionRequest>;
  prompts: acp.PromptRequest[];
  cancellations: number;
}

function fakeState(): FakeState {
  return { closes: 0, initialize: [], sessions: [], prompts: [], cancellations: 0 };
}

function byteConnection(agent: acp.AgentApp, state: FakeState): AcpV1ByteConnection {
  const clientToAgent = new TransformStream<Uint8Array>();
  let outputController!: ReadableStreamDefaultController<Uint8Array>;
  let outputClosed = false;
  const readable = new ReadableStream<Uint8Array>({ start(controller) { outputController = controller; } });
  const output = new WritableStream<Uint8Array>({
    write(chunk) { outputController.enqueue(chunk); },
    close() {
      if (outputClosed) return;
      outputClosed = true;
      outputController.close();
    },
    abort(error) {
      if (outputClosed) return;
      outputClosed = true;
      outputController.error(error);
    },
  });
  const connection = agent.connect(acp.ndJsonStream(output, clientToAgent.readable));
  void connection.closed.then(() => {
    if (outputClosed) return;
    outputClosed = true;
    try { outputController.close(); } catch { /* stream cancellation already closed it */ }
  });
  let closed = false;
  return {
    readable,
    writable: clientToAgent.writable,
    close() {
      if (closed) return;
      closed = true;
      state.closes += 1;
      connection.close();
    },
  };
}

function basicAgent(
  state: FakeState,
  options: {
    protocolVersion?: number;
    loadSession?: boolean;
    sessionId?: string;
    onLoad?: (context: acp.AgentRequestContext<acp.LoadSessionRequest>) => Promise<acp.LoadSessionResponse> | acp.LoadSessionResponse;
    onPrompt?: (context: acp.AgentRequestContext<acp.PromptRequest>) => Promise<acp.PromptResponse> | acp.PromptResponse;
  } = {},
): acp.AgentApp {
  return acp.agent({ name: "fold-harness-fake" })
    .onRequest(acp.methods.agent.initialize, ({ params }) => {
      state.initialize.push(params);
      return {
        protocolVersion: options.protocolVersion ?? 1,
        agentCapabilities: {
          ...(options.loadSession ? { loadSession: true } : {}),
          promptCapabilities: { image: true },
        },
        agentInfo: { name: "fake", version: "1" },
      };
    })
    .onRequest(acp.methods.agent.session.new, ({ params }) => {
      state.sessions.push(params);
      return { sessionId: options.sessionId ?? "acp-session" };
    })
    .onRequest(acp.methods.agent.session.load, async (context) => {
      const { params } = context;
      state.sessions.push(params);
      if (options.onLoad) return options.onLoad(context);
      return {};
    })
    .onRequest(acp.methods.agent.session.prompt, async (context) => {
      state.prompts.push(context.params);
      if (options.onPrompt) return options.onPrompt(context);
      await context.client.notify(acp.methods.client.session.update, {
        sessionId: context.params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "done" },
        },
      });
      return { stopReason: "end_turn" };
    })
    .onNotification(acp.methods.agent.session.cancel, () => {
      state.cancellations += 1;
    });
}

function runRequest(adapterId: string, overrides: Partial<HarnessRunRequest> = {}): HarnessRunRequest {
  return {
    session: { tenantId: "tenant", actorId: "actor", threadId: "thread" },
    adapterId,
    input: [{ type: "text", text: "hello" }],
    ...overrides,
  };
}

async function finish(runtime: HarnessRuntime, request: HarnessRunRequest): Promise<{
  events: HarnessEvent[];
  status: HarnessTurnStatus;
}> {
  const run = runtime.start(request);
  const events = await collect(run.events);
  const status = await run.done;
  return { events, status };
}

describe("ACP v1 adapter", () => {
  test("passes the shared adapter conformance suite through an official-SDK ACP peer", async () => {
    const fixture = createAcpV1ConformanceFixture();
    const report = await runAdapterConformance({ fixture });

    expect(report.passed).toBe(true);
    expect(report.cases.filter((entry) => entry.status === "failed")).toEqual([]);
    expect(fixture.state.cancellations).toBe(2);
    expect(fixture.state.loadedSessions).toContain("conformance-resume-token");
    expect(fixture.state.permissionOutcomes).toEqual([{ outcome: "selected", optionId: "continue" }]);
  });

  test("negotiates v1 and normalizes streamed text, thought, plan, tools, limits, and cumulative usage", async () => {
    const state = fakeState();
    const secrets = "raw-secret-must-not-persist";
    const checkpoints: string[] = [];
    const limits: unknown[] = [];
    const negotiated: unknown[] = [];
    const agent = basicAgent(state, {
      sessionId: "checkpoint-1",
      async onPrompt({ params, client }) {
        const notify = (update: acp.SessionUpdate) => client.notify(acp.methods.client.session.update, {
          sessionId: params.sessionId,
          update,
        });
        await notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } });
        await notify({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } });
        await notify({
          sessionUpdate: "plan",
          entries: [{ content: "Inspect", priority: "high", status: "in_progress" }],
        });
        await notify({
          sessionUpdate: "tool_call",
          toolCallId: "tool-1",
          title: "Read workspace",
          kind: "read",
          status: "in_progress",
          rawInput: { token: secrets },
        });
        await notify({
          sessionUpdate: "tool_call_update",
          toolCallId: "tool-1",
          status: "completed",
          rawOutput: secrets,
          content: [{ type: "content", content: { type: "text", text: secrets } }],
        });
        await notify({
          sessionUpdate: "tool_call_update",
          toolCallId: "tool-1",
          status: "completed",
          rawOutput: "duplicate-secret",
        });
        await notify({
          sessionUpdate: "usage_update",
          used: 80,
          size: 100,
          cost: { amount: 0.25, currency: "USD" },
        });
        return {
          stopReason: "end_turn",
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, cachedReadTokens: 2 },
          _meta: { secret: secrets },
        };
      },
    });
    const adapter = createAcpV1Adapter({
      id: "acp-test",
      clientInfo: { name: "test-client", version: "1.2.3" },
      session: () => ({ cwd: "/tmp/acp-test" }),
      connect: () => byteConnection(agent, state),
      async onCheckpoint(value) { checkpoints.push(value); },
      onLimits(value) { limits.push(value); },
      onNegotiated(value) { negotiated.push(value); },
    });
    const runtime = createHarness({ adapters: [adapter], persistence: createMemoryPersistence() });

    const result = await finish(runtime, runRequest(adapter.id));
    expect(result.status).toBe("completed");
    expect(state.initialize).toHaveLength(1);
    expect(state.initialize[0]).toMatchObject({
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "test-client", version: "1.2.3" },
    });
    expect(checkpoints).toEqual(["checkpoint-1"]);
    expect(negotiated).toEqual([{
      protocolVersion: 1,
      agentInfo: { name: "fake", version: "1" },
      capabilities: {
        loadSession: false,
        imagePrompt: true,
        additionalDirectories: false,
        mcp: { stdio: true, http: false, sse: false },
      },
    }]);
    expect(result.events.map((event) => event.payload.kind)).toEqual([
      "turn-started",
      "assistant-text",
      "thinking",
      "plan-updated",
      "tool-started",
      "tool-completed",
      "usage",
      "turn-completed",
    ]);
    expect(result.events.find((event) => event.payload.kind === "tool-completed")?.payload).toEqual({
      kind: "tool-completed",
      toolId: "tool-1",
      status: "completed",
      toolKind: "read",
      title: "Read workspace",
    });
    expect(result.events.find((event) => event.payload.kind === "usage")?.payload).toEqual({
      kind: "usage",
      usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 2, totalTokens: 15, costUsd: 0.25 },
    });
    expect(JSON.stringify(result.events)).not.toContain(secrets);
    expect(JSON.stringify(result.events)).not.toContain("duplicate-secret");
    expect(result.events.filter((event) => event.payload.kind === "tool-completed")).toHaveLength(1);
    expect(limits).toHaveLength(1);
    const reportedLimits = limits[0] as { limits: Array<Record<string, unknown>> };
    expect(reportedLimits.limits[0]).toMatchObject({ id: "acp:context-window", used: 80, limit: 100 });
    expect(await runtime.limits(adapter.id)).toEqual({ status: "unsupported" });
    await runtime.close();
    expect(state.closes).toBe(1);
  });

  test("restores only through advertised session/load and never falls back to session/new", async () => {
    const persistence = createMemoryPersistence();
    const firstState = fakeState();
    const firstAdapter = createAcpV1Adapter({
      id: "acp-resume",
      session: () => ({ cwd: "/tmp/acp-resume" }),
      connect: () => byteConnection(basicAgent(firstState, { sessionId: "saved-session" }), firstState),
    });
    const first = createHarness({ adapters: [firstAdapter], persistence });
    expect((await finish(first, runRequest(firstAdapter.id))).status).toBe("completed");
    await first.close();

    const restoredState = fakeState();
    const restoredAgent = basicAgent(restoredState, {
      loadSession: true,
      onLoad: async ({ params, client }) => {
        await client.notify(acp.methods.client.session.update, {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "loaded-history-must-not-replay" },
          },
        });
        return {};
      },
      onPrompt: async ({ params, client }) => {
        await client.notify(acp.methods.client.session.update, {
          sessionId: params.sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "restored" } },
        });
        return {
          stopReason: "end_turn",
          usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        };
      },
    });
    const restoredAdapter = createAcpV1Adapter({
      id: "acp-resume",
      session: () => ({ cwd: "/tmp/acp-resume" }),
      connect: () => byteConnection(restoredAgent, restoredState),
    });
    const restored = createHarness({ adapters: [restoredAdapter], persistence });
    const result = await finish(restored, runRequest(restoredAdapter.id));
    expect(result.status).toBe("completed");
    expect(restoredState.sessions).toEqual([{
      cwd: "/tmp/acp-resume",
      mcpServers: [],
      sessionId: "saved-session",
    }]);
    expect(result.events.some((event) => event.payload.kind === "assistant-text" && event.payload.text === "restored")).toBe(true);
    expect(JSON.stringify(result.events)).not.toContain("loaded-history-must-not-replay");
    expect(result.events.some((event) => event.payload.kind === "usage")).toBe(false);
    await restored.close();

    const refusedState = fakeState();
    const refusedAdapter = createAcpV1Adapter({
      id: "acp-resume",
      session: () => ({ cwd: "/tmp/acp-resume" }),
      connect: () => byteConnection(basicAgent(refusedState), refusedState),
    });
    const refused = createHarness({ adapters: [refusedAdapter], persistence });
    const failure = await finish(refused, runRequest(refusedAdapter.id));
    expect(failure.status).toBe("error");
    expect(failure.events.find((event) => event.payload.kind === "error")?.payload).toMatchObject({
      code: "ACP_RESUME_UNSUPPORTED",
    });
    expect(refusedState.sessions).toEqual([]);
    await refused.close();
  });

  test("round-trips only an exact permission choice and rejects stale or invented answers", async () => {
    const state = fakeState();
    const outcomes: acp.RequestPermissionResponse[] = [];
    const agent = basicAgent(state, {
      async onPrompt({ params, client }) {
        outcomes.push(await client.request(acp.methods.client.session.requestPermission, {
          sessionId: params.sessionId,
          toolCall: {
            toolCallId: "dangerous-tool",
            title: "Run command",
            kind: "execute",
            rawInput: { secret: "hidden-command" },
          },
          options: [
            { optionId: "once", name: "Allow once", kind: "allow_once" },
            { optionId: "reject", name: "Reject", kind: "reject_once" },
          ],
          _meta: { secret: "hidden-metadata" },
        }));
        return { stopReason: "end_turn" };
      },
    });
    const adapter = createAcpV1Adapter({
      id: "acp-permission",
      session: () => ({ cwd: "/tmp/acp-permission" }),
      connect: () => byteConnection(agent, state),
    });
    const runtime = createHarness({ adapters: [adapter], persistence: createMemoryPersistence() });
    const run = runtime.start(runRequest(adapter.id));
    const iterator = run.events[Symbol.asyncIterator]();
    expect((await iterator.next()).value?.payload.kind).toBe("turn-started");
    const asked = (await iterator.next()).value;
    expect(asked?.payload.kind).toBe("interaction-requested");
    if (asked?.payload.kind !== "interaction-requested") throw new Error("missing permission");
    expect(JSON.stringify(asked)).not.toContain("hidden-command");
    expect(JSON.stringify(asked)).not.toContain("hidden-metadata");
    await expect(run.respond(asked.payload.interaction.id, { choiceId: "invented" })).rejects.toMatchObject({
      code: "ACP_INVALID_PERMISSION_RESPONSE",
    });
    await run.respond(asked.payload.interaction.id, { choiceId: "once" });
    const rest: HarnessEvent[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      rest.push(next.value);
    }
    expect(await run.done).toBe("completed");
    expect(outcomes).toEqual([{ outcome: { outcome: "selected", optionId: "once" } }]);
    expect(rest.some((event) => event.payload.kind === "interaction-resolved")).toBe(true);
    await expect(run.respond(asked.payload.interaction.id, { choiceId: "once" })).rejects.toMatchObject({
      code: "INTERACTION_NOT_ACTIVE",
    });
    await runtime.close();
  });

  test("cancels pending permissions and seals an ignored cancellation by closing the transport", async () => {
    const state = fakeState();
    let permissionOutcome: acp.RequestPermissionResponse | undefined;
    const agent = basicAgent(state, {
      async onPrompt({ params, client }) {
        permissionOutcome = await client.request(acp.methods.client.session.requestPermission, {
          sessionId: params.sessionId,
          toolCall: { toolCallId: "tool", title: "Wait" },
          options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
        });
        return new Promise<acp.PromptResponse>(() => undefined);
      },
    });
    const adapter = createAcpV1Adapter({
      id: "acp-cancel",
      cancelTimeoutMs: 20,
      session: () => ({ cwd: "/tmp/acp-cancel" }),
      connect: () => byteConnection(agent, state),
    });
    const runtime = createHarness({ adapters: [adapter], persistence: createMemoryPersistence() });
    const run = runtime.start(runRequest(adapter.id));
    const eventsPromise = collect(run.events);
    await Bun.sleep(5);
    await run.cancel();
    const events = await eventsPromise;
    expect(await run.done).toBe("interrupted");
    expect(permissionOutcome).toEqual({ outcome: { outcome: "cancelled" } });
    expect(state.cancellations).toBe(1);
    await Bun.sleep(0);
    expect(state.closes).toBe(1);
    expect(events.at(-1)?.payload).toMatchObject({ kind: "turn-completed", status: "interrupted" });
    await runtime.close();
  });

  test("cancels a turn while its host connection is still pending and closes a late transport", async () => {
    let connectStarted!: () => void;
    const started = new Promise<void>((resolve) => { connectStarted = resolve; });
    let resolveConnection!: (connection: AcpV1ByteConnection) => void;
    const pendingConnection = new Promise<AcpV1ByteConnection>((resolve) => { resolveConnection = resolve; });
    let closes = 0;
    const adapter = createAcpV1Adapter({
      id: "acp-pending-connect",
      session: () => ({ cwd: "/tmp/acp-pending-connect" }),
      connect() {
        connectStarted();
        return pendingConnection;
      },
    });
    const runtime = createHarness({ adapters: [adapter], persistence: createMemoryPersistence() });
    const run = runtime.start(runRequest(adapter.id));
    const events = collect(run.events);
    await started;
    await run.cancel();
    expect(await run.done).toBe("interrupted");

    const input = new TransformStream<Uint8Array>();
    const output = new TransformStream<Uint8Array>();
    resolveConnection({
      readable: input.readable,
      writable: output.writable,
      close() { closes += 1; },
    });
    await Bun.sleep(0);
    expect(closes).toBe(1);
    expect((await events).at(-1)?.payload).toMatchObject({ kind: "turn-completed", status: "interrupted" });
    await runtime.close();
  });

  test("retires a cancelled transport before a replacement can receive late updates", async () => {
    const state = fakeState();
    let prompts = 0;
    let cancelled!: () => void;
    const cancellation = new Promise<void>((resolve) => { cancelled = resolve; });
    let firstPromptStarted!: () => void;
    const firstPrompt = new Promise<void>((resolve) => { firstPromptStarted = resolve; });
    const adapter = createAcpV1Adapter({
      id: "acp-replacement-isolation",
      cancelTimeoutMs: 100,
      session: () => ({ cwd: "/tmp/acp-replacement-isolation" }),
      connect() {
        const agent = acp.agent({ name: "replacement-isolation" })
          .onRequest(acp.methods.agent.initialize, () => ({
            protocolVersion: 1,
            agentCapabilities: { loadSession: true },
          }))
          .onRequest(acp.methods.agent.session.new, () => ({ sessionId: "shared-session" }))
          .onRequest(acp.methods.agent.session.load, () => ({}))
          .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
            prompts += 1;
            if (prompts === 1) {
              firstPromptStarted();
              await client.notify(acp.methods.client.session.update, {
                sessionId: params.sessionId,
                update: {
                  sessionUpdate: "agent_message_chunk",
                  content: { type: "text", text: "waiting" },
                },
              });
              await cancellation;
              setTimeout(() => {
                void client.notify(acp.methods.client.session.update, {
                  sessionId: params.sessionId,
                  update: {
                    sessionUpdate: "agent_message_chunk",
                    content: { type: "text", text: "late-old-turn" },
                  },
                }).catch(() => undefined);
              }, 5);
              return { stopReason: "cancelled" };
            }
            await client.notify(acp.methods.client.session.update, {
              sessionId: params.sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "replacement" },
              },
            });
            await Bun.sleep(20);
            return { stopReason: "end_turn" };
          })
          .onNotification(acp.methods.agent.session.cancel, () => {
            state.cancellations += 1;
            cancelled();
          });
        return byteConnection(agent, state);
      },
    });
    const runtime = createHarness({ adapters: [adapter], persistence: createMemoryPersistence() });
    const run = runtime.start(runRequest(adapter.id), { turnId: "old-turn" });
    const oldEvents = collect(run.events);
    await firstPrompt;

    const result = await run.followUp({
      expectedTurnId: "old-turn",
      input: [{ type: "text", text: "replace" }],
    });
    const replacementEvents = await collect(result.run.events);

    expect(result.strategy).toBe("replacement-turn");
    expect(await run.done).toBe("interrupted");
    expect(await result.run.done).toBe("completed");
    expect(state.cancellations).toBe(1);
    expect(state.closes).toBeGreaterThanOrEqual(1);
    expect(replacementEvents.some((event) => event.payload.kind === "assistant-text"
      && event.payload.text === "replacement")).toBe(true);
    expect(JSON.stringify(replacementEvents)).not.toContain("late-old-turn");
    await oldEvents;
    await runtime.close();
  });

  test("closes promptly while its host connection is still pending", async () => {
    let connectStarted!: () => void;
    const started = new Promise<void>((resolve) => { connectStarted = resolve; });
    let resolveConnection!: (connection: AcpV1ByteConnection) => void;
    const pendingConnection = new Promise<AcpV1ByteConnection>((resolve) => { resolveConnection = resolve; });
    let closes = 0;
    const adapter = createAcpV1Adapter({
      id: "acp-close-pending-connect",
      session: () => ({ cwd: "/tmp/acp-close-pending-connect" }),
      connect() {
        connectStarted();
        return pendingConnection;
      },
    });
    const runtime = createHarness({ adapters: [adapter], persistence: createMemoryPersistence() });
    const run = runtime.start(runRequest(adapter.id));
    const events = collect(run.events);
    await started;

    const closeResult = await Promise.race([
      runtime.close().then(() => "closed" as const),
      Bun.sleep(100).then(() => "timed-out" as const),
    ]);
    expect(closeResult).toBe("closed");
    expect(await run.done).toBe("interrupted");

    const input = new TransformStream<Uint8Array>();
    const output = new TransformStream<Uint8Array>();
    resolveConnection({
      readable: input.readable,
      writable: output.writable,
      close() { closes += 1; },
    });
    await Bun.sleep(0);
    expect(closes).toBe(1);
    expect((await events).at(-1)?.payload).toMatchObject({ kind: "turn-completed", status: "interrupted" });
  });

  test("does not allow a permission resolver to select after cancellation", async () => {
    const state = fakeState();
    let resolverStarted!: () => void;
    const resolving = new Promise<void>((resolve) => { resolverStarted = resolve; });
    let releaseResolver!: () => void;
    const held = new Promise<void>((resolve) => { releaseResolver = resolve; });
    const outcomes: acp.RequestPermissionResponse[] = [];
    const agent = basicAgent(state, {
      async onPrompt({ params, client }) {
        const outcome = await client.request(acp.methods.client.session.requestPermission, {
          sessionId: params.sessionId,
          toolCall: { toolCallId: "late", title: "Late permission" },
          options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
        });
        outcomes.push(outcome);
        return { stopReason: outcome.outcome.outcome === "cancelled" ? "cancelled" : "end_turn" };
      },
    });
    const adapter = createAcpV1Adapter({
      id: "acp-permission-race",
      session: () => ({ cwd: "/tmp/acp-permission-race" }),
      connect: () => byteConnection(agent, state),
      authorizePermission: (request) => ({
        behavior: "ask",
        interaction: {
          id: "permission-race",
          kind: "permission",
          title: request.tool.title ?? "Permission",
          choices: [{ id: "allow", label: "Allow", allow: true }],
        },
        async resolve() {
          resolverStarted();
          await held;
          return { behavior: "select", optionId: "allow" };
        },
      }),
    });
    const runtime = createHarness({ adapters: [adapter], persistence: createMemoryPersistence() });
    const run = runtime.start(runRequest(adapter.id));
    const iterator = run.events[Symbol.asyncIterator]();
    await iterator.next();
    const asked = await iterator.next();
    if (asked.value?.payload.kind !== "interaction-requested") throw new Error("permission missing");
    const response = run.respond(asked.value.payload.interaction.id, { choiceId: "allow" });
    await resolving;
    const cancellation = run.cancel();
    releaseResolver();
    await expect(response).rejects.toMatchObject({ code: "INTERACTION_NOT_ACTIVE" });
    await cancellation;
    const tail: HarnessEvent[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      tail.push(next.value);
    }
    expect(await run.done).toBe("interrupted");
    expect(outcomes).toEqual([{ outcome: { outcome: "cancelled" } }]);
    const invalidated = tail.filter((event) => event.payload.kind === "interaction-invalidated");
    expect(invalidated).toHaveLength(1);
    expect(invalidated[0]?.payload).toEqual({
      kind: "interaction-invalidated",
      interactionId: "permission-race",
      reason: "turn-ended",
    });
    await runtime.close();
  });

  test("cancels a permission request that arrives after the prompt has settled", async () => {
    const state = fakeState();
    let resolveLate!: (value: acp.RequestPermissionResponse) => void;
    const late = new Promise<acp.RequestPermissionResponse>((resolve) => { resolveLate = resolve; });
    const agent = basicAgent(state, {
      onPrompt({ params, client }) {
        setTimeout(() => {
          void client.request(acp.methods.client.session.requestPermission, {
            sessionId: params.sessionId,
            toolCall: { toolCallId: "late", title: "Too late" },
            options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
          }).then(resolveLate);
        }, 0);
        return { stopReason: "end_turn" };
      },
    });
    const adapter = createAcpV1Adapter({
      id: "acp-late-permission",
      session: () => ({ cwd: "/tmp/acp-late-permission" }),
      connect: () => byteConnection(agent, state),
    });
    const runtime = createHarness({ adapters: [adapter], persistence: createMemoryPersistence() });
    const result = await finish(runtime, runRequest(adapter.id));
    expect(result.status).toBe("completed");
    expect(result.events.some((event) => event.payload.kind === "interaction-requested")).toBe(false);
    expect(await late).toEqual({ outcome: { outcome: "cancelled" } });
    await runtime.close();
  });

  test("closes orphaned tools and bounds provider-authored display content", async () => {
    const state = fakeState();
    const agent = basicAgent(state, {
      async onPrompt({ params, client }) {
        const notify = (update: acp.SessionUpdate) => client.notify(acp.methods.client.session.update, {
          sessionId: params.sessionId,
          update,
        });
        await notify({
          sessionUpdate: "tool_call",
          toolCallId: "orphan",
          title: "Still running",
          status: "in_progress",
        });
        await notify({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "a".repeat(150) },
        });
        await notify({
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "b".repeat(50) },
        });
        await notify({
          sessionUpdate: "plan",
          entries: [
            { content: "c".repeat(100), priority: "high", status: "in_progress" },
            { content: "not retained", priority: "low", status: "pending" },
          ],
        });
        return { stopReason: "end_turn" };
      },
    });
    const adapter = createAcpV1Adapter({
      id: "acp-bounds",
      eventTextLimit: 64,
      turnTextLimit: 100,
      planEntryLimit: 1,
      session: () => ({ cwd: "/tmp/acp-bounds" }),
      connect: () => byteConnection(agent, state),
    });
    const runtime = createHarness({ adapters: [adapter], persistence: createMemoryPersistence() });
    const result = await finish(runtime, runRequest(adapter.id));
    expect(result.status).toBe("completed");
    const assistant = result.events.flatMap((event) => event.payload.kind === "assistant-text" ? [event.payload.text] : []);
    expect(assistant.reduce((total, value) => total + value.length, 0)).toBe(100);
    expect(Math.max(...assistant.map((value) => value.length))).toBeLessThanOrEqual(64);
    expect(result.events.some((event) => event.payload.kind === "thinking")).toBe(false);
    expect(result.events.filter((event) => event.payload.kind === "extension" && event.payload.name === "content-truncated")).toHaveLength(3);
    expect(result.events.find((event) => event.payload.kind === "plan-updated")?.payload).toMatchObject({
      kind: "plan-updated",
      steps: [{ status: "in_progress" }],
    });
    const completed = result.events.find((event) => event.payload.kind === "tool-completed")?.payload;
    expect(completed).toMatchObject({ kind: "tool-completed", toolId: "orphan", status: "failed" });
    await runtime.close();
  });

  test("keeps tool presentation extensions JSON-safe and bounded", async () => {
    const state = fakeState();
    const secret = "oversized-extension-secret";
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const agent = basicAgent(state, {
      async onPrompt({ params, client }) {
        const notify = (update: acp.SessionUpdate) => client.notify(acp.methods.client.session.update, {
          sessionId: params.sessionId,
          update,
        });
        await notify({
          sessionUpdate: "tool_call",
          toolCallId: "bounded-tool",
          title: "Bound extensions",
          status: "in_progress",
        });
        await notify({
          sessionUpdate: "tool_call_update",
          toolCallId: "bounded-tool",
          status: "in_progress",
        });
        await notify({
          sessionUpdate: "tool_call_update",
          toolCallId: "bounded-tool",
          status: "completed",
        });
        return { stopReason: "end_turn" };
      },
    });
    const adapter = createAcpV1Adapter({
      id: "acp-extension-bounds",
      eventTextLimit: 64,
      session: () => ({ cwd: "/tmp/acp-extension-bounds" }),
      connect: () => byteConnection(agent, state),
      presentTool(snapshot) {
        if (snapshot.phase === "start") return { extensions: { "example:safe": true } };
        if (snapshot.phase === "update") return { extensions: cyclic };
        return { extensions: { "example:unsafe": secret.repeat(10) } };
      },
    });
    const runtime = createHarness({ adapters: [adapter], persistence: createMemoryPersistence() });
    const result = await finish(runtime, runRequest(adapter.id));
    expect(result.status).toBe("completed");
    const toolEvents = result.events.filter((event) => event.payload.kind.startsWith("tool-"));
    expect(toolEvents[0]?.payload).toMatchObject({ extensions: { "example:safe": true } });
    expect(toolEvents[1]?.payload).toMatchObject({ truncated: true });
    expect(toolEvents[2]?.payload).toMatchObject({ truncated: true });
    expect(toolEvents[1]?.payload.extensions).toBeUndefined();
    expect(toolEvents[2]?.payload.extensions).toBeUndefined();
    expect(JSON.stringify(result.events)).not.toContain(secret);
    await runtime.close();
  });

  test("reconnects with session/load after an ACP process exits between turns", async () => {
    const state = fakeState();
    let connectionCount = 0;
    const adapter = createAcpV1Adapter({
      id: "acp-reconnect",
      session: () => ({ cwd: "/tmp/acp-reconnect" }),
      connect() {
        connectionCount += 1;
        let peer: acp.AgentConnection | undefined;
        const agent = acp.agent()
          .onConnect((value) => { peer = value; })
          .onRequest(acp.methods.agent.initialize, () => ({
            protocolVersion: 1,
            agentCapabilities: { loadSession: true },
          }))
          .onRequest(acp.methods.agent.session.new, ({ params }) => {
            state.sessions.push(params);
            return { sessionId: "reconnect-session" };
          })
          .onRequest(acp.methods.agent.session.load, ({ params }) => {
            state.sessions.push(params);
            return {};
          })
          .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
            await client.notify(acp.methods.client.session.update, {
              sessionId: params.sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: `connection-${connectionCount}` },
              },
            });
            setTimeout(() => peer?.close(), 0);
            return { stopReason: "end_turn" };
          });
        return byteConnection(agent, state);
      },
    });
    const runtime = createHarness({ adapters: [adapter], persistence: createMemoryPersistence() });
    const first = await finish(runtime, runRequest(adapter.id));
    expect(first.status).toBe("completed");
    await Bun.sleep(5);
    const second = await finish(runtime, runRequest(adapter.id));
    expect(second.status).toBe("completed");
    expect(connectionCount).toBe(2);
    expect(state.sessions).toEqual([
      { cwd: "/tmp/acp-reconnect", mcpServers: [] },
      { cwd: "/tmp/acp-reconnect", mcpServers: [], sessionId: "reconnect-session" },
    ]);
    expect(second.events.some((event) => event.payload.kind === "assistant-text" && event.payload.text === "connection-2")).toBe(true);
    await runtime.close();
  });

  test("requires explicit context mapping, negotiated images, and absolute host paths", async () => {
    const contextState = fakeState();
    const contextAdapter = createAcpV1Adapter({
      id: "acp-context",
      session: () => ({ cwd: "/tmp/acp-context" }),
      connect: () => byteConnection(basicAgent(contextState), contextState),
    });
    const contextRuntime = createHarness({
      adapters: [contextAdapter],
      persistence: createMemoryPersistence(),
      contextSources: [{
        id: "trusted",
        failureMode: "required",
        prepare: () => ({ instructions: "trusted instruction", content: [{ type: "text", text: "untrusted" }] }),
      }],
    });
    const contextResult = await finish(contextRuntime, runRequest(contextAdapter.id));
    expect(contextResult.status).toBe("error");
    expect(contextResult.events.find((event) => event.payload.kind === "error")?.payload).toMatchObject({
      code: "ACP_CONTEXT_MAPPING_REQUIRED",
    });
    expect(contextState.prompts).toHaveLength(0);
    await contextRuntime.close();

    const inlineState = fakeState();
    const inlineAdapter = createAcpV1Adapter({
      id: "acp-inline-context",
      session: () => ({ cwd: "/tmp/acp-inline-context" }),
      connect: () => byteConnection(basicAgent(inlineState), inlineState),
    });
    const inlineRuntime = createHarness({ adapters: [inlineAdapter], persistence: createMemoryPersistence() });
    const inlineResult = await finish(inlineRuntime, runRequest(inlineAdapter.id, {
      input: [{ type: "context-reference", contextId: "note-1" }],
      inlineContext: {
        version: 1,
        records: [{
          version: 1,
          id: "note-1",
          kind: "note",
          label: "Launch",
          payload: { ready: true },
        }],
      },
    }));
    expect(inlineResult.status).toBe("completed");
    expect(inlineState.prompts[0]).toMatchObject({
      prompt: [{ type: "text", text: "[note: Launch]\n{\"ready\":true}" }],
    });
    await inlineRuntime.close();

    const pathState = fakeState();
    const pathAdapter = createAcpV1Adapter({
      id: "acp-path",
      session: () => ({ cwd: "relative/path" }),
      connect: () => byteConnection(basicAgent(pathState), pathState),
    });
    const pathRuntime = createHarness({ adapters: [pathAdapter], persistence: createMemoryPersistence() });
    const pathResult = await finish(pathRuntime, runRequest(pathAdapter.id));
    expect(pathResult.status).toBe("error");
    expect(pathState.initialize).toHaveLength(0);
    await pathRuntime.close();

    const imageState = fakeState();
    const noImageAgent = acp.agent()
      .onRequest(acp.methods.agent.initialize, () => ({ protocolVersion: 1, agentCapabilities: {} }))
      .onRequest(acp.methods.agent.session.new, () => ({ sessionId: "no-image" }))
      .onRequest(acp.methods.agent.session.prompt, ({ params }) => {
        imageState.prompts.push(params);
        return { stopReason: "end_turn" };
      });
    const imageAdapter = createAcpV1Adapter({
      id: "acp-image",
      session: () => ({ cwd: "/tmp/acp-image" }),
      connect: () => byteConnection(noImageAgent, imageState),
    });
    const imageRuntime = createHarness({ adapters: [imageAdapter], persistence: createMemoryPersistence() });
    const imageResult = await finish(imageRuntime, runRequest(imageAdapter.id, {
      input: [{ type: "image", mediaType: "image/png", data: new Uint8Array([1, 2, 3]) }],
    }));
    expect(imageResult.status).toBe("error");
    expect(imageResult.events.find((event) => event.payload.kind === "error")?.payload).toMatchObject({
      code: "ACP_IMAGE_UNSUPPORTED",
    });
    expect(imageState.prompts).toHaveLength(0);
    await imageRuntime.close();
  });

  test("exposes ACP controls without inferring model, effort, permission, or Fast semantics", async () => {
    const state = fakeState();
    const applied: Array<{ id: string; value: string | boolean }> = [];
    const agent = acp.agent()
      .onRequest(acp.methods.agent.initialize, () => ({ protocolVersion: 1, agentCapabilities: {} }))
      .onRequest(acp.methods.agent.session.new, () => ({
        sessionId: "configured",
        configOptions: [
          {
            type: "select",
            id: "model",
            name: "Model",
            category: "model",
            currentValue: "slow",
            options: [{ value: "slow", name: "Slow" }, { value: "fast", name: "Fast" }],
          },
          { type: "boolean", id: "vendor:fast", name: "Fast", currentValue: false },
        ],
      }))
      .onRequest(acp.methods.agent.session.setConfigOption, ({ params }) => {
        applied.push({ id: params.configId, value: params.value });
        return {
          configOptions: [
            {
              type: "select",
              id: "model",
              name: "Model",
              category: "model",
              currentValue: params.configId === "model" && typeof params.value === "string" ? params.value : "fast",
              options: [{ value: "slow", name: "Slow" }, { value: "fast", name: "Fast" }],
            },
            {
              type: "boolean",
              id: "vendor:fast",
              name: "Fast",
              currentValue: params.configId === "vendor:fast" && typeof params.value === "boolean" ? params.value : false,
            },
          ],
        };
      })
      .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
        state.prompts.push(params);
        await client.notify(acp.methods.client.session.update, {
          sessionId: params.sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "configured" } },
        });
        return { stopReason: "end_turn" };
      });
    const adapter = createAcpV1Adapter({
      id: "acp-config",
      profile: {
        status: "available",
        value: {
          id: "acp-config",
          label: "Configured agent",
          permissions: {
            kind: "host-policy",
            modes: [{ id: "host", label: "Host", posture: "restricted" }],
            defaultModeId: "host",
            selectable: false,
          },
          controls: [{ id: "vendor:fast", label: "Fast", kind: "toggle", scope: "turn", defaultValue: false }],
        },
      },
      models: {
        status: "available",
        value: { models: [{ id: "fast", label: "Fast model" }] },
      },
      session: () => ({ cwd: "/tmp/acp-config" }),
      connect: () => byteConnection(agent, state),
      async configureSession(controller, request) {
        const exposed = controller.configOptions;
        const model = exposed.find((option) => option.category === "model");
        const modelId = model?.id;
        if (exposed[0]) (exposed[0] as { id: string }).id = "mutated-copy";
        if (modelId && request.model) await controller.setConfigOption(modelId, request.model);
        if (request.settings?.controls?.["vendor:fast"] === true
          && controller.configOptions.some((option) => option.id === "vendor:fast")) {
          await controller.setConfigOption("vendor:fast", true);
        }
      },
    });
    const runtime = createHarness({ adapters: [adapter], persistence: createMemoryPersistence() });
    expect(await runtime.capabilities(adapter.id)).toMatchObject({
      steering: {
        support: "stable",
        strategies: ["replacement-turn"],
        constraints: { requiresAgentCapability: "loadSession" },
      },
    });
    expect(await runtime.profile(adapter.id)).toMatchObject({ status: "available", value: { id: "acp-config" } });
    expect(await runtime.models(adapter.id)).toMatchObject({ status: "available", value: { models: [{ id: "fast" }] } });
    expect(await runtime.limits(adapter.id)).toEqual({ status: "unsupported" });
    const result = await finish(runtime, runRequest(adapter.id, {
      model: "fast",
      settings: { controls: { "vendor:fast": true } },
    }));
    expect(result.status).toBe("completed");
    expect(applied).toEqual([{ id: "model", value: "fast" }, { id: "vendor:fast", value: true }]);
    await runtime.close();
  });

  test("redacts transport errors by default and accepts only explicit safe mappings", async () => {
    const secret = "provider-secret-body";
    const unsafe = createAcpV1Adapter({
      id: "acp-unsafe",
      session: () => ({ cwd: "/tmp/acp-unsafe" }),
      connect: () => { throw new Error(secret); },
    });
    const unsafeRuntime = createHarness({ adapters: [unsafe], persistence: createMemoryPersistence() });
    const unsafeResult = await finish(unsafeRuntime, runRequest(unsafe.id));
    expect(unsafeResult.status).toBe("error");
    expect(JSON.stringify(unsafeResult.events)).not.toContain(secret);
    expect(unsafeResult.events.find((event) => event.payload.kind === "error")?.payload).toEqual({
      kind: "error",
      code: "ADAPTER_ERROR",
      message: "The adapter turn failed.",
    });
    await unsafeRuntime.close();

    const safe = createAcpV1Adapter({
      id: "acp-safe",
      session: () => ({ cwd: "/tmp/acp-safe" }),
      connect: () => { throw new Error(secret); },
      publicError: () => ({ code: "ACP_UNAVAILABLE", message: "The ACP agent is unavailable.", retryable: true }),
    });
    const safeRuntime = createHarness({ adapters: [safe], persistence: createMemoryPersistence() });
    const safeResult = await finish(safeRuntime, runRequest(safe.id));
    expect(safeResult.events.find((event) => event.payload.kind === "error")?.payload).toEqual({
      kind: "error",
      code: "ACP_UNAVAILABLE",
      message: "The ACP agent is unavailable.",
      retryable: true,
    });
    await safeRuntime.close();
  });

  test("refuses protocol upgrades until a compatible adapter is shipped", async () => {
    const state = fakeState();
    const adapter = createAcpV1Adapter({
      id: "acp-version",
      session: () => ({ cwd: "/tmp/acp-version" }),
      connect: () => byteConnection(basicAgent(state, { protocolVersion: 2 }), state),
    });
    const runtime = createHarness({ adapters: [adapter], persistence: createMemoryPersistence() });
    const result = await finish(runtime, runRequest(adapter.id));
    expect(result.status).toBe("error");
    expect(result.events.find((event) => event.payload.kind === "error")?.payload).toMatchObject({
      code: "ACP_PROTOCOL_VERSION_UNSUPPORTED",
    });
    expect(state.sessions).toHaveLength(0);
    await runtime.close();
  });

  test("refuses optional workspace and MCP transports the agent did not negotiate", async () => {
    const rootsState = fakeState();
    const acceptedNegotiations: unknown[] = [];
    const rootsAdapter = createAcpV1Adapter({
      id: "acp-roots",
      session: () => ({ cwd: "/tmp/acp-roots", additionalDirectories: ["/tmp/extra"] }),
      connect: () => byteConnection(basicAgent(rootsState), rootsState),
      onNegotiated(value) { acceptedNegotiations.push(value); },
    });
    const rootsRuntime = createHarness({ adapters: [rootsAdapter], persistence: createMemoryPersistence() });
    const roots = await finish(rootsRuntime, runRequest(rootsAdapter.id));
    expect(roots.status).toBe("error");
    expect(roots.events.find((event) => event.payload.kind === "error")?.payload).toMatchObject({
      code: "ACP_ADDITIONAL_DIRECTORIES_UNSUPPORTED",
    });
    expect(rootsState.sessions).toHaveLength(0);
    expect(acceptedNegotiations).toHaveLength(0);
    await rootsRuntime.close();

    const mcpState = fakeState();
    const mcpAdapter = createAcpV1Adapter({
      id: "acp-http-mcp",
      session: () => ({
        cwd: "/tmp/acp-http-mcp",
        mcpServers: [{ type: "http", name: "tools", url: "https://example.test/mcp" }],
      }),
      connect: () => byteConnection(basicAgent(mcpState), mcpState),
    });
    const mcpRuntime = createHarness({ adapters: [mcpAdapter], persistence: createMemoryPersistence() });
    const mcp = await finish(mcpRuntime, runRequest(mcpAdapter.id));
    expect(mcp.status).toBe("error");
    expect(mcp.events.find((event) => event.payload.kind === "error")?.payload).toMatchObject({
      code: "ACP_MCP_UNSUPPORTED",
    });
    expect(mcpState.sessions).toHaveLength(0);
    await mcpRuntime.close();
  });
});
