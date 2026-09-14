import { describe, expect, test } from "bun:test";
import {
  createHarness,
  createMemoryPersistence,
  HarnessRuntimeError,
  HarnessAdapterError,
  type HarnessAdapter,
  type HarnessAdapterRunRequest,
  type HarnessCapabilities,
  type HarnessEvent,
} from "../src/index.ts";

const unsupported = { support: "unsupported" as const };
const capabilities: HarnessCapabilities = {
  resume: { support: "stable" },
  cancel: { support: "stable" },
  interactions: unsupported,
  tools: unsupported,
  images: unsupported,
  thinking: { support: "stable" },
  plans: unsupported,
  usage: unsupported,
  subagents: unsupported,
  shell: unsupported,
  filesystem: unsupported,
  network: unsupported,
};

const request = {
  session: { tenantId: "tenant", actorId: "actor", threadId: "thread" },
  adapterId: "scripted",
  input: [{ type: "text" as const, text: "hello" }],
};

async function collect(stream: AsyncIterable<HarnessEvent>): Promise<HarnessEvent[]> {
  const events: HarnessEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("harness runtime", () => {
  test("discovers profiles, models, and limits independently", async () => {
    const adapter: HarnessAdapter = {
      id: "multi-provider",
      capabilities: () => capabilities,
      profile: () => ({
        status: "available",
        value: {
          id: "multi-provider",
          label: "OpenCode",
          permissions: {
            kind: "approval-policy",
            selectable: false,
            defaultModeId: "host",
            modes: [{ id: "host", label: "Managed by host", posture: "standard" }],
          },
        },
      }),
      models: ({ accountId }) => ({
        status: "available",
        value: {
          models: [{
            id: "xai/grok-4",
            label: "Grok 4",
            group: { id: "xai", label: "xAI" },
          }],
          ...(accountId ? { defaultModelId: "xai/grok-4" } : {}),
        },
      }),
      limits: () => ({ status: "unsupported" }),
      async open() { return { async *run() {} }; },
    };
    const harness = createHarness({ adapters: [adapter], persistence: createMemoryPersistence() });

    expect(await harness.profile("multi-provider")).toMatchObject({
      status: "available",
      value: { label: "OpenCode" },
    });
    expect(await harness.models("multi-provider", { accountId: "account" })).toMatchObject({
      status: "available",
      value: { defaultModelId: "xai/grok-4", models: [{ group: { id: "xai" } }] },
    });
    expect(await harness.limits("multi-provider")).toEqual({ status: "unsupported" });
  });

  test("returns safe discovery failures and unsupported optional methods", async () => {
    const adapter: HarnessAdapter = {
      id: "failing",
      capabilities: () => capabilities,
      models: () => { throw new Error("secret provider response"); },
      limits: () => { throw new HarnessAdapterError("SIGNED_OUT", "Sign in to continue.", true); },
      async open() { return { async *run() {} }; },
    };
    const harness = createHarness({ adapters: [adapter], persistence: createMemoryPersistence() });

    expect(await harness.profile("failing")).toEqual({ status: "unsupported" });
    expect(await harness.models("failing")).toEqual({
      status: "unavailable",
      message: "failing discovery failed.",
    });
    expect(await harness.limits("failing")).toEqual({
      status: "unavailable",
      message: "Sign in to continue.",
      retryable: true,
    });
  });

  test("frames adapter events and persists a resume token", async () => {
    const openedWith: Array<string | null> = [];
    const adapter: HarnessAdapter = {
      id: "scripted",
      capabilities: () => capabilities,
      async open({ resumeToken }) {
        openedWith.push(resumeToken);
        return {
          async *run() {
            yield { kind: "thinking", text: "checking" };
            yield { kind: "assistant-text", text: "done" };
          },
          checkpoint: () => "provider-session-1",
        };
      },
    };
    let id = 0;
    let tick = 0;
    const clock = () => new Date(1_800_000_000_000 + tick++);
    const persistence = createMemoryPersistence({ createId: () => `event-${++id}`, now: clock });
    const harness = createHarness({ adapters: [adapter], persistence, createId: () => `run-${++id}`, now: clock });

    const first = harness.start(request);
    const events = await collect(first.events);
    expect(await first.done).toBe("completed");
    expect(events.map((event) => event.payload.kind)).toEqual([
      "turn-started", "thinking", "assistant-text", "turn-completed",
    ]);
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4]);

    const second = harness.start(request);
    await collect(second.events);
    await second.done;
    expect(openedWith).toEqual([null]);
    expect((await persistence.events.list(request.session, "scripted")).map((event) => event.sequence))
      .toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  test("seals an aborted turn as interrupted", async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    let cancelled = false;
    const adapter: HarnessAdapter = {
      id: "scripted",
      capabilities: () => capabilities,
      async open() {
        return {
          async *run(_request: HarnessAdapterRunRequest) {
            yield { kind: "assistant-text", text: "started" };
            await waiting;
          },
          async cancel() { cancelled = true; release(); },
        };
      },
    };
    const harness = createHarness({ adapters: [adapter], persistence: createMemoryPersistence() });
    const run = harness.start(request);
    const eventsPromise = collect(run.events);
    await Bun.sleep(0);
    await run.cancel();
    const events = await eventsPromise;
    expect(cancelled).toBe(true);
    expect(await run.done).toBe("interrupted");
    expect(events.at(-1)?.payload).toMatchObject({ kind: "turn-completed", status: "interrupted" });
  });

  test("rejects unknown adapters before starting work", () => {
    const harness = createHarness({ adapters: [], persistence: createMemoryPersistence() });
    expect(() => harness.start({ ...request, adapterId: "missing" })).toThrow(HarnessRuntimeError);
  });

  test("does not persist an arbitrary adapter error message", async () => {
    const adapter: HarnessAdapter = {
      id: "scripted",
      capabilities: () => capabilities,
      async open() {
        return { async *run() { throw new Error("prompt bytes and credentials"); } };
      },
    };
    const harness = createHarness({ adapters: [adapter], persistence: createMemoryPersistence() });
    const run = harness.start(request);
    const events = await collect(run.events);
    expect(events.find((event) => event.payload.kind === "error")?.payload).toEqual({
      kind: "error",
      code: "ADAPTER_ERROR",
      message: "The adapter turn failed.",
    });
  });

  test("persists only an adapter error explicitly marked safe", async () => {
    const adapter: HarnessAdapter = {
      id: "scripted",
      capabilities: () => capabilities,
      async open() {
        return {
          async *run() {
            throw new HarnessAdapterError("ENGINE_UNAVAILABLE", "Codex is not installed.", true);
          },
        };
      },
    };
    const harness = createHarness({ adapters: [adapter], persistence: createMemoryPersistence() });
    const run = harness.start(request);
    const events = await collect(run.events);
    expect(events.find((event) => event.payload.kind === "error")?.payload).toMatchObject({
      code: "ENGINE_UNAVAILABLE",
      message: "Codex is not installed.",
      retryable: true,
    });
  });

  test("prepares turn context once and shares it with the adapter and tools", async () => {
    let adapterContext: HarnessAdapterRunRequest["context"] | undefined;
    let toolContext: HarnessAdapterRunRequest["context"] | undefined;
    const adapter: HarnessAdapter = {
      id: "scripted",
      capabilities: () => capabilities,
      async open() {
        return {
          async *run(runRequest) {
            adapterContext = runRequest.context;
            await runRequest.tools.call("inspect", {});
          },
        };
      },
    };
    const harness = createHarness({
      adapters: [adapter],
      persistence: createMemoryPersistence(),
      contextSources: [
        {
          id: "app:workspace",
          failureMode: "required",
          prepare: ({ turnId }) => ({
            instructions: "Use the workspace snapshot.",
            content: [{ type: "text", text: "untrusted workspace data" }],
            state: { turnId },
          }),
        },
        {
          id: "app:optional",
          failureMode: "optional",
          prepare: () => null,
        },
      ],
      tools: {
        list: () => [{ name: "inspect", description: "Inspect context", inputSchema: {} }],
        async call(_name, _input, context) {
          toolContext = context.context;
          return { content: [] };
        },
      },
    });

    const run = harness.start(request);
    await collect(run.events);
    expect(await run.done).toBe("completed");
    expect(toolContext).toBe(adapterContext);
    expect(adapterContext?.sources[0]).toMatchObject({
      sourceId: "app:workspace",
      value: { state: { turnId: run.turnId } },
    });
    expect(adapterContext?.unavailable).toEqual([{
      sourceId: "app:optional",
      code: "CONTEXT_SOURCE_UNAVAILABLE",
      message: "Context source \"app:optional\" is unavailable.",
    }]);
  });

  test("seals a missing required context source as a safe error", async () => {
    let adapterRan = false;
    const adapter: HarnessAdapter = {
      id: "scripted",
      capabilities: () => capabilities,
      async open() {
        return { async *run() { adapterRan = true; } };
      },
    };
    const harness = createHarness({
      adapters: [adapter],
      persistence: createMemoryPersistence(),
      contextSources: [{ id: "app:required", failureMode: "required", prepare: () => null }],
    });
    const run = harness.start(request);
    const events = await collect(run.events);
    expect(await run.done).toBe("error");
    expect(adapterRan).toBe(false);
    expect(events.find((event) => event.payload.kind === "error")?.payload).toEqual({
      kind: "error",
      code: "CONTEXT_SOURCE_UNAVAILABLE",
      message: "Context source \"app:required\" is unavailable.",
    });
  });

  test("closes the event iterator when persistence fails", async () => {
    const adapter: HarnessAdapter = {
      id: "scripted",
      capabilities: () => capabilities,
      async open() { return { async *run() {} }; },
    };
    const persistence = createMemoryPersistence();
    persistence.events.append = async () => { throw new Error("store unavailable"); };
    const harness = createHarness({ adapters: [adapter], persistence });
    const run = harness.start(request);
    expect(await collect(run.events)).toEqual([]);
    await expect(run.done).rejects.toThrow("store unavailable");
  });
});
