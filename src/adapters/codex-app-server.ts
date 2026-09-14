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
import type {
  HarnessControl,
  HarnessModel,
  HarnessModelCatalog,
  HarnessRunSettings,
} from "../profile.js";

/** Public control id used to render and submit Codex speed tiers, including Fast. */
export const CODEX_SERVICE_TIER_CONTROL_ID = "openai:service-tier";

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

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function title(value: string): string {
  return value.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/**
 * Convert one `model/list` response into the provider-neutral catalog.
 * Pagination remains the adapter's responsibility; concatenate pages before
 * passing a response when the server supplies `nextCursor`.
 */
export function codexModelCatalog(response: unknown): HarnessModelCatalog {
  const data = record(response).data;
  const models: HarnessModel[] = [];
  if (!Array.isArray(data)) return { models };
  for (const entry of data) {
    const model = record(entry);
    const id = stringValue(model.id) ?? stringValue(model.model);
    if (!id) continue;
    const effortRows = Array.isArray(model.supportedReasoningEfforts)
      ? model.supportedReasoningEfforts
      : [];
    const effortOptions = effortRows.flatMap((row) => {
      const value = record(row);
      const effort = stringValue(value.reasoningEffort);
      return effort ? [{
        id: effort,
        label: title(effort),
        ...(stringValue(value.description) ? { description: stringValue(value.description)! } : {}),
      }] : [];
    });
    const tierRows = Array.isArray(model.serviceTiers) ? model.serviceTiers : [];
    const tierOptions = [{ id: "default", label: "Standard" }, ...tierRows.flatMap((row) => {
      const value = record(row);
      const tierId = stringValue(value.id);
      return tierId ? [{
        id: tierId,
        label: stringValue(value.name) ?? title(tierId),
        ...(stringValue(value.description) ? { description: stringValue(value.description)! } : {}),
      }] : [];
    })].filter((option, index, all) => all.findIndex(({ id: candidate }) => candidate === option.id) === index);
    const controls: HarnessControl[] = tierOptions.length > 1 ? [{
      id: CODEX_SERVICE_TIER_CONTROL_ID,
      label: "Speed",
      description: "Choose the service tier for this turn.",
      kind: "select",
      scope: "turn",
      options: tierOptions,
      defaultValue: stringValue(model.defaultServiceTier) ?? "default",
    }] : [];
    const modalities = Array.isArray(model.inputModalities)
      ? model.inputModalities.filter((value): value is string => typeof value === "string")
      : [];
    models.push({
      id,
      label: stringValue(model.displayName) ?? id,
      ...(stringValue(model.description) ? { description: stringValue(model.description)! } : {}),
      ...(model.hidden === true ? { hidden: true } : {}),
      ...(modalities.length > 0 ? { inputModalities: modalities } : {}),
      ...(effortOptions.length > 0 ? {
        effort: {
          options: effortOptions,
          ...(stringValue(model.defaultReasoningEffort)
            ? { defaultOptionId: stringValue(model.defaultReasoningEffort)! }
            : {}),
        },
      } : {}),
      ...(controls.length > 0 ? { controls } : {}),
    });
  }
  const defaultModel = data.find((entry) => record(entry).isDefault === true);
  const defaultModelId = defaultModel
    ? stringValue(record(defaultModel).id) ?? stringValue(record(defaultModel).model)
    : undefined;
  return { models, ...(defaultModelId ? { defaultModelId } : {}) };
}

/** Translate generic turn settings into the Codex App Server turn override. */
export function codexTurnSettingOverrides(settings?: HarnessRunSettings): {
  serviceTierForTurn?: string;
} {
  const value = settings?.controls?.[CODEX_SERVICE_TIER_CONTROL_ID];
  return typeof value === "string" ? { serviceTierForTurn: value } : {};
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
