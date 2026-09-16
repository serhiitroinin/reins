import { describe, expect, test } from "bun:test";
import {
  createHarness,
  createMemoryPersistence,
  HarnessRuntimeError,
  HarnessAdapterError,
  HarnessAdapterInterruptedError,
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

  test("invalidates an unanswered interaction before sealing its turn", async () => {
    const adapter: HarnessAdapter = {
      id: "scripted",
      capabilities: () => ({
        ...capabilities,
        interactions: { support: "stable", recovery: "live-only" },
      }),
      async open() {
        return {
          async *run() {
            yield {
              kind: "interaction-requested" as const,
              interaction: { id: "approval-1", kind: "permission", title: "Allow?" },
            };
          },
          async respond() {},
        };
      },
    };
    const harness = createHarness({ adapters: [adapter], persistence: createMemoryPersistence() });
    const run = harness.start(request);
    const events = await collect(run.events);

    expect(await run.done).toBe("completed");
    expect(events.map((entry) => entry.payload.kind)).toEqual([
      "turn-started",
      "interaction-requested",
      "interaction-invalidated",
      "turn-completed",
    ]);
    expect(events[2]?.payload).toEqual({
      kind: "interaction-invalidated",
      interactionId: "approval-1",
      reason: "turn-ended",
    });
    await expect(run.respond("approval-1", { choiceId: "allow" })).rejects.toMatchObject({
      code: "INTERACTION_NOT_ACTIVE",
    });
  });

  test("does not treat an adapter acknowledgement as durable resolution", async () => {
    let finish!: () => void;
    const waiting = new Promise<void>((resolve) => { finish = resolve; });
    const adapter: HarnessAdapter = {
      id: "scripted",
      capabilities: () => ({
        ...capabilities,
        interactions: { support: "stable", recovery: "live-only" },
      }),
      async open() {
        return {
          async *run() {
            yield {
              kind: "interaction-requested" as const,
              interaction: { id: "approval-1", kind: "permission", title: "Allow?" },
            };
            await waiting;
          },
          async respond() { finish(); },
        };
      },
    };
    const harness = createHarness({ adapters: [adapter], persistence: createMemoryPersistence() });
    const run = harness.start(request);
    const iterator = run.events[Symbol.asyncIterator]();
    expect((await iterator.next()).value?.payload.kind).toBe("turn-started");
    expect((await iterator.next()).value?.payload.kind).toBe("interaction-requested");

    await run.respond("approval-1", { choiceId: "allow" });
    const tail: HarnessEvent[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      tail.push(next.value);
    }

    expect(tail.map((entry) => entry.payload.kind)).toEqual([
      "interaction-invalidated",
      "turn-completed",
    ]);
  });

  test("durably invalidates an interaction the provider no longer recognizes", async () => {
    let finish!: () => void;
    const waiting = new Promise<void>((resolve) => { finish = resolve; });
    const persistence = createMemoryPersistence();
    const adapter: HarnessAdapter = {
      id: "scripted",
      capabilities: () => ({
        ...capabilities,
        interactions: { support: "stable", recovery: "live-only" },
      }),
      async open() {
        return {
          async *run() {
            yield {
              kind: "interaction-requested" as const,
              interaction: { id: "lost", kind: "permission", title: "Allow?" },
            };
            await waiting;
            yield { kind: "interaction-invalidated" as const, interactionId: "lost", reason: "turn-ended" };
          },
          async respond() {
            throw new HarnessAdapterError("INTERACTION_NOT_ACTIVE", "The provider lost this request.");
          },
          async cancel() { finish(); },
        };
      },
    };
    const harness = createHarness({ adapters: [adapter], persistence });
    const run = harness.start(request);
    const iterator = run.events[Symbol.asyncIterator]();
    expect((await iterator.next()).value?.payload.kind).toBe("turn-started");
    expect((await iterator.next()).value?.payload.kind).toBe("interaction-requested");

    await expect(run.respond("lost", { choiceId: "allow" })).rejects.toMatchObject({
      code: "INTERACTION_NOT_ACTIVE",
    });
    expect((await iterator.next()).value?.payload).toEqual({
      kind: "interaction-invalidated",
      interactionId: "lost",
      reason: "provider-lost-request",
    });
    expect((await persistence.events.list(request.session, "scripted"))
      .filter((entry) => entry.payload.kind === "interaction-invalidated")).toHaveLength(1);

    await run.cancel();
    const tail: HarnessEvent[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      tail.push(next.value);
    }
    expect(tail.filter((entry) => entry.payload.kind === "interaction-invalidated")).toEqual([]);
  });

  test("retains events an adapter yields while cancellation settles", async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const adapter: HarnessAdapter = {
      id: "scripted",
      capabilities: () => capabilities,
      async open() {
        return {
          async *run() {
            await waiting;
            yield { kind: "assistant-text", text: "partial" } as const;
            yield {
              kind: "tool-completed",
              toolId: "tool-1",
              toolKind: "shell",
              title: "Run command",
              status: "cancelled",
            } as const;
          },
          async cancel() { release(); },
        };
      },
    };
    const persistence = createMemoryPersistence();
    const harness = createHarness({ adapters: [adapter], persistence });
    const run = harness.start(request);
    const eventsPromise = collect(run.events);
    await Bun.sleep(0);

    await run.cancel();
    const events = await eventsPromise;

    expect(await run.done).toBe("interrupted");
    expect(events.map((event) => event.payload.kind)).toEqual([
      "turn-started",
      "assistant-text",
      "tool-completed",
      "turn-completed",
    ]);
    expect(events[1]?.payload).toEqual({ kind: "assistant-text", text: "partial" });
    expect(events[2]?.payload).toMatchObject({ kind: "tool-completed", status: "cancelled" });
    expect(events[3]?.payload).toMatchObject({ kind: "turn-completed", status: "interrupted" });
  });

  test("seals a provider-owned interruption without inventing an error", async () => {
    const adapter: HarnessAdapter = {
      id: "scripted",
      capabilities: () => capabilities,
      async open() {
        return {
          async *run() {
            yield { kind: "assistant-text", text: "partial" };
            throw new HarnessAdapterInterruptedError();
          },
        };
      },
    };
    const harness = createHarness({ adapters: [adapter], persistence: createMemoryPersistence() });
    const run = harness.start(request);
    const events = await collect(run.events);

    expect(await run.done).toBe("interrupted");
    expect(events.map((event) => event.payload.kind)).toEqual([
      "turn-started", "assistant-text", "turn-completed",
    ]);
    expect(events.at(-1)?.payload).toMatchObject({ kind: "turn-completed", status: "interrupted" });
  });

  test("preserves the safe runtime code when a session is already busy", async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const adapter: HarnessAdapter = {
      id: "scripted",
      capabilities: () => capabilities,
      async open() {
        return {
          async *run() { yield { kind: "assistant-text", text: "waiting" }; await waiting; },
          async cancel() { release(); },
        };
      },
    };
    const harness = createHarness({ adapters: [adapter], persistence: createMemoryPersistence() });
    const first = harness.start(request);
    const iterator = first.events[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.next();

    const second = harness.start(request);
    const events = await collect(second.events);
    expect(await second.done).toBe("error");
    expect(events.find((event) => event.payload.kind === "error")?.payload).toEqual({
      kind: "error",
      code: "SESSION_BUSY",
      message: "This harness session already has a running turn.",
    });

    await first.cancel();
  });

  test("rejects unknown adapters before starting work", () => {
    const harness = createHarness({ adapters: [], persistence: createMemoryPersistence() });
    expect(() => harness.start({ ...request, adapterId: "missing" })).toThrow(HarnessRuntimeError);
    expect(() => harness.start({
      ...request,
      adapterId: "missing",
      input: [{ type: "context-reference", contextId: "stale" }],
    })).toThrow("Unknown harness adapter");
  });

  test("rejects invalid inline context before opening a provider", () => {
    let opened = false;
    const adapter: HarnessAdapter = {
      id: "scripted",
      capabilities: () => capabilities,
      async open() {
        opened = true;
        return { async *run() {} };
      },
    };
    const harness = createHarness({ adapters: [adapter], persistence: createMemoryPersistence() });
    expect(() => harness.start({
      ...request,
      input: [{ type: "context-reference", contextId: "stale" }],
    })).toThrow("has no valid record");
    expect(opened).toBe(false);
  });

  test("enforces an admitted input policy before ids, events, or provider opening", async () => {
    let opened = 0;
    let ids = 0;
    let preparations = 0;
    let observed: readonly unknown[] = [];
    const adapter: HarnessAdapter = {
      id: "scripted",
      capabilities: () => capabilities,
      async open() {
        opened += 1;
        return {
          async *run(runRequest) {
            observed = runRequest.input;
          },
        };
      },
    };
    const persistence = createMemoryPersistence();
    const harness = createHarness({
      adapters: [adapter],
      persistence,
      createId: () => `id-${++ids}`,
      contextSources: [{
        id: "test:policy",
        failureMode: "required",
        prepare() {
          preparations += 1;
          return { content: [] };
        },
      }],
    });
    const inputPolicy = {
      modalities: {
        text: { support: "stable" as const },
        image: { support: "unsupported" as const },
        resource: { support: "unsupported" as const },
      },
    };

    const rejectedInput = [
      [{ type: "image" as const, mediaType: "image/png", data: new Uint8Array([1]) }],
      [{ type: "resource" as const, uri: "fold://note/1" }],
    ];
    for (const input of rejectedInput) {
      expect(() => harness.start({ ...request, input }, { inputPolicy })).toThrow("does not support");
    }
    expect(opened).toBe(0);
    expect(ids).toBe(0);
    expect(preparations).toBe(0);
    expect(await persistence.events.list(request.session, request.adapterId)).toEqual([]);

    const valid = harness.start(request, { inputPolicy });
    await collect(valid.events);
    expect(await valid.done).toBe("completed");
    expect(opened).toBe(1);
    expect(observed).toEqual(request.input);

    const imageInput = [{
      type: "image" as const,
      mediaType: "image/png",
      data: new Uint8Array([1, 2]),
    }];
    const allowed = harness.start({ ...request, input: imageInput }, {
      inputPolicy: { modalities: { image: { support: "stable" } } },
    });
    await collect(allowed.events);
    expect(await allowed.done).toBe("completed");
    expect(observed).toEqual(imageInput);

    const resourceInput = [{ type: "resource" as const, uri: "fold://note/2" }];
    const backwardCompatible = harness.start({ ...request, input: resourceInput });
    await collect(backwardCompatible.events);
    expect(await backwardCompatible.done).toBe("completed");
    expect(observed).toEqual(resourceInput);
  });

  test("enforces a complete admitted execution before runtime side effects", async () => {
    let opened = 0;
    let ids = 0;
    let preparations = 0;
    const adapter: HarnessAdapter = {
      id: "scripted",
      capabilities: () => capabilities,
      async open() {
        opened += 1;
        return { async *run() {} };
      },
    };
    const persistence = createMemoryPersistence();
    const harness = createHarness({
      adapters: [adapter],
      persistence,
      createId: () => `id-${++ids}`,
      contextSources: [{
        id: "test:admission",
        failureMode: "required",
        prepare() {
          preparations += 1;
          return { content: [] };
        },
      }],
    });
    const admittedRequest = {
      ...request,
      accountId: "account-a",
      model: "model-a",
      effort: "high",
      settings: {
        permission: { modeId: "workspace-write", consentVersion: "grant-2" },
        controls: { "vendor:fast": true, "vendor:verbosity": "high" },
      },
    };
    const admission = {
      adapterId: "scripted",
      accountId: "account-a",
      model: "model-a",
      effort: "high",
      settings: {
        permission: { modeId: "workspace-write", consentVersion: "grant-2" },
        controls: { "vendor:fast": true, "vendor:verbosity": "high" },
      },
      sessionBinding: "binding-a",
    } as const;

    const mismatches = [
      { ...admission, adapterId: "other" },
      { ...admission, accountId: "account-b" },
      { ...admission, model: "model-b" },
      { ...admission, effort: "low" },
      { ...admission, settings: { ...admission.settings, permission: { modeId: "read-only" } } },
      { ...admission, settings: { ...admission.settings, controls: { "vendor:fast": false } } },
    ];
    for (const rejected of mismatches) {
      expect(() => harness.start(admittedRequest, { admission: rejected })).toThrow(HarnessRuntimeError);
      try {
        harness.start(admittedRequest, { admission: rejected });
      } catch (error) {
        expect(error).toMatchObject({ code: "ADMISSION_MISMATCH" });
        expect(String(error)).not.toContain("account-b");
        expect(String(error)).not.toContain("model-b");
      }
    }
    expect(opened).toBe(0);
    expect(ids).toBe(0);
    expect(preparations).toBe(0);
    expect(await persistence.events.list(request.session, request.adapterId)).toEqual([]);

    const run = harness.start(admittedRequest, { admission });
    await collect(run.events);
    expect(await run.done).toBe("completed");
    expect(opened).toBe(1);
  });

  test("pins an admitted session binding while preserving no-admission compatibility", async () => {
    const adapter: HarnessAdapter = {
      id: "scripted",
      capabilities: () => capabilities,
      async open() { return { async *run() {} }; },
    };
    let ids = 0;
    const harness = createHarness({
      adapters: [adapter],
      persistence: createMemoryPersistence(),
      createId: () => `id-${++ids}`,
    });

    const first = harness.start(request, { admission: { sessionBinding: "binding-a" } });
    await collect(first.events);
    await first.done;
    const afterFirst = ids;

    expect(() => harness.start(request, {
      admission: { sessionBinding: "binding-b" },
    })).toThrow("does not match this harness session");
    expect(() => harness.start(request, { admission: {} })).toThrow("does not match this harness session");
    expect(ids).toBe(afterFirst);

    const compatible = harness.start(request);
    await collect(compatible.events);
    expect(await compatible.done).toBe("completed");
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

  test("binds host turn identity, cancellation, and prepared context exactly", async () => {
    const controller = new AbortController();
    const context = {
      sources: [{
        sourceId: "app:bound",
        value: { content: [{ type: "text" as const, text: "bound context" }], state: { revision: 7 } },
      }],
      unavailable: [],
    };
    let observed: HarnessAdapterRunRequest | undefined;
    let toolContext: HarnessAdapterRunRequest["context"] | undefined;
    const adapter: HarnessAdapter = {
      id: "scripted",
      capabilities: () => capabilities,
      async open() {
        return {
          async *run(runRequest) {
            observed = runRequest;
            await runRequest.tools.call("inspect", {});
            yield { kind: "assistant-text", text: "done" };
          },
        };
      },
    };
    const harness = createHarness({
      adapters: [adapter],
      persistence: createMemoryPersistence(),
      contextSources: [{
        id: "app:must-not-run",
        failureMode: "required",
        prepare: () => { throw new Error("prepared context should bypass sources"); },
      }],
      tools: {
        list: () => [{ name: "inspect", description: "Inspect context", inputSchema: {} }],
        async call(_name, _input, bound) {
          toolContext = bound.context;
          return { content: [] };
        },
      },
    });

    const run = harness.start(request, {
      runId: "host-run",
      turnId: "host-turn",
      controller,
      context,
    });
    const events = await collect(run.events);

    expect(run.runId).toBe("host-run");
    expect(run.turnId).toBe("host-turn");
    expect(events.every((event) => event.runId === "host-run" && event.turnId === "host-turn")).toBe(true);
    expect(observed?.signal).toBe(controller.signal);
    expect(observed?.context).toBe(context);
    expect(toolContext).toBe(context);
    expect(await run.done).toBe("completed");
  });

  test("does not open a provider for a pre-aborted host turn", async () => {
    const controller = new AbortController();
    controller.abort();
    let opened = false;
    const adapter: HarnessAdapter = {
      id: "scripted",
      capabilities: () => capabilities,
      async open() {
        opened = true;
        return { async *run() {} };
      },
    };
    const harness = createHarness({ adapters: [adapter], persistence: createMemoryPersistence() });
    const run = harness.start(request, { controller });
    const events = await collect(run.events);

    expect(await run.done).toBe("interrupted");
    expect(opened).toBe(false);
    expect(events.map((event) => event.payload.kind)).toEqual(["turn-started", "turn-completed"]);
    expect(events.at(-1)?.payload).toMatchObject({ kind: "turn-completed", status: "interrupted" });
    await run.cancel();
  });

  test("cancel owns a supplied controller and remains idempotent", async () => {
    const controller = new AbortController();
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    let cancellations = 0;
    const adapter: HarnessAdapter = {
      id: "scripted",
      capabilities: () => capabilities,
      async open() {
        return {
          async *run(runRequest) {
            yield { kind: "assistant-text", text: "waiting" };
            await waiting;
            expect(runRequest.signal).toBe(controller.signal);
          },
          async cancel() {
            cancellations += 1;
            release();
          },
        };
      },
    };
    const harness = createHarness({ adapters: [adapter], persistence: createMemoryPersistence() });
    const run = harness.start(request, { controller });
    const events = collect(run.events);
    await Bun.sleep(0);

    await Promise.all([run.cancel(), run.cancel()]);

    expect(controller.signal.aborted).toBe(true);
    expect(cancellations).toBe(1);
    expect(await run.done).toBe("interrupted");
    expect((await events).at(-1)?.payload).toMatchObject({ kind: "turn-completed", status: "interrupted" });
  });

  test("closes a session that finishes opening after cancellation without starting it", async () => {
    let finishOpening!: () => void;
    const opening = new Promise<void>((resolve) => { finishOpening = resolve; });
    let opened = false;
    let ran = false;
    let closed = false;
    const adapter: HarnessAdapter = {
      id: "scripted",
      capabilities: () => capabilities,
      async open() {
        opened = true;
        await opening;
        return {
          async *run() { ran = true; },
          async close() { closed = true; },
        };
      },
    };
    const harness = createHarness({ adapters: [adapter], persistence: createMemoryPersistence() });
    const run = harness.start(request);
    const events = collect(run.events);
    while (!opened) await Bun.sleep(0);

    let cancellationSettled = false;
    const cancellation = run.cancel().finally(() => { cancellationSettled = true; });
    await Bun.sleep(0);
    expect(cancellationSettled).toBe(false);

    finishOpening();
    await cancellation;

    expect(ran).toBe(false);
    expect(closed).toBe(true);
    expect(await run.done).toBe("interrupted");
    expect((await events).map((event) => event.payload.kind)).toEqual(["turn-started", "turn-completed"]);
  });

  test("dispatches adapter cancellation when a supplied controller aborts externally", async () => {
    const controller = new AbortController();
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    let cancellations = 0;
    const adapter: HarnessAdapter = {
      id: "scripted",
      capabilities: () => capabilities,
      async open() {
        return {
          async *run() {
            yield { kind: "assistant-text", text: "waiting" };
            await waiting;
          },
          async cancel() {
            cancellations += 1;
            release();
          },
        };
      },
    };
    const harness = createHarness({ adapters: [adapter], persistence: createMemoryPersistence() });
    const run = harness.start(request, { controller });
    const events = collect(run.events);
    await Bun.sleep(0);

    controller.abort();

    expect(await run.done).toBe("interrupted");
    expect(cancellations).toBe(1);
    expect((await events).at(-1)?.payload).toMatchObject({ kind: "turn-completed", status: "interrupted" });
  });

  test("waits for provider drain when adapter cancellation rejects", async () => {
    let releaseDrain!: () => void;
    const draining = new Promise<void>((resolve) => { releaseDrain = resolve; });
    const adapter: HarnessAdapter = {
      id: "scripted",
      capabilities: () => capabilities,
      async open() {
        return {
          async *run() { await draining; },
          async cancel() { throw new Error("provider cancellation failed"); },
        };
      },
    };
    const harness = createHarness({ adapters: [adapter], persistence: createMemoryPersistence() });
    const run = harness.start(request);
    const events = collect(run.events);
    await Bun.sleep(0);

    let cancellationSettled = false;
    const cancellation = run.cancel()
      .finally(() => { cancellationSettled = true; });
    await Bun.sleep(0);
    expect(cancellationSettled).toBe(false);

    releaseDrain();
    await expect(cancellation).rejects.toThrow("provider cancellation failed");
    expect(await run.done).toBe("interrupted");
    expect((await events).at(-1)?.payload).toMatchObject({ kind: "turn-completed", status: "interrupted" });
  });

  test("keeps a cancelled session reserved until its terminal event is persisted", async () => {
    let releaseProvider!: () => void;
    const providerWaiting = new Promise<void>((resolve) => { releaseProvider = resolve; });
    let terminalReached!: () => void;
    const terminalStarted = new Promise<void>((resolve) => { terminalReached = resolve; });
    let persistTerminal!: () => void;
    const terminalWaiting = new Promise<void>((resolve) => { persistTerminal = resolve; });
    let invocations = 0;
    const adapter: HarnessAdapter = {
      id: "scripted",
      capabilities: () => capabilities,
      async open() {
        return {
          async *run() {
            invocations += 1;
            if (invocations === 1) await providerWaiting;
          },
          async cancel() { releaseProvider(); },
        };
      },
    };
    const persistence = createMemoryPersistence();
    const append = persistence.events.append.bind(persistence.events);
    persistence.events.append = async (event) => {
      if (event.runId === "first-run" && event.payload.kind === "turn-completed") {
        terminalReached();
        await terminalWaiting;
      }
      return append(event);
    };
    const harness = createHarness({ adapters: [adapter], persistence });
    const first = harness.start(request, { runId: "first-run", turnId: "first-turn" });
    const firstEvents = collect(first.events);
    await Bun.sleep(0);
    const cancellation = first.cancel();
    await terminalStarted;

    const overlapping = harness.start(request, { runId: "overlap-run", turnId: "overlap-turn" });
    const overlappingEvents = await collect(overlapping.events);
    expect(await overlapping.done).toBe("error");
    expect(overlappingEvents.find((event) => event.payload.kind === "error")?.payload).toMatchObject({
      kind: "error",
      code: "SESSION_BUSY",
    });

    persistTerminal();
    await cancellation;
    await firstEvents;

    const next = harness.start(request, { runId: "next-run", turnId: "next-turn" });
    await collect(next.events);
    expect(await next.done).toBe("completed");
    expect(invocations).toBe(2);
  });

  test("steers a declared same-turn follow-up without a second lifecycle envelope", async () => {
    let ready = false;
    let acceptFollowUp!: () => void;
    const followedUp = new Promise<void>((resolve) => { acceptFollowUp = resolve; });
    const observed: unknown[] = [];
    const adapter: HarnessAdapter = {
      id: "scripted",
      capabilities: () => ({
        ...capabilities,
        steering: { support: "stable", strategies: ["same-turn"], preferred: "same-turn" },
      }),
      async open() {
        return {
          async *run() {
            ready = true;
            yield { kind: "assistant-text", text: "before" };
            await followedUp;
            yield { kind: "assistant-text", text: "after" };
          },
          async steer(followUp) {
            observed.push(followUp);
            acceptFollowUp();
          },
        };
      },
    };
    const harness = createHarness({ adapters: [adapter], persistence: createMemoryPersistence() });
    const run = harness.start(request, { runId: "same-run", turnId: "same-turn" });
    const events = collect(run.events);
    while (!ready) await Bun.sleep(0);

    const result = await run.followUp({
      expectedTurnId: "same-turn",
      input: [{ type: "text", text: "more" }],
      metadata: { source: "queue" },
    });

    expect(result).toEqual({ strategy: "same-turn", run });
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({
      expectedTurnId: "same-turn",
      runId: "same-run",
      turnId: "same-turn",
      input: [{ type: "text", text: "more" }],
      metadata: { source: "queue" },
    });
    expect(await run.done).toBe("completed");
    expect((await events).map((event) => event.payload.kind)).toEqual([
      "turn-started",
      "assistant-text",
      "assistant-text",
      "turn-completed",
    ]);
  });

  test("uses the snapshotted input policy for same-turn follow-ups", async () => {
    let ready = false;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    let steers = 0;
    let cancellations = 0;
    const adapter: HarnessAdapter = {
      id: "scripted",
      capabilities: () => ({
        ...capabilities,
        steering: { support: "stable", strategies: ["same-turn"] },
      }),
      async open() {
        return {
          async *run() { ready = true; await waiting; },
          async steer() { steers += 1; release(); },
          async cancel() { cancellations += 1; release(); },
        };
      },
    };
    const imageConstraint: { support: "unsupported" | "stable" } = { support: "unsupported" };
    const inputPolicy = { modalities: { image: imageConstraint } };
    const harness = createHarness({ adapters: [adapter], persistence: createMemoryPersistence() });
    const run = harness.start(request, { turnId: "policy-turn", inputPolicy });
    const events = collect(run.events);
    while (!ready) await Bun.sleep(0);

    imageConstraint.support = "stable";
    await expect(run.followUp({
      expectedTurnId: "policy-turn",
      input: [{ type: "image", mediaType: "image/png", data: new Uint8Array([1]) }],
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(steers).toBe(0);
    expect(cancellations).toBe(0);

    await run.followUp({
      expectedTurnId: "policy-turn",
      input: [{ type: "text", text: "still active" }],
    });
    expect(steers).toBe(1);
    expect(await run.done).toBe("completed");
    await events;
  });

  test("refuses stale and unsupported follow-ups without cancelling the active turn", async () => {
    let ready = false;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    let cancellations = 0;
    let steers = 0;
    const adapter: HarnessAdapter = {
      id: "scripted",
      capabilities: () => capabilities,
      async open() {
        return {
          async *run() { ready = true; await waiting; },
          async steer() { steers += 1; },
          async cancel() { cancellations += 1; release(); },
        };
      },
    };
    const harness = createHarness({ adapters: [adapter], persistence: createMemoryPersistence() });
    const run = harness.start(request, { turnId: "current-turn" });
    const events = collect(run.events);
    while (!ready) await Bun.sleep(0);

    await expect(run.followUp({
      expectedTurnId: "older-turn",
      input: [{ type: "text", text: "stale" }],
    })).rejects.toMatchObject({ code: "STALE_TURN" });
    await expect(run.followUp({
      expectedTurnId: "current-turn",
      input: [{ type: "text", text: "unsupported" }],
    })).rejects.toMatchObject({ code: "FOLLOW_UP_UNSUPPORTED" });
    expect(steers).toBe(0);
    expect(cancellations).toBe(0);

    await run.cancel();
    await events;
    expect(cancellations).toBe(1);
  });

  test("prepares a replacement before cancelling and admits it after the old terminal", async () => {
    let firstReady = false;
    let releaseFirst!: () => void;
    const firstWaiting = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const order: string[] = [];
    let invocations = 0;
    const adapter: HarnessAdapter = {
      id: "scripted",
      capabilities: () => ({
        ...capabilities,
        steering: { support: "stable", strategies: ["replacement-turn"], preferred: "replacement-turn" },
      }),
      async open() {
        return {
          async *run() {
            invocations += 1;
            order.push(`run:${invocations}`);
            if (invocations === 1) {
              firstReady = true;
              await firstWaiting;
            }
          },
          async cancel() {
            order.push("cancel");
            releaseFirst();
          },
        };
      },
    };
    const harness = createHarness({
      adapters: [adapter],
      persistence: createMemoryPersistence(),
      contextSources: [{
        id: "test:context",
        failureMode: "required",
        prepare(contextRequest) {
          order.push(`prepare:${contextRequest.turnId}`);
          return { content: [{ type: "text", text: contextRequest.input[0]?.type === "text" ? contextRequest.input[0].text : "" }] };
        },
      }],
    });
    const first = harness.start(request, {
      runId: "first-run",
      turnId: "first-turn",
      context: { sources: [], unavailable: [] },
    });
    const firstEvents = collect(first.events);
    while (!firstReady) await Bun.sleep(0);

    const result = await first.followUp({
      expectedTurnId: "first-turn",
      input: [{ type: "text", text: "replacement" }],
    }, {
      replacement: { runId: "second-run", turnId: "second-turn" },
    });
    const secondEvents = collect(result.run.events);

    expect(result.strategy).toBe("replacement-turn");
    expect(result.run).not.toBe(first);
    expect(result.run.runId).toBe("second-run");
    expect(result.run.turnId).toBe("second-turn");
    expect(await first.done).toBe("interrupted");
    expect(await result.run.done).toBe("completed");
    expect(order).toEqual(["run:1", "prepare:second-turn", "cancel", "run:2"]);
    expect((await firstEvents).at(-1)?.payload).toMatchObject({ kind: "turn-completed", status: "interrupted" });
    expect((await secondEvents).at(-1)?.payload).toMatchObject({ kind: "turn-completed", status: "completed" });
  });

  test("leaves the active turn alive when replacement preparation fails", async () => {
    let ready = false;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    let cancellations = 0;
    const adapter: HarnessAdapter = {
      id: "scripted",
      capabilities: () => ({
        ...capabilities,
        steering: { support: "stable", strategies: ["replacement-turn"] },
      }),
      async open() {
        return {
          async *run() { ready = true; await waiting; },
          async cancel() { cancellations += 1; release(); },
        };
      },
    };
    const harness = createHarness({
      adapters: [adapter],
      persistence: createMemoryPersistence(),
      contextSources: [{ id: "test:required", failureMode: "required", prepare: () => null }],
    });
    const run = harness.start(request, {
      turnId: "active-turn",
      context: { sources: [], unavailable: [] },
    });
    const events = collect(run.events);
    while (!ready) await Bun.sleep(0);

    await expect(run.followUp({
      expectedTurnId: "active-turn",
      input: [{ type: "text", text: "replacement" }],
    })).rejects.toMatchObject({ code: "CONTEXT_SOURCE_UNAVAILABLE" });
    expect(cancellations).toBe(0);

    await run.cancel();
    await events;
    expect(cancellations).toBe(1);
  });

  test("validates a replacement policy before context preparation or cancellation", async () => {
    let ready = false;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    let cancellations = 0;
    let preparations = 0;
    let invocations = 0;
    const adapter: HarnessAdapter = {
      id: "scripted",
      capabilities: () => ({
        ...capabilities,
        steering: { support: "stable", strategies: ["replacement-turn"] },
      }),
      async open() {
        return {
          async *run() {
            invocations += 1;
            if (invocations === 1) {
              ready = true;
              await waiting;
            }
          },
          async cancel() { cancellations += 1; release(); },
        };
      },
    };
    const harness = createHarness({
      adapters: [adapter],
      persistence: createMemoryPersistence(),
      contextSources: [{
        id: "replacement",
        failureMode: "required",
        prepare() {
          preparations += 1;
          return { content: [] };
        },
      }],
    });
    const run = harness.start(request, {
      turnId: "active-turn",
      context: { sources: [], unavailable: [] },
      inputPolicy: { modalities: { image: { support: "unsupported" } } },
    });
    const events = collect(run.events);
    while (!ready) await Bun.sleep(0);

    await expect(run.followUp({
      expectedTurnId: "active-turn",
      input: [{ type: "image", mediaType: "image/png", data: new Uint8Array([1]) }],
    }, {
      replacement: {},
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(preparations).toBe(0);
    expect(cancellations).toBe(0);

    const overrideConstraint: { support: "stable" | "unsupported" } = { support: "stable" };
    const replacing = run.followUp({
      expectedTurnId: "active-turn",
      input: [{ type: "image", mediaType: "image/png", data: new Uint8Array([1]) }],
    }, {
      replacement: {
        inputPolicy: { modalities: { image: overrideConstraint } },
      },
    });
    overrideConstraint.support = "unsupported";
    const result = await replacing;
    const replacementEvents = await collect(result.run.events);

    expect(await run.done).toBe("interrupted");
    await events;
    expect(cancellations).toBe(1);
    expect(preparations).toBe(1);
    expect(invocations).toBe(2);
    expect(await result.run.done).toBe("completed");
    expect(replacementEvents.at(-1)?.payload).toMatchObject({ kind: "turn-completed", status: "completed" });
  });

  test("inherits admission for replacements and snapshots an explicit readmission", async () => {
    let ready = false;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    let cancellations = 0;
    let preparations = 0;
    let generatedIds = 0;
    let invocations = 0;
    const adapter: HarnessAdapter = {
      id: "scripted",
      capabilities: () => ({
        ...capabilities,
        steering: { support: "stable", strategies: ["replacement-turn"] },
      }),
      async open() {
        return {
          async *run() {
            invocations += 1;
            if (invocations === 1) {
              ready = true;
              await waiting;
            }
          },
          async cancel() { cancellations += 1; release(); },
        };
      },
    };
    const harness = createHarness({
      adapters: [adapter],
      persistence: createMemoryPersistence(),
      createId: () => `replacement-id-${++generatedIds}`,
      contextSources: [{
        id: "test:replacement-admission",
        failureMode: "required",
        prepare() {
          preparations += 1;
          return { content: [] };
        },
      }],
    });
    const mutableRequest = {
      ...request,
      model: "model-a",
      settings: { controls: { "vendor:fast": false } },
    };
    const admission = {
      adapterId: "scripted",
      model: "model-a",
      settings: { controls: { "vendor:fast": false } },
      sessionBinding: "binding-a",
    } as const;
    const run = harness.start(mutableRequest, {
      runId: "initial-run",
      turnId: "initial-turn",
      context: { sources: [], unavailable: [] },
      admission,
    });
    const events = collect(run.events);
    while (!ready) await Bun.sleep(0);

    mutableRequest.model = "model-b";
    mutableRequest.settings.controls["vendor:fast"] = true;
    await expect(run.followUp({
      expectedTurnId: "initial-turn",
      input: [{ type: "text", text: "replace" }],
    })).rejects.toMatchObject({ code: "ADMISSION_MISMATCH" });
    expect(generatedIds).toBe(0);
    expect(preparations).toBe(0);
    expect(cancellations).toBe(0);

    const replacementAdmission = {
      adapterId: "scripted",
      model: "model-b",
      settings: { controls: { "vendor:fast": true } },
      sessionBinding: "binding-a",
    };
    const replacing = run.followUp({
      expectedTurnId: "initial-turn",
      input: [{ type: "text", text: "replace" }],
    }, { replacement: { admission: replacementAdmission } });
    replacementAdmission.model = "model-after-call";
    replacementAdmission.settings.controls["vendor:fast"] = false;

    const result = await replacing;
    const replacementEvents = await collect(result.run.events);
    await events;
    expect(await run.done).toBe("interrupted");
    expect(await result.run.done).toBe("completed");
    expect(generatedIds).toBe(2);
    expect(preparations).toBe(1);
    expect(cancellations).toBe(1);
    expect(invocations).toBe(2);
    expect(replacementEvents.at(-1)?.payload).toMatchObject({ kind: "turn-completed", status: "completed" });
  });

  test("refuses a replacement session-binding change before ids, context, or cancellation", async () => {
    let ready = false;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    let cancellations = 0;
    let preparations = 0;
    let generatedIds = 0;
    const adapter: HarnessAdapter = {
      id: "scripted",
      capabilities: () => ({
        ...capabilities,
        steering: { support: "stable", strategies: ["replacement-turn"] },
      }),
      async open() {
        return {
          async *run() { ready = true; await waiting; },
          async cancel() { cancellations += 1; release(); },
        };
      },
    };
    const harness = createHarness({
      adapters: [adapter],
      persistence: createMemoryPersistence(),
      createId: () => `replacement-id-${++generatedIds}`,
      contextSources: [{
        id: "test:replacement-binding",
        failureMode: "required",
        prepare() {
          preparations += 1;
          return { content: [] };
        },
      }],
    });
    const run = harness.start(request, {
      runId: "initial-run",
      turnId: "initial-turn",
      context: { sources: [], unavailable: [] },
      admission: { sessionBinding: "binding-a" },
    });
    const events = collect(run.events);
    while (!ready) await Bun.sleep(0);

    await expect(run.followUp({
      expectedTurnId: "initial-turn",
      input: [{ type: "text", text: "replace" }],
    }, {
      replacement: { admission: { sessionBinding: "binding-b" } },
    })).rejects.toMatchObject({ code: "ADMISSION_MISMATCH" });
    expect(generatedIds).toBe(0);
    expect(preparations).toBe(0);
    expect(cancellations).toBe(0);

    await run.cancel();
    await events;
    expect(cancellations).toBe(1);
  });

  test("serializes stop ahead of a later same-turn follow-up", async () => {
    let ready = false;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    let steers = 0;
    const adapter: HarnessAdapter = {
      id: "scripted",
      capabilities: () => ({
        ...capabilities,
        steering: { support: "stable", strategies: ["same-turn"] },
      }),
      async open() {
        return {
          async *run() { ready = true; await waiting; },
          async steer() { steers += 1; },
          async cancel() { release(); },
        };
      },
    };
    const harness = createHarness({ adapters: [adapter], persistence: createMemoryPersistence() });
    const run = harness.start(request, { turnId: "active-turn" });
    const events = collect(run.events);
    while (!ready) await Bun.sleep(0);

    const stopping = run.cancel();
    const followUp = run.followUp({
      expectedTurnId: "active-turn",
      input: [{ type: "text", text: "too late" }],
    });

    await stopping;
    await expect(followUp).rejects.toMatchObject({ code: "TURN_NOT_ACTIVE" });
    await events;
    expect(steers).toBe(0);
  });

  test("stop aborts an in-flight follow-up before waiting for its control slot", async () => {
    let ready = false;
    let steeringStarted!: () => void;
    const started = new Promise<void>((resolve) => { steeringStarted = resolve; });
    let releaseRun!: () => void;
    const running = new Promise<void>((resolve) => { releaseRun = resolve; });
    const adapter: HarnessAdapter = {
      id: "scripted",
      capabilities: () => ({
        ...capabilities,
        steering: { support: "stable", strategies: ["same-turn"] },
      }),
      async open() {
        return {
          async *run() { ready = true; await running; },
          async steer({ signal }) {
            steeringStarted();
            await new Promise<void>((_resolve, reject) => {
              const abort = () => reject(new HarnessAdapterInterruptedError());
              signal.addEventListener("abort", abort, { once: true });
              if (signal.aborted) abort();
            });
          },
          async cancel() { releaseRun(); },
        };
      },
    };
    const harness = createHarness({ adapters: [adapter], persistence: createMemoryPersistence() });
    const run = harness.start(request, { turnId: "active-turn" });
    const events = collect(run.events);
    while (!ready) await Bun.sleep(0);

    const followUp = run.followUp({
      expectedTurnId: "active-turn",
      input: [{ type: "text", text: "still pending" }],
    });
    await started;
    const stopping = run.cancel();

    await expect(followUp).rejects.toMatchObject({ code: "FOLLOW_UP_FAILED" });
    await stopping;
    expect(await run.done).toBe("interrupted");
    await events;
  });

  test("an aborted replacement controller leaves the active turn untouched", async () => {
    let ready = false;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    let cancellations = 0;
    const adapter: HarnessAdapter = {
      id: "scripted",
      capabilities: () => ({
        ...capabilities,
        steering: { support: "stable", strategies: ["replacement-turn"] },
      }),
      async open() {
        return {
          async *run() { ready = true; await waiting; },
          async cancel() { cancellations += 1; release(); },
        };
      },
    };
    const harness = createHarness({ adapters: [adapter], persistence: createMemoryPersistence() });
    const run = harness.start(request, {
      turnId: "active-turn",
      context: { sources: [], unavailable: [] },
    });
    const events = collect(run.events);
    while (!ready) await Bun.sleep(0);
    const replacementController = new AbortController();
    replacementController.abort();

    await expect(run.followUp({
      expectedTurnId: "active-turn",
      input: [{ type: "text", text: "cancelled replacement" }],
    }, {
      replacement: {
        controller: replacementController,
        context: { sources: [], unavailable: [] },
      },
    })).rejects.toMatchObject({ code: "FOLLOW_UP_FAILED" });
    expect(cancellations).toBe(0);

    await run.cancel();
    await events;
    expect(cancellations).toBe(1);
  });

  test("refuses follow-ups after provider drain while checkpoint persistence is pending", async () => {
    let persistStarted!: () => void;
    const checkpointStarted = new Promise<void>((resolve) => { persistStarted = resolve; });
    let finishPersistence!: () => void;
    const persistence = new Promise<void>((resolve) => { finishPersistence = resolve; });
    let steers = 0;
    const adapter: HarnessAdapter = {
      id: "scripted",
      capabilities: () => ({
        ...capabilities,
        steering: { support: "stable", strategies: ["same-turn"] },
      }),
      async open() {
        return {
          async *run() {},
          async steer() { steers += 1; },
          checkpoint: () => "checkpoint",
        };
      },
    };
    const store = createMemoryPersistence();
    const save = store.sessions.save.bind(store.sessions);
    store.sessions.save = async (session) => {
      persistStarted();
      await persistence;
      await save(session);
    };
    const harness = createHarness({ adapters: [adapter], persistence: store });
    const run = harness.start(request, { turnId: "drained-turn" });
    const events = collect(run.events);
    await checkpointStarted;

    await expect(run.followUp({
      expectedTurnId: "drained-turn",
      input: [{ type: "text", text: "too late" }],
    })).rejects.toMatchObject({ code: "TURN_NOT_ACTIVE" });
    expect(steers).toBe(0);

    finishPersistence();
    expect(await run.done).toBe("completed");
    await events;
  });

  test("refuses follow-ups after provider failure while error persistence is pending", async () => {
    let providerEnded!: () => void;
    const ended = new Promise<void>((resolve) => { providerEnded = resolve; });
    let errorPersisting!: () => void;
    const persistenceStarted = new Promise<void>((resolve) => { errorPersisting = resolve; });
    let finishPersistence!: () => void;
    const persistence = new Promise<void>((resolve) => { finishPersistence = resolve; });
    let steers = 0;
    const adapter: HarnessAdapter = {
      id: "scripted",
      capabilities: () => ({
        ...capabilities,
        steering: { support: "stable", strategies: ["same-turn"] },
      }),
      async open() {
        return {
          async *run() {
            providerEnded();
            throw new Error("provider failed");
          },
          async steer() { steers += 1; },
        };
      },
    };
    const store = createMemoryPersistence();
    const append = store.events.append.bind(store.events);
    store.events.append = async (event) => {
      if (event.payload.kind === "error") {
        errorPersisting();
        await persistence;
      }
      return append(event);
    };
    const harness = createHarness({ adapters: [adapter], persistence: store });
    const run = harness.start(request, { turnId: "failed-turn" });
    const events = collect(run.events);
    await ended;
    await persistenceStarted;

    await expect(run.followUp({
      expectedTurnId: "failed-turn",
      input: [{ type: "text", text: "too late" }],
    })).rejects.toMatchObject({ code: "TURN_NOT_ACTIVE" });
    expect(steers).toBe(0);

    finishPersistence();
    expect(await run.done).toBe("error");
    await events;
  });

  test("stop aborts replacement context preparation before waiting for control serialization", async () => {
    let runReady = false;
    let releaseRun!: () => void;
    const running = new Promise<void>((resolve) => { releaseRun = resolve; });
    let preparationStarted!: () => void;
    const preparing = new Promise<void>((resolve) => { preparationStarted = resolve; });
    let replacementSignalAborted = false;
    const adapter: HarnessAdapter = {
      id: "scripted",
      capabilities: () => ({
        ...capabilities,
        steering: { support: "stable", strategies: ["replacement-turn"] },
      }),
      async open() {
        return {
          async *run() { runReady = true; await running; },
          async cancel() { releaseRun(); },
        };
      },
    };
    const harness = createHarness({
      adapters: [adapter],
      persistence: createMemoryPersistence(),
      contextSources: [{
        id: "test:replacement",
        failureMode: "required",
        prepare({ signal }) {
          preparationStarted();
          return new Promise((resolve) => {
            const abort = () => {
              replacementSignalAborted = true;
              resolve({ content: [] });
            };
            signal.addEventListener("abort", abort, { once: true });
            if (signal.aborted) abort();
          });
        },
      }],
    });
    const run = harness.start(request, {
      turnId: "active-turn",
      context: { sources: [], unavailable: [] },
    });
    const events = collect(run.events);
    while (!runReady) await Bun.sleep(0);

    const followUp = run.followUp({
      expectedTurnId: "active-turn",
      input: [{ type: "text", text: "replacement" }],
    });
    await preparing;
    const stopping = run.cancel();

    await expect(followUp).rejects.toMatchObject({ code: "FOLLOW_UP_FAILED" });
    await stopping;
    expect(replacementSignalAborted).toBe(true);
    expect(await run.done).toBe("interrupted");
    await events;
  });

  test("does not abort a replacement controller while cancelling the old turn", async () => {
    let firstReady = false;
    let releaseFirst!: () => void;
    const firstWaiting = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let invocations = 0;
    const adapter: HarnessAdapter = {
      id: "scripted",
      capabilities: () => ({
        ...capabilities,
        steering: { support: "stable", strategies: ["replacement-turn"] },
      }),
      async open() {
        return {
          async *run() {
            invocations += 1;
            if (invocations === 1) {
              firstReady = true;
              await firstWaiting;
              throw new HarnessAdapterInterruptedError();
            }
            yield { kind: "assistant-text", text: "replacement" };
          },
          async cancel() { releaseFirst(); },
        };
      },
    };
    const harness = createHarness({ adapters: [adapter], persistence: createMemoryPersistence() });
    const run = harness.start(request, {
      turnId: "active-turn",
      context: { sources: [], unavailable: [] },
    });
    const oldEvents = collect(run.events);
    while (!firstReady) await Bun.sleep(0);
    const replacementController = new AbortController();

    const result = await run.followUp({
      expectedTurnId: "active-turn",
      input: [{ type: "text", text: "replace" }],
    }, {
      replacement: {
        controller: replacementController,
        context: { sources: [], unavailable: [] },
      },
    });
    const replacementEvents = await collect(result.run.events);

    expect(result.strategy).toBe("replacement-turn");
    expect(replacementController.signal.aborted).toBe(false);
    expect(await run.done).toBe("interrupted");
    expect(await result.run.done).toBe("completed");
    expect(replacementEvents.some((event) => event.payload.kind === "assistant-text"
      && event.payload.text === "replacement")).toBe(true);
    await oldEvents;
  });

  test("normalizes an unsafe cancellation failure during replacement", async () => {
    let firstReady = false;
    let releaseFirst!: () => void;
    const firstWaiting = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const adapter: HarnessAdapter = {
      id: "scripted",
      capabilities: () => ({
        ...capabilities,
        steering: { support: "stable", strategies: ["replacement-turn"] },
      }),
      async open() {
        return {
          async *run() {
            firstReady = true;
            await firstWaiting;
            throw new HarnessAdapterInterruptedError();
          },
          async cancel() {
            releaseFirst();
            throw new Error("raw-provider-secret");
          },
        };
      },
    };
    const harness = createHarness({ adapters: [adapter], persistence: createMemoryPersistence() });
    const run = harness.start(request, {
      turnId: "active-turn",
      context: { sources: [], unavailable: [] },
    });
    const events = collect(run.events);
    while (!firstReady) await Bun.sleep(0);

    const followUp = run.followUp({
      expectedTurnId: "active-turn",
      input: [{ type: "text", text: "replace" }],
    }, {
      replacement: { context: { sources: [], unavailable: [] } },
    });

    await expect(followUp).rejects.toMatchObject({
      code: "FOLLOW_UP_FAILED",
      message: "The adapter could not replace the active turn.",
    });
    await expect(followUp).rejects.not.toThrow("raw-provider-secret");
    expect(await run.done).toBe("interrupted");
    await events;
  });

  test("rejects reused replacement identity before preparing or cancelling", async () => {
    const controller = new AbortController();
    let ready = false;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    let cancellations = 0;
    let preparations = 0;
    const adapter: HarnessAdapter = {
      id: "scripted",
      capabilities: () => ({
        ...capabilities,
        steering: { support: "stable", strategies: ["replacement-turn"] },
      }),
      async open() {
        return {
          async *run() { ready = true; await waiting; },
          async cancel() { cancellations += 1; release(); },
        };
      },
    };
    const harness = createHarness({
      adapters: [adapter],
      persistence: createMemoryPersistence(),
      contextSources: [{
        id: "replacement",
        failureMode: "required",
        prepare() {
          preparations += 1;
          return { content: [] };
        },
      }],
    });
    const run = harness.start(request, {
      runId: "active-run",
      turnId: "active-turn",
      controller,
      context: { sources: [], unavailable: [] },
    });
    const events = collect(run.events);
    while (!ready) await Bun.sleep(0);

    const attempts = [
      { runId: "active-run" },
      { turnId: "active-turn" },
      { controller },
    ];
    for (const replacement of attempts) {
      await expect(run.followUp({
        expectedTurnId: "active-turn",
        input: [{ type: "text", text: "invalid replacement" }],
      }, { replacement })).rejects.toThrow("a replacement follow-up requires a fresh");
    }
    expect(preparations).toBe(0);
    expect(cancellations).toBe(0);
    expect(controller.signal.aborted).toBe(false);

    await run.cancel();
    expect(await run.done).toBe("interrupted");
    await events;
  });

  test("rejects empty host turn identifiers synchronously", () => {
    const harness = createHarness({ adapters: [], persistence: createMemoryPersistence() });
    expect(() => harness.start(request, { runId: "" })).toThrow("a host-supplied runId cannot be empty");
    expect(() => harness.start(request, { turnId: "" })).toThrow("a host-supplied turnId cannot be empty");
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
