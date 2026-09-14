/** A transport-agnostic JSON-RPC 2.0 peer over newline-delimited messages. */

import { createNdjsonReader } from "./ndjson.js";

export type JsonRpcId = string | number;

export interface JsonRpcFailure {
  code: number;
  message: string;
  data?: unknown;
}

export type JsonRpcRequestAnswer =
  | { result: unknown }
  | { error: JsonRpcFailure };

export interface JsonRpcHooks {
  notification?(method: string, params: unknown): void;
  request?(method: string, params: unknown, id: JsonRpcId): JsonRpcRequestAnswer | Promise<JsonRpcRequestAnswer>;
  malformed?(line: string): void;
}

export interface JsonRpcPeer {
  text(chunk: string): void;
  end(reason?: string): void;
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  notify(method: string, params?: unknown): void;
}

export interface JsonRpcPeerOptions {
  write(line: string): void;
  hooks?: JsonRpcHooks;
  maxBufferedChars?: number;
  unhandledRequest?: JsonRpcFailure;
}

export class JsonRpcError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(`${method}: ${message}`);
    this.name = "JsonRpcError";
  }
}

interface Pending {
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

const UNHANDLED_REQUEST = { code: -32601, message: "this client does not implement server requests" };

export function createJsonRpcPeer(options: JsonRpcPeerOptions): JsonRpcPeer {
  const waiting = new Map<number, Pending>();
  let nextId = 0;
  let closed: string | null = null;

  const send = (message: unknown): void => options.write(`${JSON.stringify(message)}\n`);
  const answerRequest = async (method: string, params: unknown, id: JsonRpcId): Promise<void> => {
    let answer: JsonRpcRequestAnswer;
    try {
      answer = options.hooks?.request
        ? await options.hooks.request(method, params, id)
        : { error: options.unhandledRequest ?? UNHANDLED_REQUEST };
    } catch (error) {
      answer = {
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : "the client request handler failed",
        },
      };
    }
    if (closed !== null) return;
    send("error" in answer
      ? { jsonrpc: "2.0", id, error: answer.error }
      : { jsonrpc: "2.0", id, result: answer.result });
  };

  const reader = createNdjsonReader((message) => {
    const id = typeof message.id === "string" || typeof message.id === "number" ? message.id : null;
    const method = typeof message.method === "string" ? message.method : "";
    if (id !== null && method !== "") {
      void answerRequest(method, message.params, id);
      return;
    }
    if (id !== null) {
      const pending = typeof id === "number" ? waiting.get(id) : undefined;
      if (!pending) return;
      waiting.delete(id as number);
      const failure = message.error;
      if (typeof failure === "object" && failure !== null && !Array.isArray(failure)) {
        const error = failure as { code?: unknown; message?: unknown; data?: unknown };
        pending.reject(new JsonRpcError(
          pending.method,
          typeof error.code === "number" ? error.code : 0,
          typeof error.message === "string" ? error.message : "the peer refused the call",
          error.data,
        ));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (method !== "") options.hooks?.notification?.(method, message.params);
  }, {
    ...(options.maxBufferedChars === undefined ? {} : { maxBufferedChars: options.maxBufferedChars }),
    ...(options.hooks?.malformed === undefined ? {} : { onMalformed: options.hooks.malformed }),
  });

  return {
    text: (chunk) => reader.text(chunk),
    end(reason = "the JSON-RPC peer ended") {
      if (closed !== null) return;
      reader.end();
      closed = reason;
      for (const pending of waiting.values()) pending.reject(new Error(reason));
      waiting.clear();
    },
    request<T>(method: string, params?: unknown): Promise<T> {
      if (closed !== null) return Promise.reject(new Error(closed));
      const id = ++nextId;
      return new Promise<T>((resolve, reject) => {
        waiting.set(id, { method, resolve: (value) => resolve(value as T), reject });
        send(params === undefined
          ? { jsonrpc: "2.0", id, method }
          : { jsonrpc: "2.0", id, method, params });
      });
    },
    notify(method, params) {
      if (closed !== null) return;
      send(params === undefined
        ? { jsonrpc: "2.0", method }
        : { jsonrpc: "2.0", method, params });
    },
  };
}
