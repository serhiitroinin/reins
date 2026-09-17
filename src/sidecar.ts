/** In-process reference server for the versioned sidecar command protocol. */

import { discoverHarnessAdmission, type HarnessAdmissionIssue } from "./admission.js";
import type {
  HarnessContextContribution,
  HarnessPreparedContext,
  HarnessUnavailableContextSource,
} from "./context.js";
import {
  createHarness,
  HarnessAdapterError,
  HarnessRuntimeError,
  type HarnessAdapter,
  type HarnessDiagnostic,
  type HarnessFollowUpRequest,
  type HarnessPersistence,
  type HarnessRun,
  type HarnessRuntime,
  type HarnessRuntimeOptions,
} from "./runtime.js";
import type {
  HarnessInteractionResponse,
  HarnessRunRequest,
  HarnessSessionKey,
  HarnessSteeringStrategy,
} from "./protocol.js";
import type { HarnessDiscoveryRequest, HarnessRunSettings } from "./profile.js";
import {
  createJsonRpcPeer,
  type JsonRpcFailure,
  type JsonRpcId,
  type JsonRpcPeer,
  type JsonRpcRequestAnswer,
} from "./transports/json-rpc.js";
import type {
  HarnessToolDescriptor,
  HarnessToolHost,
  HarnessToolResult,
} from "./tools.js";
import {
  HARNESS_SIDECAR_HOST_METHODS,
  HARNESS_SIDECAR_ERROR_CODES,
  HARNESS_SIDECAR_METHODS,
  HARNESS_SIDECAR_NOTIFICATIONS,
  HARNESS_SIDECAR_PROTOCOL_VERSION,
  type HarnessSidecarAdapterParams,
  type HarnessSidecarDiscoveryParams,
  type HarnessSidecarEventsListParams,
  type HarnessSidecarFollowUpParams,
  type HarnessSidecarInitializeParams,
  type HarnessSidecarInitializeResult,
  type HarnessSidecarReplacementExecution,
  type HarnessSidecarRespondParams,
  type HarnessSidecarRunParams,
  type HarnessSidecarRunStartParams,
  type HarnessSidecarServerInfo,
  type HarnessSidecarSessionResetParams,
  type HarnessSidecarStopSubagentParams,
  type HarnessSidecarToolCallResult,
} from "./sidecar-protocol.js";
import {
  decodeHarnessRunRequest,
  HARNESS_WIRE_SCHEMA_VERSION,
  type HarnessJsonObject,
  type HarnessJsonValue,
  type HarnessWireRunRequest,
  type HarnessWireRunSettings,
} from "./wire.js";

const INVALID_PARAMS = HARNESS_SIDECAR_ERROR_CODES.invalidParams;
const METHOD_NOT_FOUND = HARNESS_SIDECAR_ERROR_CODES.methodNotFound;
const NOT_INITIALIZED = HARNESS_SIDECAR_ERROR_CODES.notInitialized;
const ALREADY_INITIALIZED = HARNESS_SIDECAR_ERROR_CODES.alreadyInitialized;
const RUN_NOT_FOUND = HARNESS_SIDECAR_ERROR_CODES.runNotFound;
const ADMISSION_FAILED = HARNESS_SIDECAR_ERROR_CODES.admissionFailed;
const RUNTIME_FAILED = HARNESS_SIDECAR_ERROR_CODES.runtimeFailed;
const SIDECAR_CLOSED = HARNESS_SIDECAR_ERROR_CODES.closed;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_ENTRIES = 10_000;
const MAX_JSON_STRING_LENGTH = 1_048_576;

type JsonRecord = Record<string, unknown>;

class SidecarRequestError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "SidecarRequestError";
  }
}

interface ActiveRun {
  run: HarnessRun;
  request: HarnessRunRequest;
  sessionBinding?: string;
  tools: readonly HarnessToolDescriptor[];
}

export interface HarnessSidecarOptions {
  adapters: readonly HarnessAdapter[];
  persistence: HarnessPersistence;
  write(line: string): void;
  server?: HarnessSidecarServerInfo;
  contextSources?: HarnessRuntimeOptions["contextSources"];
  onContextError?: HarnessRuntimeOptions["onContextError"];
  onDiagnostic?: HarnessRuntimeOptions["onDiagnostic"];
  onMalformedMessage?: (line: string) => void;
  createId?: () => string;
  now?: () => Date;
  maxBufferedChars?: number;
}

export interface HarnessSidecar {
  /** Feed one arbitrary text chunk from the transport into the server. */
  text(chunk: string): void;
  /** Settles after the runtime and every provider session have retired. */
  readonly closed: Promise<void>;
  /** End the transport and retire all provider sessions. */
  end(reason?: string): Promise<void>;
  /** Retire all provider sessions while leaving transport ownership to the host. */
  close(): Promise<void>;
}

function record(value: unknown, path = "params"): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SidecarRequestError(INVALID_PARAMS, `${path} must be an object`);
  }
  return value as JsonRecord;
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SidecarRequestError(INVALID_PARAMS, `${path} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, path: string): string | undefined {
  return value === undefined ? undefined : requiredString(value, path);
}

function optionalBoolean(value: unknown, path: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new SidecarRequestError(INVALID_PARAMS, `${path} must be a boolean`);
  return value;
}

function cloneJson(
  value: unknown,
  path: string,
  state: { entries: number },
  depth = 0,
  ancestors: Set<object> = new Set(),
): HarnessJsonValue {
  if (depth > MAX_JSON_DEPTH) throw new SidecarRequestError(INVALID_PARAMS, `${path} exceeds the JSON depth limit`);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.length > MAX_JSON_STRING_LENGTH) {
      throw new SidecarRequestError(INVALID_PARAMS, `${path} exceeds the JSON string limit`);
    }
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0)) return value;
  if (typeof value !== "object" || value === null) {
    throw new SidecarRequestError(INVALID_PARAMS, `${path} must contain only JSON values`);
  }
  if (ancestors.has(value)) throw new SidecarRequestError(INVALID_PARAMS, `${path} must not contain a cycle`);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Reflect.ownKeys(value).length !== value.length + 1) {
        throw new SidecarRequestError(INVALID_PARAMS, `${path} must not contain array holes or extra properties`);
      }
      state.entries += value.length;
      if (state.entries > MAX_JSON_ENTRIES) {
        throw new SidecarRequestError(INVALID_PARAMS, `${path} exceeds the JSON collection limit`);
      }
      return value.map((entry, index) => {
        if (!Object.hasOwn(value, index)) {
          throw new SidecarRequestError(INVALID_PARAMS, `${path} must not contain array holes or extra properties`);
        }
        return cloneJson(entry, `${path}[${index}]`, state, depth + 1, ancestors);
      });
    }
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new SidecarRequestError(INVALID_PARAMS, `${path} must contain only plain JSON objects`);
    }
    const keys = Reflect.ownKeys(value);
    state.entries += keys.length;
    if (state.entries > MAX_JSON_ENTRIES) {
      throw new SidecarRequestError(INVALID_PARAMS, `${path} exceeds the JSON collection limit`);
    }
    const result: Record<string, HarnessJsonValue> = {};
    for (const key of keys) {
      if (typeof key !== "string") {
        throw new SidecarRequestError(INVALID_PARAMS, `${path} must not contain symbol keys`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        throw new SidecarRequestError(INVALID_PARAMS, `${path}.${key} must be an enumerable data property`);
      }
      result[key] = cloneJson(descriptor.value, `${path}.${key}`, state, depth + 1, ancestors);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function jsonObject(value: unknown, path: string): HarnessJsonObject {
  const cloned = cloneJson(value, path, { entries: 0 });
  if (cloned === null || Array.isArray(cloned) || typeof cloned !== "object") {
    throw new SidecarRequestError(INVALID_PARAMS, `${path} must be a JSON object`);
  }
  return cloned as HarnessJsonObject;
}

function sessionKey(value: unknown, path = "params.session"): HarnessSessionKey {
  const source = record(value, path);
  return {
    tenantId: requiredString(source.tenantId, `${path}.tenantId`),
    actorId: requiredString(source.actorId, `${path}.actorId`),
    threadId: requiredString(source.threadId, `${path}.threadId`),
  };
}

function toolDescriptor(value: unknown, path: string): HarnessToolDescriptor {
  const source = record(value, path);
  const metadata = source.metadata === undefined ? undefined : jsonObject(source.metadata, `${path}.metadata`);
  return {
    name: requiredString(source.name, `${path}.name`),
    description: typeof source.description === "string"
      ? source.description
      : (() => { throw new SidecarRequestError(INVALID_PARAMS, `${path}.description must be a string`); })(),
    inputSchema: jsonObject(source.inputSchema, `${path}.inputSchema`),
    ...(metadata ? { metadata } : {}),
  };
}

function toolCatalog(value: unknown, path: string): readonly HarnessToolDescriptor[] {
  if (!Array.isArray(value)) throw new SidecarRequestError(INVALID_PARAMS, `${path} must be an array`);
  const names = new Set<string>();
  return value.map((entry, index) => {
    const descriptor = toolDescriptor(entry, `${path}[${index}]`);
    if (names.has(descriptor.name)) {
      throw new SidecarRequestError(INVALID_PARAMS, `${path} contains duplicate tool ${descriptor.name}`);
    }
    names.add(descriptor.name);
    return descriptor;
  });
}

function parseInitialize(value: unknown): HarnessSidecarInitializeParams {
  const source = record(value);
  if (source.protocolVersion !== HARNESS_SIDECAR_PROTOCOL_VERSION) {
    throw new SidecarRequestError(
      INVALID_PARAMS,
      `unsupported sidecar protocol version: ${String(source.protocolVersion)}`,
      { supported: [HARNESS_SIDECAR_PROTOCOL_VERSION] },
    );
  }
  const client = record(source.client, "params.client");
  const version = optionalString(client.version, "params.client.version");
  return {
    protocolVersion: HARNESS_SIDECAR_PROTOCOL_VERSION,
    client: {
      name: requiredString(client.name, "params.client.name"),
      ...(version ? { version } : {}),
    },
    ...(source.tools === undefined ? {} : { tools: toolCatalog(source.tools, "params.tools") }),
  };
}

function parseAdapter(value: unknown): HarnessSidecarAdapterParams {
  const source = record(value);
  return { adapterId: requiredString(source.adapterId, "params.adapterId") };
}

function parseDiscovery(value: unknown): HarnessSidecarDiscoveryParams {
  const source = record(value);
  if (source.schemaVersion !== HARNESS_WIRE_SCHEMA_VERSION) {
    throw new SidecarRequestError(INVALID_PARAMS, `unsupported wire schema version: ${String(source.schemaVersion)}`);
  }
  const accountId = optionalString(source.accountId, "params.accountId");
  const modelId = optionalString(source.modelId, "params.modelId");
  return {
    schemaVersion: HARNESS_WIRE_SCHEMA_VERSION,
    adapterId: requiredString(source.adapterId, "params.adapterId"),
    ...(accountId ? { accountId } : {}),
    ...(modelId ? { modelId } : {}),
  };
}

function parseWireRequest(value: unknown, path: string): HarnessRunRequest {
  const source = record(value, path);
  if (source.schemaVersion !== HARNESS_WIRE_SCHEMA_VERSION) {
    throw new SidecarRequestError(INVALID_PARAMS, `unsupported wire schema version: ${String(source.schemaVersion)}`);
  }
  sessionKey(source.session, `${path}.session`);
  requiredString(source.adapterId, `${path}.adapterId`);
  if (!Array.isArray(source.input)) throw new SidecarRequestError(INVALID_PARAMS, `${path}.input must be an array`);
  try {
    return decodeHarnessRunRequest(source as unknown as HarnessWireRunRequest);
  } catch (error) {
    throw new SidecarRequestError(
      INVALID_PARAMS,
      error instanceof Error ? `${path}: ${error.message}` : `${path} is invalid`,
    );
  }
}

const PARTIAL_SESSION: HarnessSessionKey = {
  tenantId: "sidecar",
  actorId: "sidecar",
  threadId: "sidecar",
};

function parseInput(
  value: unknown,
  inlineContext: unknown,
  path: string,
): Pick<HarnessRunRequest, "input" | "inlineContext"> {
  const decoded = parseWireRequest({
    schemaVersion: HARNESS_WIRE_SCHEMA_VERSION,
    session: PARTIAL_SESSION,
    adapterId: "sidecar:input",
    input: value,
    ...(inlineContext === undefined ? {} : { inlineContext }),
  }, path);
  return {
    input: decoded.input,
    ...(decoded.inlineContext ? { inlineContext: decoded.inlineContext } : {}),
  };
}

function preparedContext(value: unknown, path: string): HarnessPreparedContext<HarnessContextContribution> {
  const source = record(value, path);
  if (!Array.isArray(source.sources)) throw new SidecarRequestError(INVALID_PARAMS, `${path}.sources must be an array`);
  if (!Array.isArray(source.unavailable)) throw new SidecarRequestError(INVALID_PARAMS, `${path}.unavailable must be an array`);
  const ids = new Set<string>();
  const sources = source.sources.map((entry, index) => {
    const itemPath = `${path}.sources[${index}]`;
    const item = record(entry, itemPath);
    const sourceId = requiredString(item.sourceId, `${itemPath}.sourceId`);
    if (ids.has(sourceId)) throw new SidecarRequestError(INVALID_PARAMS, `${path} contains duplicate source ${sourceId}`);
    ids.add(sourceId);
    const contribution = record(item.value, `${itemPath}.value`);
    const content = parseInput(contribution.content, undefined, `${itemPath}.value.content`).input;
    if (contribution.instructions !== undefined && typeof contribution.instructions !== "string") {
      throw new SidecarRequestError(INVALID_PARAMS, `${itemPath}.value.instructions must be a string`);
    }
    return {
      sourceId,
      value: {
        content,
        ...(typeof contribution.instructions === "string" ? { instructions: contribution.instructions } : {}),
      },
    };
  });
  const unavailable = source.unavailable.map((entry, index): HarnessUnavailableContextSource => {
    const itemPath = `${path}.unavailable[${index}]`;
    const item = record(entry, itemPath);
    const sourceId = requiredString(item.sourceId, `${itemPath}.sourceId`);
    if (ids.has(sourceId)) throw new SidecarRequestError(INVALID_PARAMS, `${path} contains duplicate source ${sourceId}`);
    ids.add(sourceId);
    const retryable = optionalBoolean(item.retryable, `${itemPath}.retryable`);
    return {
      sourceId,
      code: requiredString(item.code, `${itemPath}.code`),
      message: typeof item.message === "string"
        ? item.message
        : (() => { throw new SidecarRequestError(INVALID_PARAMS, `${itemPath}.message must be a string`); })(),
      ...(retryable === undefined ? {} : { retryable }),
    };
  });
  return { sources, unavailable };
}

function parseRunStart(value: unknown): {
  request: HarnessRunRequest;
  runId?: string;
  turnId?: string;
  sessionBinding?: string;
  tools?: readonly HarnessToolDescriptor[];
  context?: HarnessPreparedContext<HarnessContextContribution>;
} {
  const source = record(value);
  const runId = optionalString(source.runId, "params.runId");
  const turnId = optionalString(source.turnId, "params.turnId");
  const sessionBinding = optionalString(source.sessionBinding, "params.sessionBinding");
  return {
    request: parseWireRequest(source.request, "params.request"),
    ...(runId ? { runId } : {}),
    ...(turnId ? { turnId } : {}),
    ...(sessionBinding ? { sessionBinding } : {}),
    ...(source.tools === undefined ? {} : { tools: toolCatalog(source.tools, "params.tools") }),
    ...(source.context === undefined ? {} : { context: preparedContext(source.context, "params.context") }),
  };
}

function parseSettings(value: unknown, path: string): HarnessRunSettings {
  const source = record(value, path);
  let permission;
  if (source.permission !== undefined) {
    const selected = record(source.permission, `${path}.permission`);
    const consentVersion = optionalString(selected.consentVersion, `${path}.permission.consentVersion`);
    permission = {
      modeId: requiredString(selected.modeId, `${path}.permission.modeId`),
      ...(consentVersion ? { consentVersion } : {}),
    };
  }
  const controls = source.controls === undefined
    ? undefined
    : jsonObject(source.controls, `${path}.controls`) as HarnessWireRunSettings["controls"];
  return {
    ...(permission ? { permission } : {}),
    ...(controls ? { controls } : {}),
  };
}

function parseReplacementExecution(value: unknown, path: string): HarnessSidecarReplacementExecution {
  const source = record(value, path);
  const accountId = optionalString(source.accountId, `${path}.accountId`);
  const model = optionalString(source.model, `${path}.model`);
  const effort = optionalString(source.effort, `${path}.effort`);
  const settings = source.settings === undefined ? undefined : parseSettings(source.settings, `${path}.settings`);
  const configuration = source.configuration === undefined
    ? undefined
    : jsonObject(source.configuration, `${path}.configuration`);
  return {
    ...(accountId ? { accountId } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(settings ? { settings } : {}),
    ...(configuration ? { configuration } : {}),
  };
}

function parseFollowUp(value: unknown): {
  runId: string;
  request: HarnessFollowUpRequest;
  strategy?: HarnessSteeringStrategy;
  replacement?: {
    runId?: string;
    turnId?: string;
    execution?: HarnessSidecarReplacementExecution;
    sessionBinding?: string;
    tools?: readonly HarnessToolDescriptor[];
    context?: HarnessPreparedContext<HarnessContextContribution>;
  };
} {
  const source = record(value);
  const input = parseInput(source.input, source.inlineContext, "params.input");
  let strategy: HarnessSteeringStrategy | undefined;
  if (source.strategy !== undefined) {
    if (source.strategy !== "same-turn" && source.strategy !== "replacement-turn") {
      throw new SidecarRequestError(INVALID_PARAMS, "params.strategy is invalid");
    }
    strategy = source.strategy;
  }
  const metadata = source.metadata === undefined ? undefined : jsonObject(source.metadata, "params.metadata");
  let replacement;
  if (source.replacement !== undefined) {
    const selected = record(source.replacement, "params.replacement");
    const runId = optionalString(selected.runId, "params.replacement.runId");
    const turnId = optionalString(selected.turnId, "params.replacement.turnId");
    const sessionBinding = optionalString(selected.sessionBinding, "params.replacement.sessionBinding");
    replacement = {
      ...(runId ? { runId } : {}),
      ...(turnId ? { turnId } : {}),
      ...(selected.execution === undefined
        ? {}
        : { execution: parseReplacementExecution(selected.execution, "params.replacement.execution") }),
      ...(sessionBinding ? { sessionBinding } : {}),
      ...(selected.tools === undefined
        ? {}
        : { tools: toolCatalog(selected.tools, "params.replacement.tools") }),
      ...(selected.context === undefined
        ? {}
        : { context: preparedContext(selected.context, "params.replacement.context") }),
    };
  }
  if (replacement && strategy === "same-turn") {
    throw new SidecarRequestError(INVALID_PARAMS, "replacement options require replacement-turn steering");
  }
  return {
    runId: requiredString(source.runId, "params.runId"),
    request: {
      expectedTurnId: requiredString(source.expectedTurnId, "params.expectedTurnId"),
      input: input.input,
      ...(input.inlineContext ? { inlineContext: input.inlineContext } : {}),
      ...(metadata ? { metadata } : {}),
    },
    ...(strategy ? { strategy } : {}),
    ...(replacement ? { replacement } : {}),
  };
}

function parseRun(value: unknown): HarnessSidecarRunParams {
  const source = record(value);
  return { runId: requiredString(source.runId, "params.runId") };
}

function interactionResponse(value: unknown, path: string): HarnessInteractionResponse {
  const source = record(value, path);
  const choiceId = optionalString(source.choiceId, `${path}.choiceId`);
  if (source.text !== undefined && typeof source.text !== "string") {
    throw new SidecarRequestError(INVALID_PARAMS, `${path}.text must be a string`);
  }
  let labels: string[] | undefined;
  if (source.labels !== undefined) {
    if (!Array.isArray(source.labels) || source.labels.some((label) => typeof label !== "string")) {
      throw new SidecarRequestError(INVALID_PARAMS, `${path}.labels must be an array of strings`);
    }
    labels = [...source.labels] as string[];
  }
  if (choiceId === undefined && source.text === undefined && labels === undefined) {
    throw new SidecarRequestError(INVALID_PARAMS, `${path} must contain an answer`);
  }
  return {
    ...(choiceId ? { choiceId } : {}),
    ...(typeof source.text === "string" ? { text: source.text } : {}),
    ...(labels ? { labels } : {}),
  };
}

function parseRespond(value: unknown): HarnessSidecarRespondParams {
  const source = record(value);
  return {
    runId: requiredString(source.runId, "params.runId"),
    interactionId: requiredString(source.interactionId, "params.interactionId"),
    response: interactionResponse(source.response, "params.response"),
  };
}

function parseStopSubagent(value: unknown): HarnessSidecarStopSubagentParams {
  const source = record(value);
  return {
    runId: requiredString(source.runId, "params.runId"),
    taskId: requiredString(source.taskId, "params.taskId"),
  };
}

function parseEventsList(value: unknown): HarnessSidecarEventsListParams {
  const source = record(value);
  if (source.after !== undefined && (!Number.isSafeInteger(source.after) || (source.after as number) < 0)) {
    throw new SidecarRequestError(INVALID_PARAMS, "params.after must be a non-negative safe integer");
  }
  return {
    session: sessionKey(source.session),
    adapterId: requiredString(source.adapterId, "params.adapterId"),
    ...(typeof source.after === "number" ? { after: source.after } : {}),
  };
}

function parseSessionReset(value: unknown): HarnessSidecarSessionResetParams {
  const source = record(value);
  return {
    session: sessionKey(source.session),
    adapterId: requiredString(source.adapterId, "params.adapterId"),
  };
}

function safeToolResult(value: unknown): HarnessToolResult {
  const source = record(value, "host tool result");
  if (!Array.isArray(source.content)) {
    throw new SidecarRequestError(INVALID_PARAMS, "host tool result.content must be an array");
  }
  const content = source.content.map((entry, index) => {
    const path = `host tool result.content[${index}]`;
    const item = record(entry, path);
    if (item.type === "text") {
      if (typeof item.text !== "string") throw new SidecarRequestError(INVALID_PARAMS, `${path}.text must be a string`);
      return { type: "text" as const, text: item.text };
    }
    if (item.type === "image") {
      if (typeof item.mediaType !== "string" || typeof item.data !== "string") {
        throw new SidecarRequestError(INVALID_PARAMS, `${path} is not a valid image result`);
      }
      return { type: "image" as const, mediaType: item.mediaType, data: item.data };
    }
    if (item.type === "resource") {
      const uri = requiredString(item.uri, `${path}.uri`);
      if (item.mediaType !== undefined && typeof item.mediaType !== "string") {
        throw new SidecarRequestError(INVALID_PARAMS, `${path}.mediaType must be a string`);
      }
      if (item.text !== undefined && typeof item.text !== "string") {
        throw new SidecarRequestError(INVALID_PARAMS, `${path}.text must be a string`);
      }
      return {
        type: "resource" as const,
        uri,
        ...(typeof item.mediaType === "string" ? { mediaType: item.mediaType } : {}),
        ...(typeof item.text === "string" ? { text: item.text } : {}),
      };
    }
    throw new SidecarRequestError(INVALID_PARAMS, `${path}.type is invalid`);
  });
  if (source.isError !== undefined && typeof source.isError !== "boolean") {
    throw new SidecarRequestError(INVALID_PARAMS, "host tool result.isError must be a boolean");
  }
  if (source.code !== undefined && typeof source.code !== "string") {
    throw new SidecarRequestError(INVALID_PARAMS, "host tool result.code must be a string");
  }
  const metadata = source.metadata === undefined ? undefined : jsonObject(source.metadata, "host tool result.metadata");
  return {
    content,
    ...(typeof source.isError === "boolean" ? { isError: source.isError } : {}),
    ...(typeof source.code === "string" ? { code: source.code } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

function discoveryRequest(params: HarnessSidecarDiscoveryParams): HarnessDiscoveryRequest {
  return {
    ...(params.accountId ? { accountId: params.accountId } : {}),
    ...(params.modelId ? { modelId: params.modelId } : {}),
  };
}

function replacementRequest(
  active: ActiveRun,
  followUp: HarnessFollowUpRequest,
  execution?: HarnessSidecarReplacementExecution,
): HarnessRunRequest {
  const { inlineContext: _inlineContext, ...base } = active.request;
  let selected: HarnessRunRequest = base;
  if (execution) {
    const {
      accountId: _accountId,
      model: _model,
      effort: _effort,
      settings: _settings,
      configuration: _configuration,
      ...stable
    } = base;
    selected = { ...stable, ...execution };
  }
  return {
    ...selected,
    input: followUp.input,
    ...(followUp.inlineContext ? { inlineContext: followUp.inlineContext } : {}),
    ...(followUp.metadata ? { metadata: followUp.metadata } : {}),
  };
}

function replacementExecution(request: HarnessRunRequest): HarnessSidecarReplacementExecution {
  return {
    ...(request.accountId !== undefined ? { accountId: request.accountId } : {}),
    ...(request.model !== undefined ? { model: request.model } : {}),
    ...(request.effort !== undefined ? { effort: request.effort } : {}),
    ...(request.settings !== undefined ? { settings: request.settings } : {}),
    ...(request.configuration !== undefined ? { configuration: request.configuration as HarnessJsonObject } : {}),
  };
}

function failedTool(code: string, message: string): HarnessToolResult {
  return { content: [{ type: "text", text: message }], isError: true, code };
}

function failure(error: unknown): JsonRpcFailure {
  if (error instanceof SidecarRequestError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.data === undefined ? {} : { data: error.data }),
    };
  }
  if (error instanceof HarnessRuntimeError) {
    return {
      code: RUNTIME_FAILED,
      message: error.message,
      data: { code: error.code },
    };
  }
  if (error instanceof HarnessAdapterError) {
    return {
      code: RUNTIME_FAILED,
      message: error.publicMessage,
      data: { code: error.code, retryable: error.retryable },
    };
  }
  return { code: RUNTIME_FAILED, message: "The harness command failed." };
}

function admissionFailure(issues: readonly HarnessAdmissionIssue[]): SidecarRequestError {
  return new SidecarRequestError(ADMISSION_FAILED, "The requested execution was not admitted.", { issues });
}

/**
 * Create a JSON-RPC server around the in-process runtime.
 *
 * The host owns bytes, process lifetime, credentials, persistence, provider
 * adapters, and tool policy. The sidecar owns admission, run identity,
 * lifecycle, streaming, cancellation, replay, and provider-neutral controls.
 */
export function createHarnessSidecar(options: HarnessSidecarOptions): HarnessSidecar {
  const adapterIds = options.adapters.map((adapter) => adapter.id);
  const createId = options.createId ?? (() => crypto.randomUUID());
  const active = new Map<string, ActiveRun>();
  const runTools = new Map<string, readonly HarnessToolDescriptor[]>();
  let defaultTools: readonly HarnessToolDescriptor[] = [];
  let initialized = false;
  let closed = false;
  let closing: Promise<void> | null = null;
  let resolveClosed!: () => void;
  let rejectClosed!: (error: unknown) => void;
  const closedPromise = new Promise<void>((resolve, reject) => {
    resolveClosed = resolve;
    rejectClosed = reject;
  });
  let peer: JsonRpcPeer | null = null;

  const toolHost: HarnessToolHost = {
    list(context) {
      return runTools.get(context.runId) ?? defaultTools;
    },
    async call(name, input, context) {
      if (!peer || closed || context.signal.aborted) return failedTool("TOOL_CANCELLED", `Tool cancelled: ${name}`);
      const callId = createId();
      let wireInput: HarnessJsonValue;
      try {
        wireInput = cloneJson(input, "tool input", { entries: 0 });
      } catch {
        return failedTool("TOOL_INPUT_INVALID", `Invalid input for tool: ${name}`);
      }
      const request = peer.request<HarnessSidecarToolCallResult>(HARNESS_SIDECAR_HOST_METHODS.toolCall, {
        protocolVersion: HARNESS_SIDECAR_PROTOCOL_VERSION,
        callId,
        session: context.session,
        adapterId: context.adapterId,
        runId: context.runId,
        turnId: context.turnId,
        name,
        input: wireInput,
      });
      let onAbort: (() => void) | undefined;
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => {
          peer?.notify(HARNESS_SIDECAR_NOTIFICATIONS.hostToolCancel, {
            callId,
            runId: context.runId,
            turnId: context.turnId,
          });
          reject(new SidecarRequestError(RUNTIME_FAILED, "remote tool call cancelled"));
        };
        context.signal.addEventListener("abort", onAbort, { once: true });
        if (context.signal.aborted) onAbort();
      });
      try {
        return safeToolResult(await Promise.race([request, aborted]));
      } catch {
        return context.signal.aborted
          ? failedTool("TOOL_CANCELLED", `Tool cancelled: ${name}`)
          : failedTool("TOOL_EXECUTION_FAILED", `Tool failed: ${name}`);
      } finally {
        if (onAbort) context.signal.removeEventListener("abort", onAbort);
      }
    },
  };

  const emitDiagnostic = (diagnostic: HarnessDiagnostic): void | Promise<void> => {
    const observed = options.onDiagnostic?.(diagnostic);
    if (initialized && !closed) peer?.notify(HARNESS_SIDECAR_NOTIFICATIONS.diagnostic, { diagnostic });
    return observed;
  };

  const runtime: HarnessRuntime = createHarness({
    adapters: options.adapters,
    persistence: options.persistence,
    tools: toolHost,
    ...(options.contextSources ? { contextSources: options.contextSources } : {}),
    ...(options.onContextError ? { onContextError: options.onContextError } : {}),
    onDiagnostic: emitDiagnostic,
    createId,
    ...(options.now ? { now: options.now } : {}),
  });

  const activeRun = (runId: string): ActiveRun => {
    const found = active.get(runId);
    if (!found) throw new SidecarRequestError(RUN_NOT_FOUND, "The requested run is not active.", { runId });
    return found;
  };

  const pump = (entry: ActiveRun): void => {
    active.set(entry.run.runId, entry);
    runTools.set(entry.run.runId, entry.tools);
    void (async () => {
      try {
        for await (const event of entry.run.events) {
          if (!closed) peer?.notify(HARNESS_SIDECAR_NOTIFICATIONS.event, { event });
        }
        const status = await entry.run.done;
        if (!closed) {
          peer?.notify(HARNESS_SIDECAR_NOTIFICATIONS.runSettled, {
            runId: entry.run.runId,
            turnId: entry.run.turnId,
            status,
          });
        }
      } finally {
        if (active.get(entry.run.runId)?.run === entry.run) active.delete(entry.run.runId);
        runTools.delete(entry.run.runId);
      }
    })();
  };

  const start = async (params: HarnessSidecarRunStartParams): Promise<{ runId: string; turnId: string }> => {
    const parsed = parseRunStart(params);
    const admitted = await discoverHarnessAdmission(runtime, parsed.request, {
      ...(parsed.sessionBinding ? { sessionBinding: parsed.sessionBinding } : {}),
    });
    if (!admitted.valid) throw admissionFailure(admitted.issues);
    const runId = parsed.runId ?? createId();
    const turnId = parsed.turnId ?? createId();
    if (active.has(runId)) throw new SidecarRequestError(INVALID_PARAMS, "params.runId is already active");
    const tools = parsed.tools ?? defaultTools;
    runTools.set(runId, tools);
    let run: HarnessRun;
    try {
      run = runtime.start(admitted.request, {
        runId,
        turnId,
        admission: admitted.admission,
        ...(parsed.context ? { context: parsed.context } : {}),
      });
    } catch (error) {
      runTools.delete(runId);
      throw error;
    }
    pump({
      run,
      request: admitted.request,
      ...(parsed.sessionBinding ? { sessionBinding: parsed.sessionBinding } : {}),
      tools,
    });
    return { runId: run.runId, turnId: run.turnId };
  };

  const followUp = async (params: HarnessSidecarFollowUpParams): Promise<{
    strategy: HarnessSteeringStrategy;
    runId: string;
    turnId: string;
  }> => {
    const parsed = parseFollowUp(params);
    const current = activeRun(parsed.runId);
    let strategy = parsed.strategy;
    if (parsed.replacement) strategy = "replacement-turn";
    if (!strategy) {
      const capabilities = await runtime.capabilities(current.request.adapterId);
      const supported = capabilities.steering?.support === "unsupported"
        ? []
        : capabilities.steering?.strategies ?? [];
      strategy = capabilities.steering?.preferred && supported.includes(capabilities.steering.preferred)
        ? capabilities.steering.preferred
        : supported[0];
    }
    if (!strategy) throw new SidecarRequestError(RUNTIME_FAILED, "This adapter cannot accept an active-turn follow-up.");

    if (strategy === "same-turn") {
      const result = await current.run.followUp(parsed.request, { strategy });
      return { strategy: result.strategy, runId: result.run.runId, turnId: result.run.turnId };
    }

    const replacement = parsed.replacement ?? {};
    const runId = replacement.runId ?? createId();
    const turnId = replacement.turnId ?? createId();
    if (active.has(runId)) throw new SidecarRequestError(INVALID_PARAMS, "params.replacement.runId is already active");
    let nextRequest = replacementRequest(current, parsed.request, replacement.execution);
    let admission;
    let execution;
    const sessionBinding = replacement.sessionBinding ?? current.sessionBinding;
    if (replacement.execution) {
      const admitted = await discoverHarnessAdmission(runtime, nextRequest, {
        ...(sessionBinding ? { sessionBinding } : {}),
      });
      if (!admitted.valid) throw admissionFailure(admitted.issues);
      nextRequest = admitted.request;
      admission = admitted.admission;
      execution = replacementExecution(admitted.request);
    }
    const tools = replacement.tools ?? current.tools;
    runTools.set(runId, tools);
    try {
      const result = await current.run.followUp(parsed.request, {
        strategy,
        replacement: {
          runId,
          turnId,
          ...(admission ? { admission } : {}),
          ...(execution ? { execution } : {}),
          ...(replacement.context ? { context: replacement.context } : {}),
        },
      });
      const entry: ActiveRun = {
        run: result.run,
        request: nextRequest,
        ...(sessionBinding ? { sessionBinding } : {}),
        tools,
      };
      pump(entry);
      return { strategy: result.strategy, runId: result.run.runId, turnId: result.run.turnId };
    } catch (error) {
      runTools.delete(runId);
      throw error;
    }
  };

  const commands = Object.values(HARNESS_SIDECAR_METHODS);
  const notifications = Object.values(HARNESS_SIDECAR_NOTIFICATIONS);
  const hostMethods = Object.values(HARNESS_SIDECAR_HOST_METHODS);

  const handle = async (method: string, params: unknown, _id: JsonRpcId): Promise<unknown> => {
    if (closed) throw new SidecarRequestError(SIDECAR_CLOSED, "The harness sidecar is closed.");
    if (method === HARNESS_SIDECAR_METHODS.initialize) {
      if (initialized) throw new SidecarRequestError(ALREADY_INITIALIZED, "The harness sidecar is already initialized.");
      const request = parseInitialize(params);
      defaultTools = request.tools ?? [];
      initialized = true;
      const result: HarnessSidecarInitializeResult = {
        protocolVersion: HARNESS_SIDECAR_PROTOCOL_VERSION,
        server: options.server ?? { name: "@serhiitroinin/fold-harness" },
        adapters: adapterIds,
        methods: commands,
        hostMethods,
        notifications,
      };
      return result;
    }
    if (!initialized) throw new SidecarRequestError(NOT_INITIALIZED, "Initialize the harness sidecar first.");

    switch (method) {
      case HARNESS_SIDECAR_METHODS.capabilities: {
        const request = parseAdapter(params);
        return runtime.capabilities(request.adapterId);
      }
      case HARNESS_SIDECAR_METHODS.profile: {
        const request = parseDiscovery(params);
        return runtime.profile(request.adapterId, discoveryRequest(request));
      }
      case HARNESS_SIDECAR_METHODS.models: {
        const request = parseDiscovery(params);
        return runtime.models(request.adapterId, discoveryRequest(request));
      }
      case HARNESS_SIDECAR_METHODS.limits: {
        const request = parseDiscovery(params);
        return runtime.limits(request.adapterId, discoveryRequest(request));
      }
      case HARNESS_SIDECAR_METHODS.runStart:
        return start(params as HarnessSidecarRunStartParams);
      case HARNESS_SIDECAR_METHODS.runFollowUp:
        return followUp(params as HarnessSidecarFollowUpParams);
      case HARNESS_SIDECAR_METHODS.runCancel: {
        const request = parseRun(params);
        await activeRun(request.runId).run.cancel();
        return {};
      }
      case HARNESS_SIDECAR_METHODS.runRespond: {
        const request = parseRespond(params);
        await activeRun(request.runId).run.respond(request.interactionId, request.response);
        return {};
      }
      case HARNESS_SIDECAR_METHODS.runStopSubagent: {
        const request = parseStopSubagent(params);
        return { stopped: await activeRun(request.runId).run.stopSubagent(request.taskId) };
      }
      case HARNESS_SIDECAR_METHODS.eventsList: {
        const request = parseEventsList(params);
        return {
          events: await options.persistence.events.list(request.session, request.adapterId, request.after),
        };
      }
      case HARNESS_SIDECAR_METHODS.sessionReset: {
        const request = parseSessionReset(params);
        await runtime.resetSession(request.session, request.adapterId);
        return {};
      }
      case HARNESS_SIDECAR_METHODS.shutdown:
        record(params ?? {}, "params");
        setTimeout(() => { void close().catch(() => undefined); }, 0);
        return {};
      default:
        throw new SidecarRequestError(METHOD_NOT_FOUND, `Unknown harness method: ${method}`);
    }
  };

  const answer = async (method: string, params: unknown, id: JsonRpcId): Promise<JsonRpcRequestAnswer> => {
    try {
      return { result: await handle(method, params, id) };
    } catch (error) {
      return { error: failure(error) };
    }
  };

  peer = createJsonRpcPeer({
    write: options.write,
    hooks: {
      request: answer,
      ...(options.onMalformedMessage ? { malformed: options.onMalformedMessage } : {}),
    },
    ...(options.maxBufferedChars === undefined ? {} : { maxBufferedChars: options.maxBufferedChars }),
  });

  const close = (): Promise<void> => {
    if (closing) return closing;
    closed = true;
    closing = runtime.close().then(
      () => {
        active.clear();
        runTools.clear();
        resolveClosed();
      },
      (error: unknown) => {
        active.clear();
        runTools.clear();
        rejectClosed(error);
        throw error;
      },
    );
    return closing;
  };

  return {
    closed: closedPromise,
    text(chunk) {
      peer?.text(chunk);
    },
    async end(reason) {
      peer?.end(reason);
      await close();
    },
    close,
  };
}
