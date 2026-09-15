import { describe, expect, test } from "bun:test";
import {
  createHarnessTurnQueue,
  HarnessTurnQueueError,
  type HarnessTurnQueueBinding,
} from "../src/index.ts";

const first: HarnessTurnQueueBinding = {
  session: { tenantId: "tenant", actorId: "actor", threadId: "first" },
  adapterId: "claude",
};
const second: HarnessTurnQueueBinding = {
  session: { tenantId: "tenant", actorId: "actor", threadId: "second" },
  adapterId: "claude",
};

function queue(maxDepth = 4) {
  let id = 0;
  let tick = 0;
  return createHarnessTurnQueue<{ prompt: string }>({
    maxDepth,
    createId: () => `queued-${++id}`,
    now: () => new Date(1_800_000_000_000 + tick++),
  });
}

function expectQueueError(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error("expected queue action to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(HarnessTurnQueueError);
    expect((error as HarnessTurnQueueError).code).toBe(code);
  }
}

describe("host-owned harness turn queue", () => {
  test("rejects invalid bounds and boundary tokens", () => {
    expectQueueError(() => createHarnessTurnQueue({ maxDepth: 0 }), "INVALID_MAX_DEPTH");
    const turns = queue();
    turns.enqueue(first, { prompt: "one" });
    expectQueueError(() => turns.takeNext(first, ""), "INVALID_BOUNDARY");
  });

  test("preserves FIFO order and isolates complete session identity", () => {
    const turns = queue();
    turns.enqueue(first, { prompt: "one" });
    turns.enqueue(first, { prompt: "two" });
    turns.enqueue(second, { prompt: "other" });

    expect(turns.list(first).map((entry) => entry.payload.prompt)).toEqual(["one", "two"]);
    expect(turns.list(second).map((entry) => entry.payload.prompt)).toEqual(["other"]);

    const codex = { ...first, adapterId: "codex" };
    turns.enqueue(codex, { prompt: "codex" });
    expect(turns.list(first)).toHaveLength(2);
    expect(turns.list(codex)[0]?.payload.prompt).toBe("codex");
  });

  test("bounds pending plus leased entries and rejects duplicate ids", () => {
    const turns = queue(1);
    turns.enqueue(first, { prompt: "one" });
    expectQueueError(() => turns.enqueue(first, { prompt: "two" }), "QUEUE_FULL");

    const lease = turns.takeNext(first, "turn-ended:1");
    expect(lease).not.toBeNull();
    expectQueueError(() => turns.enqueue(first, { prompt: "still full" }), "QUEUE_FULL");
    turns.complete(lease!);

    const duplicate = createHarnessTurnQueue({ maxDepth: 2, createId: () => "same" });
    duplicate.enqueue(first, "one");
    expectQueueError(() => duplicate.enqueue(first, "two"), "DUPLICATE_ID");
  });

  test("holds the head without letting later work overtake it", () => {
    const turns = queue();
    const head = turns.enqueue(first, { prompt: "one" }, { held: true });
    turns.enqueue(first, { prompt: "two" });

    expect(turns.takeNext(first, "turn-ended:1")).toBeNull();
    expect(turns.release(first, head.id)?.held).toBe(false);
    expect(turns.takeNext(first, "turn-ended:1")?.entry.payload.prompt).toBe("one");
  });

  test("leases only one entry per boundary and only one caller can settle it", () => {
    const turns = queue();
    turns.enqueue(first, { prompt: "one" });
    turns.enqueue(first, { prompt: "two" });

    const lease = turns.takeNext(first, "tool:7");
    expect(lease?.entry.payload.prompt).toBe("one");
    expect(turns.takeNext(first, "tool:7")).toBeNull();
    expect(turns.complete(lease!)).toEqual(lease?.entry);
    expect(turns.complete(lease!)).toBeNull();
    expect(turns.takeNext(first, "tool:7")).toBeNull();
    expect(turns.takeNext(first, "turn-ended:8")?.entry.payload.prompt).toBe("two");
  });

  test("returns a failed lease to the front held and retains the tail", () => {
    const turns = queue();
    turns.enqueue(first, { prompt: "one" });
    turns.enqueue(first, { prompt: "two" });
    const lease = turns.takeNext(first, "turn-ended:1")!;

    const returned = turns.returnToFront(lease);
    expect(returned).toMatchObject({ held: true, payload: { prompt: "one" } });
    expect(lease.signal.aborted).toBe(true);
    expect(turns.list(first).map((entry) => [entry.payload.prompt, entry.held])).toEqual([
      ["one", true],
      ["two", false],
    ]);
  });

  test("holdAll invalidates an async lease and restores it before queued work", () => {
    const turns = queue();
    turns.enqueue(first, { prompt: "one" });
    turns.enqueue(first, { prompt: "two" });
    const lease = turns.takeNext(first, "turn-ended:1")!;
    const before = turns.generation(first);

    expect(turns.holdAll(first).map((entry) => entry.payload.prompt)).toEqual(["one", "two"]);
    expect(turns.generation(first)).toBe(before + 1);
    expect(lease.signal.aborted).toBe(true);
    expect(turns.complete(lease)).toBeNull();
    expect(turns.list(first).every((entry) => entry.held)).toBe(true);
  });

  test("drain invalidates a lease and cannot affect another session", () => {
    const turns = queue();
    turns.enqueue(first, { prompt: "one" });
    turns.enqueue(first, { prompt: "two" });
    turns.enqueue(second, { prompt: "other" });
    const lease = turns.takeNext(first, "turn-ended:1")!;

    expect(turns.drain(first).map((entry) => entry.payload.prompt)).toEqual(["one", "two"]);
    expect(lease.signal.aborted).toBe(true);
    expect(turns.complete(lease)).toBeNull();
    expect(turns.list(first)).toEqual([]);
    expect(turns.list(second).map((entry) => entry.payload.prompt)).toEqual(["other"]);
  });

  test("notifies subscribers only for mutations", () => {
    const turns = queue();
    let changes = 0;
    const unsubscribe = turns.subscribe(() => { changes += 1; });

    const entry = turns.enqueue(first, { prompt: "one" });
    turns.list(first);
    turns.hold(first, "missing");
    turns.hold(first, entry.id);
    turns.hold(first, entry.id);
    turns.remove(first, entry.id);
    unsubscribe();
    turns.enqueue(first, { prompt: "after" });

    expect(changes).toBe(3);
  });
});
