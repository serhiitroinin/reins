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
import type { HarnessToolDescriptor } from "../tools.js";

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

function field(value: Record<string, unknown>, camel: string, snake: string): unknown {
  return value[camel] ?? value[snake];
}

/**
 * Convert one `model/list` response into the provider-neutral catalog.
 * Pagination remains the adapter's responsibility; concatenate pages before
 * passing a response when the server supplies `nextCursor`.
 */
export function codexModelCatalog(response: unknown): HarnessModelCatalog {
  const envelope = record(response);
  const data = envelope.data ?? envelope.models;
  const models: HarnessModel[] = [];
  if (!Array.isArray(data)) return { models };
  for (const entry of data) {
    const model = record(entry);
    const id = stringValue(model.id) ?? stringValue(model.model) ?? stringValue(model.slug);
    if (!id) continue;
    const rawEfforts = field(model, "supportedReasoningEfforts", "supported_reasoning_levels");
    const effortRows = Array.isArray(rawEfforts)
      ? rawEfforts
      : [];
    const effortOptions = effortRows.flatMap((row) => {
      const value = record(row);
      const effort = stringValue(field(value, "reasoningEffort", "effort"));
      return effort ? [{
        id: effort,
        label: title(effort),
        ...(stringValue(value.description) ? { description: stringValue(value.description)! } : {}),
      }] : [];
    });
    const rawTiers = field(model, "serviceTiers", "service_tiers");
    const tierRows = Array.isArray(rawTiers) ? rawTiers : [];
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
      defaultValue: stringValue(field(model, "defaultServiceTier", "default_service_tier")) ?? "default",
    }] : [];
    const rawModalities = field(model, "inputModalities", "input_modalities");
    const modalities = Array.isArray(rawModalities)
      ? rawModalities.filter((value): value is string => typeof value === "string")
      : [];
    models.push({
      id,
      label: stringValue(field(model, "displayName", "display_name")) ?? id,
      ...(stringValue(model.description) ? { description: stringValue(model.description)! } : {}),
      ...(model.hidden === true || (typeof model.visibility === "string" && model.visibility !== "list")
        ? { hidden: true }
        : {}),
      ...(modalities.length > 0 ? { inputModalities: modalities } : {}),
      ...(effortOptions.length > 0 ? {
        effort: {
          options: effortOptions,
          ...(stringValue(field(model, "defaultReasoningEffort", "default_reasoning_level"))
            ? { defaultOptionId: stringValue(field(model, "defaultReasoningEffort", "default_reasoning_level"))! }
            : {}),
        },
      } : {}),
      ...(controls.length > 0 ? { controls } : {}),
    });
  }
  models.sort((left, right) => {
    const leftRaw = data.find((entry) => {
      const value = record(entry);
      return (stringValue(value.id) ?? stringValue(value.model) ?? stringValue(value.slug)) === left.id;
    });
    const rightRaw = data.find((entry) => {
      const value = record(entry);
      return (stringValue(value.id) ?? stringValue(value.model) ?? stringValue(value.slug)) === right.id;
    });
    const leftPriority = record(leftRaw).priority;
    const rightPriority = record(rightRaw).priority;
    return (typeof leftPriority === "number" ? leftPriority : Number.MAX_SAFE_INTEGER)
      - (typeof rightPriority === "number" ? rightPriority : Number.MAX_SAFE_INTEGER);
  });
  const defaultModel = data.find((entry) => record(entry).isDefault === true);
  const defaultModelId = defaultModel
    ? stringValue(record(defaultModel).id) ?? stringValue(record(defaultModel).model) ?? stringValue(record(defaultModel).slug)
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

export interface CodexAppServerClientInfo {
  name: string;
  title?: string;
  version: string;
}

export interface CodexInitializeOptions {
  clientInfo: CodexAppServerClientInfo;
  experimentalApi?: boolean;
  requestAttestation?: boolean;
  optOutNotificationMethods?: readonly string[] | null;
}

/** Build `initialize` without assigning a product identity or experimental behavior. */
export function codexInitializeParams(options: CodexInitializeOptions): Record<string, unknown> {
  return {
    clientInfo: options.clientInfo,
    capabilities: {
      experimentalApi: options.experimentalApi ?? false,
      requestAttestation: options.requestAttestation ?? false,
      optOutNotificationMethods: options.optOutNotificationMethods ?? null,
    },
  };
}

export interface CodexThreadOptions {
  cwd: string;
  sandbox: string;
  approvalPolicy: string;
  model?: string;
  dynamicTools?: readonly CodexDynamicToolSpec[];
}

export interface CodexDynamicToolSpec {
  type: "function";
  name: string;
  description: string;
  inputSchema: Readonly<Record<string, unknown>>;
  deferLoading: boolean;
}

/** Expose one turn tool catalog through the App Server dynamic-tool protocol. */
export function codexDynamicTools(tools: readonly HarnessToolDescriptor[]): CodexDynamicToolSpec[] {
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    deferLoading: false,
  }));
}

/** Serialize explicit host policy into a Codex `thread/start` request. */
export function codexThreadStartParams(options: CodexThreadOptions): Record<string, unknown> {
  return {
    cwd: options.cwd,
    sandbox: options.sandbox,
    approvalPolicy: options.approvalPolicy,
    ...(options.model ? { model: options.model } : {}),
    ...(options.dynamicTools ? { dynamicTools: options.dynamicTools } : {}),
  };
}

export interface CodexThreadResumeOptions extends CodexThreadOptions {
  threadId: string;
  excludeTurns: boolean;
}

/** Serialize explicit host policy into a Codex `thread/resume` request. */
export function codexThreadResumeParams(options: CodexThreadResumeOptions): Record<string, unknown> {
  return {
    threadId: options.threadId,
    excludeTurns: options.excludeTurns,
    cwd: options.cwd,
    sandbox: options.sandbox,
    approvalPolicy: options.approvalPolicy,
    ...(options.model ? { model: options.model } : {}),
  };
}

export interface CodexTurnOptions {
  threadId: string;
  prompt: string;
  effort?: string;
  imageFiles?: readonly string[];
  settings?: HarnessRunSettings;
}

/** Serialize a provider-neutral turn, including adapter-owned control translation. */
export function codexTurnStartParams(options: CodexTurnOptions): Record<string, unknown> {
  return {
    threadId: options.threadId,
    input: [
      { type: "text", text: options.prompt, text_elements: [] },
      ...(options.imageFiles ?? []).map((path) => ({ type: "localImage", path })),
    ],
    ...(options.effort ? { effort: options.effort } : {}),
    ...codexTurnSettingOverrides(options.settings),
  };
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
