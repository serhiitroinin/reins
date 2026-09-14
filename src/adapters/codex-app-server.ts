/**
 * Typed lifecycle calls for a Codex App Server JSON-RPC connection.
 *
 * Process creation, environment construction, policy, and event projection
 * remain host responsibilities. This client owns only the wire conversation.
 */

import {
  createJsonRpcPeer,
  type JsonRpcFailure,
  type JsonRpcPeer,
  type JsonRpcRequestAnswer,
} from "../transports/json-rpc.js";

export interface CodexAppServerHooks {
  notification(method: string, params: Record<string, unknown>): void;
  request?(method: string, params: unknown): JsonRpcRequestAnswer | Promise<JsonRpcRequestAnswer>;
  malformed?(line: string): void;
}

export interface CodexAppServerClient {
  text(chunk: string): void;
  end(reason?: string): void;
  request(method: string, params?: unknown): Promise<Record<string, unknown>>;
  notify(method: string, params?: unknown): void;
  initialize(params: unknown): Promise<Record<string, unknown>>;
  initialized(): void;
  startThread(params: unknown): Promise<Record<string, unknown>>;
  resumeThread(params: unknown): Promise<Record<string, unknown>>;
  startTurn(params: unknown): Promise<Record<string, unknown>>;
  interruptTurn(params: unknown): Promise<Record<string, unknown>>;
}

export interface CodexAppServerClientOptions {
  write(line: string): void;
  hooks: CodexAppServerHooks;
  unhandledRequest?: JsonRpcFailure;
  maxBufferedChars?: number;
}

const CODEX_UNHANDLED_REQUEST = {
  code: -32601,
  message: "this client answers no request",
} as const;

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function createCodexAppServerClient(options: CodexAppServerClientOptions): CodexAppServerClient {
  const peer: JsonRpcPeer = createJsonRpcPeer({
    write: options.write,
    hooks: {
      notification: (method, params) => options.hooks.notification(method, record(params)),
      ...(options.hooks.request
        ? { request: (method: string, params: unknown) => options.hooks.request!(method, params) }
        : {}),
      ...(options.hooks.malformed ? { malformed: options.hooks.malformed } : {}),
    },
    unhandledRequest: options.unhandledRequest ?? CODEX_UNHANDLED_REQUEST,
    ...(options.maxBufferedChars === undefined ? {} : { maxBufferedChars: options.maxBufferedChars }),
  });

  const request = async (method: string, params?: unknown): Promise<Record<string, unknown>> =>
    record(await peer.request(method, params));

  return {
    text: peer.text,
    end: peer.end,
    request,
    notify: peer.notify,
    initialize: (params) => request("initialize", params),
    initialized: () => peer.notify("initialized"),
    startThread: (params) => request("thread/start", params),
    resumeThread: (params) => request("thread/resume", params),
    startTurn: (params) => request("turn/start", params),
    interruptTurn: (params) => request("turn/interrupt", params),
  };
}

export interface OpenCodexTurnOptions {
  client: CodexAppServerClient;
  initialize: unknown;
  thread: { mode: "start"; params: unknown } | { mode: "resume"; params: unknown };
  turn(threadId: string): unknown;
}

/** Complete the handshake and return only after Codex accepts the turn. */
export async function openCodexTurn(options: OpenCodexTurnOptions): Promise<string> {
  await options.client.initialize(options.initialize);
  options.client.initialized();
  const opened = options.thread.mode === "start"
    ? await options.client.startThread(options.thread.params)
    : await options.client.resumeThread(options.thread.params);
  const thread = opened.thread as { id?: unknown } | undefined;
  const threadId = typeof thread?.id === "string" ? thread.id : "";
  if (threadId === "") throw new Error("the codex app server named no thread");
  await options.client.startTurn(options.turn(threadId));
  return threadId;
}

