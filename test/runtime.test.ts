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
