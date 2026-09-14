import { describe, expect, test } from "bun:test";
import { createPushableAsyncIterable } from "../src/transports/async-iterable.ts";

describe("pushable async iterable", () => {
  test("delivers queued and awaited values before closing", async () => {
    const stream = createPushableAsyncIterable<string>();
    stream.push("first");
    const received: string[] = [];
    const reading = (async () => {
      for await (const value of stream) received.push(value);
    })();
    await Bun.sleep(0);
    expect(stream.push("second")).toBe(true);
    stream.close();
    await reading;
    expect(received).toEqual(["first", "second"]);
    expect(stream.push("late")).toBe(false);
  });

  test("ends an empty waiter and refuses a second consumer", async () => {
    const stream = createPushableAsyncIterable<number>();
    const iterator = stream[Symbol.asyncIterator]();
    const waiting = iterator.next();
    stream.close();
    expect(await waiting).toEqual({ done: true, value: undefined });
    expect(() => stream[Symbol.asyncIterator]()).toThrow("one consumer");
  });
});

