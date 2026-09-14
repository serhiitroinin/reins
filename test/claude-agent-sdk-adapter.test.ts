import { describe, expect, test } from "bun:test";
import {
  createClaudeAgentSdkAdapter,
  type ClaudeAgentSdkConnectRequest,
  type ClaudeAgentSdkConnection,
} from "../src/adapters/claude-agent-sdk-adapter.ts";
import { createHarness } from "../src/runtime.ts";
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
