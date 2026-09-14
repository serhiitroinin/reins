/** A single-consumer, push-driven AsyncIterable for interactive SDK inputs. */

export interface PushableAsyncIterable<T> extends AsyncIterable<T> {
  readonly closed: boolean;
  /** False means the stream had already closed and did not accept the value. */
  push(value: T): boolean;
  /** Drain accepted values, then finish the consumer. */
  close(): void;
}

export function createPushableAsyncIterable<T>(): PushableAsyncIterable<T> {
  const values: T[] = [];
  const waiters: Array<(value: IteratorResult<T>) => void> = [];
  let closed = false;
  let taken = false;

  const stream: PushableAsyncIterable<T> = {
    get closed() {
      return closed;
    },
    push(value) {
      if (closed) return false;
      const waiter = waiters.shift();
      if (waiter) waiter({ done: false, value });
      else values.push(value);
      return true;
    },
    close() {
      if (closed) return;
      closed = true;
      if (values.length === 0) {
        for (const waiter of waiters.splice(0)) waiter({ done: true, value: undefined });
      }
    },
    [Symbol.asyncIterator]() {
      if (taken) throw new Error("a pushable async iterable has one consumer");
      taken = true;
      return {
        next: async () => {
          const value = values.shift();
          if (value !== undefined) return { done: false, value };
          if (closed) return { done: true, value: undefined };
          return new Promise<IteratorResult<T>>((resolve) => waiters.push(resolve));
        },
      };
    },
  };
  return stream;
}

