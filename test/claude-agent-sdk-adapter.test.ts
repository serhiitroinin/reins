import { describe, expect, test } from "bun:test";
import {
  createClaudeAgentSdkAdapter,
  type ClaudeAgentSdkConnectRequest,
  type ClaudeAgentSdkConnection,
} from "../src/adapters/claude-agent-sdk-adapter.ts";
import {
  createHarness,
  type HarnessAdapterRunRequest,
} from "../src/runtime.ts";
import { createMemoryPersistence } from "../src/stores.ts";
import { createPushableAsyncIterable } from "../src/transports/async-iterable.ts";
import {
  createClaudeAgentSdkConformanceFixture,
  runAdapterConformance,
} from "../src/testing/index.ts";

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of stream) values.push(value);
  return values;
}

function scriptedConnection(
  onSend: (request: ClaudeAgentSdkConnectRequest, input: unknown, messages: ReturnType<typeof createPushableAsyncIterable<unknown>>) => void,
  request: ClaudeAgentSdkConnectRequest,
  state: { interrupts: number; closes: number; stops: string[] },
): ClaudeAgentSdkConnection {
  const messages = createPushableAsyncIterable<unknown>();
  let closed = false;
  return {
    messages,
    send(input) {
      onSend(request, input, messages);
    },
    interrupt() {
      state.interrupts += 1;
    },
    stopSubagent(taskId) {
      state.stops.push(taskId);
    },
    close() {
      if (closed) return;
      closed = true;
      state.closes += 1;
      messages.close();
    },
  };
}

function adapterRequest(
  threadId: string,
  turnId: string,
  overrides: Partial<HarnessAdapterRunRequest> = {},
): HarnessAdapterRunRequest {
  return {
    session: { tenantId: "tenant", actorId: "actor", threadId },
    adapterId: "claude",
    input: [{ type: "text", text: turnId }],
    runId: `run-${turnId}`,
    turnId,
    signal: new AbortController().signal,
    tools: { list: () => [], call: async () => ({ content: [] }) },
    context: { sources: [], unavailable: [] },
    ...overrides,
  };
}

describe("Claude Agent SDK adapter", () => {
  test("passes the provider-neutral adapter contract through the real adapter", async () => {
    const fixture = createClaudeAgentSdkConformanceFixture();
    const report = await runAdapterConformance({ fixture });

    expect(report.passed).toBe(true);
    expect(report.cases.filter((entry) => entry.status === "failed")).toEqual([]);
    expect(fixture.state.interruptions).toBe(1);
    expect(fixture.state.closes).toBeGreaterThan(0);
    expect(fixture.state.toolDecisions).toEqual([{ behavior: "allow", updatedInput: {} }]);
    expect(fixture.state.resumeTokens).toContain("conformance-resume-token");
  });

  test("passes explicit first-turn settings and preserves input context", async () => {
    const requests: ClaudeAgentSdkConnectRequest[] = [];
    const state = { interrupts: 0, closes: 0, stops: [] as string[] };
    const adapter = createClaudeAgentSdkAdapter({
      connect(request) {
        requests.push(request);
        return scriptedConnection((_request, input, messages) => {
          expect(input).toMatchObject({
            input: [{ type: "text", text: "hello" }],
            configuration: { "anthropic:command": false },
          });
          expect(JSON.stringify(input)).not.toContain("application-only-state");
          messages.push({ type: "assistant", message: { content: [{ type: "text", text: "done" }] } });
          messages.push({ type: "result", subtype: "success", is_error: false });
        }, request, state);
      },
    });
    const runtime = createHarness({
      adapters: [adapter],
      persistence: createMemoryPersistence(),
      contextSources: [{
        id: "test:context",
        failureMode: "required",
        prepare: () => ({
          instructions: "Host instruction",
          content: [{ type: "text", text: "untrusted" }],
          state: "application-only-state",
        }),
      }],
    });
    const run = runtime.start({
      session: { tenantId: "tenant", actorId: "actor", threadId: "thread" },
      adapterId: adapter.id,
      input: [{ type: "text", text: "hello" }],
      model: "claude-model",
      effort: "high",
      accountId: "account",
      settings: { permission: { modeId: "default" } },
      configuration: { "anthropic:command": false },
    });

    const events = await collect(run.events);
    expect(await run.done).toBe("completed");
    expect(events.some((event) => event.payload.kind === "assistant-text" && event.payload.text === "done")).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      resumeToken: null,
      model: "claude-model",
      effort: "high",
      accountId: "account",
      settings: { permission: { modeId: "default" } },
      configuration: { "anthropic:command": false },
    });
    expect(requests[0]?.signal.aborted).toBe(false);
    await runtime.close();
    expect(requests[0]?.signal.aborted).toBe(true);
    expect(state.closes).toBe(1);
  });

  test("injects a follow-up into the active stream without repeating prepared context", async () => {
    const sends: unknown[] = [];
    let firstAccepted = false;
    const adapter = createClaudeAgentSdkAdapter({
      connect(request) {
        return scriptedConnection((_request, input, messages) => {
          sends.push(input);
          if (sends.length === 1) {
            firstAccepted = true;
            messages.push({ type: "assistant", message: { content: [{ type: "text", text: "before" }] } });
            return;
          }
          messages.push({ type: "assistant", message: { content: [{ type: "text", text: "after" }] } });
          messages.push({ type: "result", subtype: "success", is_error: false });
        }, request, { interrupts: 0, closes: 0, stops: [] });
      },
    });
    const runtime = createHarness({
      adapters: [adapter],
      persistence: createMemoryPersistence(),
      contextSources: [{
        id: "test:workspace",
        failureMode: "required",
        prepare: () => ({ content: [{ type: "text", text: "untrusted workspace snapshot" }] }),
      }],
    });
    const run = runtime.start({
      session: { tenantId: "tenant", actorId: "actor", threadId: "steering" },
      adapterId: adapter.id,
      input: [{ type: "text", text: "first" }],
    }, { runId: "harness-run", turnId: "harness-turn" });
    const events = collect(run.events);
    while (!firstAccepted) await Bun.sleep(0);

    const result = await run.followUp({
      expectedTurnId: "harness-turn",
      input: [{ type: "text", text: "follow up" }],
    });

    expect(result).toEqual({ strategy: "same-turn", run });
    expect(sends).toHaveLength(2);
    expect(sends[0]).toMatchObject({
      runId: "harness-run",
      turnId: "harness-turn",
      input: [{ type: "text", text: "first" }],
      context: { sources: [{ sourceId: "test:workspace" }] },
    });
    expect(sends[1]).toEqual({
      runId: "harness-run",
      turnId: "harness-turn",
      input: [{ type: "text", text: "follow up" }],
      context: { sources: [], unavailable: [] },
    });
    expect(await run.done).toBe("completed");
    const payloads = (await events).map((event) => event.payload);
    expect(payloads.filter(({ kind }) => kind === "turn-started")).toHaveLength(1);
    expect(payloads.filter(({ kind }) => kind === "turn-completed")).toHaveLength(1);
    expect(payloads).toContainEqual({ kind: "assistant-text", text: "beforeafter" });
    await runtime.close();
  });

  test("awaits checkpoint persistence and exposes observed limits independently", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let reached!: () => void;
    const checkpointReached = new Promise<void>((resolve) => { reached = resolve; });
    const checkpoints: string[] = [];
    const adapter = createClaudeAgentSdkAdapter({
      connect(request) {
        return scriptedConnection((_request, _input, messages) => {
          messages.push({ type: "system", subtype: "init", session_id: "checkpoint-1" });
          messages.push({
            type: "rate_limit_event",
            rate_limit_info: { rateLimitType: "five_hour", utilization: 20 },
          });
          messages.push({ type: "result", subtype: "success", is_error: false });
        }, request, { interrupts: 0, closes: 0, stops: [] });
      },
      async onCheckpoint(checkpoint) {
        checkpoints.push(checkpoint);
        reached();
        await held;
      },
    });
    const runtime = createHarness({ adapters: [adapter], persistence: createMemoryPersistence() });
    const run = runtime.start({
      session: { tenantId: "tenant", actorId: "actor", threadId: "checkpoint" },
      adapterId: adapter.id,
      input: [{ type: "text", text: "hello" }],
    });
    const events = collect(run.events);

    await checkpointReached;
    expect(await Promise.race([run.done.then(() => "settled"), Bun.sleep(0).then(() => "pending")])).toBe("pending");
    release();
    await events;
    expect(await run.done).toBe("completed");
    expect(checkpoints).toEqual(["checkpoint-1"]);
    expect(await runtime.limits(adapter.id)).toEqual({
      status: "available",
      value: {
        limits: [{
          id: "five_hour",
          label: "5-hour",
          kind: "rate",
          scope: "account",
          unit: "%",
          usedPercent: 20,
          windowDurationMs: 18_000_000,
        }],
      },
    });
    await runtime.close();
  });

  test("cancels a pending connection and closes it if it arrives late", async () => {
    let started!: () => void;
    const connecting = new Promise<void>((resolve) => { started = resolve; });
    let resolveConnection!: (connection: ClaudeAgentSdkConnection) => void;
    const pending = new Promise<ClaudeAgentSdkConnection>((resolve) => { resolveConnection = resolve; });
    let closes = 0;
    const output = createPushableAsyncIterable<unknown>();
    const adapter = createClaudeAgentSdkAdapter({
      connect() {
        started();
        return pending;
      },
    });
    const runtime = createHarness({ adapters: [adapter], persistence: createMemoryPersistence() });
    const run = runtime.start({
      session: { tenantId: "tenant", actorId: "actor", threadId: "pending" },
      adapterId: adapter.id,
      input: [{ type: "text", text: "hello" }],
    });
    const events = collect(run.events);

    await connecting;
    await run.cancel();
    expect(await run.done).toBe("interrupted");
    resolveConnection({
      messages: output,
      send() {},
      interrupt() {},
      close() {
        closes += 1;
        output.close();
      },
    });
    await Bun.sleep(0);
    expect(closes).toBe(1);
    expect((await events).at(-1)?.payload).toMatchObject({ kind: "turn-completed", status: "interrupted" });
    await runtime.close();
  });

  test("closes a connection that arrives after the adapter session closes", async () => {
    let started!: () => void;
    const connecting = new Promise<void>((resolve) => { started = resolve; });
    let resolveConnection!: (connection: ClaudeAgentSdkConnection) => void;
    const pending = new Promise<ClaudeAgentSdkConnection>((resolve) => { resolveConnection = resolve; });
    const messages = createPushableAsyncIterable<unknown>();
    let sends = 0;
    let closes = 0;
    const adapter = createClaudeAgentSdkAdapter({
      connect() {
        started();
        return pending;
      },
    });
    const session = await adapter.open({
      session: { tenantId: "tenant", actorId: "actor", threadId: "close-pending" },
      resumeToken: null,
    });
    const turn = collect(session.run(adapterRequest("close-pending", "one"))).catch((error) => error);

    await connecting;
    await session.close();
    resolveConnection({
      messages,
      send() { sends += 1; },
      interrupt() {},
      close() {
        closes += 1;
        messages.close();
      },
    });
    await Bun.sleep(0);

    expect((await turn).name).toBe("HarnessAdapterInterruptedError");
    expect(sends).toBe(0);
    expect(closes).toBe(1);
  });

  test("a cancelled interaction cannot settle with a late allow decision", async () => {
    const messages = createPushableAsyncIterable<unknown>();
    const decisions: unknown[] = [];
    let resolveAuthorization!: () => void;
    const authorization = new Promise<void>((resolve) => { resolveAuthorization = resolve; });
    let resolving!: () => void;
    const resolverStarted = new Promise<void>((resolve) => { resolving = resolve; });
    const adapter = createClaudeAgentSdkAdapter({
      connect(request) {
        return {
          messages,
          send() {
            void request.canUseTool({ toolName: "Write", input: {}, toolUseId: "tool-1" })
              .then((decision) => decisions.push(decision));
          },
          interrupt() {
            messages.push({ type: "result", subtype: "interrupted", is_error: true });
          },
          close() { messages.close(); },
        };
      },
      authorizeTool: () => ({
        behavior: "ask",
        interaction: {
          id: "approval-1",
          kind: "approval",
          title: "Allow Write?",
          choices: [
            { id: "allow", label: "Allow", posture: "allow" },
            { id: "deny", label: "Deny", posture: "deny" },
          ],
        },
        async resolve() {
          resolving();
          await authorization;
          return { behavior: "allow" };
        },
      }),
    });
    const session = await adapter.open({
      session: { tenantId: "tenant", actorId: "actor", threadId: "interaction-race" },
      resumeToken: null,
    });
    const controller = new AbortController();
    const stream = session.run(adapterRequest("interaction-race", "one", { signal: controller.signal }));
    const iterator = stream[Symbol.asyncIterator]();
    expect(await iterator.next()).toMatchObject({
      value: { kind: "interaction-requested", interaction: { id: "approval-1" } },
    });
    const responding = session.respond("approval-1", { choiceId: "allow" });
    await resolverStarted;
    controller.abort();
    await session.cancel();
    resolveAuthorization();
    await expect(responding).rejects.toMatchObject({ code: "INTERACTION_NOT_ACTIVE" });
    expect(await iterator.next()).toMatchObject({
      value: { kind: "interaction-invalidated", interactionId: "approval-1", reason: "turn-ended" },
    });
    await expect(iterator.next()).rejects.toMatchObject({ name: "HarnessAdapterInterruptedError" });

    expect(decisions).toEqual([{
      behavior: "deny",
      message: "The turn ended before the interaction was answered.",
    }]);
    await session.close();
  });

  test("pins account and session settings to the provider connection", async () => {
    const messages = createPushableAsyncIterable<unknown>();
    let sends = 0;
    const limitAccounts: Array<string | undefined> = [];
    const adapter = createClaudeAgentSdkAdapter({
      connect: (request) => ({
        messages,
        send() {
          sends += 1;
          messages.push({
            type: "rate_limit_event",
            rate_limit_info: { rateLimitType: "five_hour", utilization: 20 },
          });
          messages.push({ type: "result", subtype: "success", is_error: false });
        },
        interrupt() {},
        close() { messages.close(); },
      }),
      onLimits: (_snapshot, request) => limitAccounts.push(request.accountId),
    });
    const session = await adapter.open({
      session: { tenantId: "tenant", actorId: "actor", threadId: "binding" },
      resumeToken: null,
    });
    await collect(session.run(adapterRequest("binding", "one", {
      accountId: "account-a",
      model: "claude-a",
      effort: "high",
      settings: { permission: { modeId: "managed" } },
      configuration: { endpoint: "one" },
    })));
    await expect(collect(session.run(adapterRequest("binding", "two", {
      accountId: "account-b",
      model: "claude-a",
      effort: "high",
      settings: { permission: { modeId: "managed" } },
      configuration: { endpoint: "one" },
    })))).rejects.toMatchObject({
      name: "HarnessAdapterError",
      code: "CLAUDE_SESSION_CONFIGURATION_CHANGED",
      message: "Claude session settings changed. Start a new harness session.",
    });

    expect(sends).toBe(1);
    expect(limitAccounts).toEqual(["account-a"]);
    expect(await adapter.limits?.({ accountId: "account-a" })).toMatchObject({ status: "available" });
    expect(await adapter.limits?.({ accountId: "account-b" })).toEqual({ status: "unsupported" });
    await session.close();
  });

  test("rejects every connection-scoped setting change by default", async () => {
    const base = {
      accountId: "account-a",
      model: "claude-a",
      effort: "high",
      settings: { permission: { modeId: "managed" } },
      configuration: { endpoint: "one" },
    } satisfies Partial<HarnessAdapterRunRequest>;
    const variants: Array<Partial<HarnessAdapterRunRequest>> = [
      { accountId: "account-b" },
      { model: "claude-b" },
      { effort: "low" },
      { settings: { permission: { modeId: "opened" } } },
      { configuration: { endpoint: "two" } },
    ];

    for (const [index, changed] of variants.entries()) {
      const messages = createPushableAsyncIterable<unknown>();
      const adapter = createClaudeAgentSdkAdapter({
        connect: () => ({
          messages,
          send() { messages.push({ type: "result", subtype: "success", is_error: false }); },
          interrupt() {},
          close() { messages.close(); },
        }),
      });
      const session = await adapter.open({
        session: { tenantId: "tenant", actorId: "actor", threadId: `identity-${index}` },
        resumeToken: null,
      });
      await collect(session.run(adapterRequest(`identity-${index}`, "one", base)));
      await expect(collect(session.run(adapterRequest(`identity-${index}`, "two", {
        ...base,
        ...changed,
      })))).rejects.toMatchObject({ code: "CLAUDE_SESSION_CONFIGURATION_CHANGED" });
      await session.close();
    }
  });

  test("lets hosts exclude turn-only configuration from connection identity", async () => {
    const messages = createPushableAsyncIterable<unknown>();
    let sends = 0;
    const adapter = createClaudeAgentSdkAdapter({
      connectionKey: (request) => ({ endpoint: request.configuration?.endpoint }),
      connect: () => ({
        messages,
        send() {
          sends += 1;
          messages.push({ type: "result", subtype: "success", is_error: false });
        },
        interrupt() {},
        close() { messages.close(); },
      }),
    });
    const session = await adapter.open({
      session: { tenantId: "tenant", actorId: "actor", threadId: "key" },
      resumeToken: null,
    });
    await collect(session.run(adapterRequest("key", "one", {
      accountId: "account-a",
      configuration: { endpoint: "same", command: false },
    })));
    await collect(session.run(adapterRequest("key", "two", {
      accountId: "account-a",
      configuration: { endpoint: "same", command: true },
    })));

    expect(sends).toBe(2);
    await session.close();
  });

  test("retires a provider stream when sending a turn fails", async () => {
    const messages = createPushableAsyncIterable<unknown>();
    let sends = 0;
    let closes = 0;
    let late!: () => void;
    const adapter = createClaudeAgentSdkAdapter({
      connect: () => ({
        messages,
        send() {
          sends += 1;
          late = () => {
            messages.push({ type: "assistant", message: { content: [{ type: "text", text: "late-from-first" }] } });
            messages.push({ type: "result", subtype: "success", is_error: false });
          };
          throw new Error("private send failure");
        },
        interrupt() {},
        close() {
          closes += 1;
          messages.close();
        },
      }),
    });
    const session = await adapter.open({
      session: { tenantId: "tenant", actorId: "actor", threadId: "send-failure" },
      resumeToken: null,
    });

    await expect(collect(session.run(adapterRequest("send-failure", "one")))).rejects.toThrow("private send failure");
    late();
    await expect(collect(session.run(adapterRequest("send-failure", "two")))).rejects.toThrow("private send failure");

    expect(sends).toBe(1);
    expect(closes).toBe(1);
    await session.close();
  });

  test("bounds an interrupt that the provider never finishes and retires its stream", async () => {
    const messages = createPushableAsyncIterable<unknown>();
    let closes = 0;
    const adapter = createClaudeAgentSdkAdapter({
      interruptTimeoutMs: 5,
      connect: () => ({
        messages,
        send() {
          messages.push({ type: "assistant", message: { content: [{ type: "text", text: "waiting" }] } });
        },
        interrupt() {},
        close() {
          closes += 1;
          messages.close();
        },
      }),
    });
    const runtime = createHarness({ adapters: [adapter], persistence: createMemoryPersistence() });
    const request = {
      session: { tenantId: "tenant", actorId: "actor", threadId: "stuck" },
      adapterId: adapter.id,
      input: [{ type: "text" as const, text: "wait" }],
    };
    const run = runtime.start(request);
    const iterator = run.events[Symbol.asyncIterator]();
    expect((await iterator.next()).value?.payload.kind).toBe("turn-started");
    await Bun.sleep(0);

    await run.cancel();
    expect(await run.done).toBe("interrupted");
    expect(closes).toBe(1);
    const next = runtime.start(request);
    await collect(next.events);
    expect(await next.done).toBe("error");
    await runtime.close();
  });

  test("reuses one provider stream across turns and exposes bounded subagent stop", async () => {
    const state = { interrupts: 0, closes: 0, stops: [] as string[] };
    let sends = 0;
    let finishSecond!: () => void;
    const adapter = createClaudeAgentSdkAdapter({
      connect(request) {
        return scriptedConnection((_request, _input, messages) => {
          sends += 1;
          messages.push({ type: "assistant", message: { content: [{ type: "text", text: `turn-${sends}` }] } });
          if (sends === 1) messages.push({ type: "result", subtype: "success", is_error: false });
          else finishSecond = () => messages.push({ type: "result", subtype: "success", is_error: false });
        }, request, state);
      },
    });
    const opened = await adapter.open({
      session: { tenantId: "tenant", actorId: "actor", threadId: "multi" },
      resumeToken: null,
    });
    const request = (turnId: string) => ({
      session: { tenantId: "tenant", actorId: "actor", threadId: "multi" },
      adapterId: adapter.id,
      input: [{ type: "text" as const, text: turnId }],
      runId: `run-${turnId}`,
      turnId,
      signal: new AbortController().signal,
      tools: { list: () => [], call: async () => ({ content: [] }) },
      context: { sources: [], unavailable: [] },
    });

    expect(await collect(opened.run(request("one")))).toEqual([{ kind: "assistant-text", text: "turn-1" }]);
    const second = opened.run(request("two"));
    const iterator = second[Symbol.asyncIterator]();
    const first = iterator.next();
    await Bun.sleep(0);
    expect(await opened.stopSubagent("agent-7")).toBe(true);
    finishSecond();
    expect(await first).toEqual({ done: false, value: { kind: "assistant-text", text: "turn-2" } });
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
    expect(sends).toBe(2);
    expect(state.stops).toEqual(["agent-7"]);
    await opened.close();
    expect(state.closes).toBe(1);
  });
});
