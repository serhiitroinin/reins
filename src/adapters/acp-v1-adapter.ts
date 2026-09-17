/** Stable ACP v1 lifecycle composed over a host-injected byte transport. */

import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import type {
  HarnessDiscovery,
  HarnessDiscoveryRequest,
  HarnessLimitSnapshot,
} from "../profile.js";
import type {
  HarnessInteractionResponse,
  HarnessToolStatus,
  HarnessUsage,
} from "../protocol.js";
import {
  HarnessAdapterError,
  HarnessAdapterInterruptedError,
  type HarnessAdapter,
  type HarnessAdapterEvent,
  type HarnessAdapterRunRequest,
  type HarnessAdapterSession,
} from "../runtime.js";
import {
  ACP_V1_CAPABILITIES,
  ACP_V1_PROTOCOL_VERSION,
  ACP_V1_NAMESPACE,
  defaultAcpV1Profile,
  defaultAcpV1Prompt,
  type AcpV1AdapterOptions,
  type AcpV1ByteConnection,
  type AcpV1ConnectRequest,
  type AcpV1DeferredPermission,
  type AcpV1McpServer,
  type AcpV1NegotiatedAgent,
  type AcpV1PermissionAuthorization,
  type AcpV1PermissionDecision,
  type AcpV1PermissionRequest,
  type AcpV1PromptBlock,
  type AcpV1SessionConfigOption,
  type AcpV1SessionController,
  type AcpV1SessionModeState,
  type AcpV1SessionSetup,
  type AcpV1ToolPresentation,
  type AcpV1ToolSnapshot,
} from "./acp-v1.js";

class AdapterEventQueue implements AsyncIterable<HarnessAdapterEvent> {
  private readonly values: HarnessAdapterEvent[] = [];
  private readonly waiters: Array<{
    resolve(value: IteratorResult<HarnessAdapterEvent>): void;
    reject(error: unknown): void;
  }> = [];
  private closed = false;
  private failure: unknown;

  push(value: HarnessAdapterEvent): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ done: false, value });
    else this.values.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.values.length === 0) {
      for (const waiter of this.waiters.splice(0)) waiter.resolve({ done: true, value: undefined });
    }
  }

  fail(error: unknown): void {
    if (this.closed) return;
    this.failure = error;
    this.closed = true;
    if (this.values.length === 0) {
      for (const waiter of this.waiters.splice(0)) waiter.reject(error);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<HarnessAdapterEvent> {
    return {
      next: async () => {
        const value = this.values.shift();
        if (value !== undefined) return { done: false, value };
        if (this.failure !== undefined) throw this.failure;
        if (this.closed) return { done: true, value: undefined };
        return new Promise<IteratorResult<HarnessAdapterEvent>>((resolve, reject) => {
          this.waiters.push({ resolve, reject });
        });
      },
    };
  }
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function discovery<T>(
  source: HarnessDiscovery<T> | ((request: HarnessDiscoveryRequest) => Promise<HarnessDiscovery<T>> | HarnessDiscovery<T>) | undefined,
  request: HarnessDiscoveryRequest,
): Promise<HarnessDiscovery<T>> | HarnessDiscovery<T> {
  return typeof source === "function" ? source(request) : source ?? { status: "unsupported" };
}

function canonical(value: unknown, seen = new Set<object>()): string {
  if (value === null) return "null";
  if (typeof value === "string") return `string:${JSON.stringify(value)}`;
  if (typeof value === "boolean") return `boolean:${value}`;
  if (typeof value === "number") return `number:${Object.is(value, -0) ? "-0" : String(value)}`;
  if (typeof value === "bigint") return `bigint:${value}`;
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error("ACP connection identity must be serializable");
    seen.add(value);
    const output = `array:[${value.map((entry) => canonical(entry, seen)).join(",")}]`;
    seen.delete(value);
    return output;
  }
  if (typeof value === "object") {
    if (seen.has(value)) throw new Error("ACP connection identity must be serializable");
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("ACP connection identity must be serializable");
    }
    seen.add(value);
    const output = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key], seen)}`)
      .join(",");
    seen.delete(value);
    return `object:{${output}}`;
  }
  throw new Error("ACP connection identity must be serializable");
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function checkpointRequest(
  request: AcpV1ConnectRequest,
): Pick<AcpV1ConnectRequest, "session" | "accountId" | "runId" | "turnId"> {
  return {
    session: request.session,
    ...(request.accountId ? { accountId: request.accountId } : {}),
    runId: request.runId,
    turnId: request.turnId,
  };
}

function mapMcpServer(server: AcpV1McpServer): acp.McpServer {
  if ("url" in server) {
    return {
      type: server.type,
      name: server.name,
      url: server.url,
      headers: Object.entries(server.headers ?? {}).map(([name, value]) => ({ name, value })),
    };
  }
  return {
    name: server.name,
    command: server.command,
    args: [...(server.args ?? [])],
    env: Object.entries(server.env ?? {}).map(([name, value]) => ({ name, value })),
  };
}

function validateSetup(setup: AcpV1SessionSetup): void {
  if (!isAbsolute(setup.cwd)) {
    throw new HarnessAdapterError("ACP_INVALID_SESSION", "The ACP session requires an absolute working directory.");
  }
  for (const root of setup.additionalDirectories ?? []) {
    if (!isAbsolute(root)) {
      throw new HarnessAdapterError("ACP_INVALID_SESSION", "Every ACP workspace root must be an absolute path.");
    }
  }
  for (const server of setup.mcpServers ?? []) {
    if (server.name.trim() === "") {
      throw new HarnessAdapterError("ACP_INVALID_SESSION", "Every ACP MCP server requires a name.");
    }
    if ("url" in server) {
      let url: URL;
      try {
        url = new URL(server.url);
      } catch {
        throw new HarnessAdapterError("ACP_INVALID_SESSION", "An ACP MCP server URL is invalid.");
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new HarnessAdapterError("ACP_INVALID_SESSION", "An ACP MCP server URL must use HTTP or HTTPS.");
      }
    } else if (!isAbsolute(server.command)) {
      throw new HarnessAdapterError("ACP_INVALID_SESSION", "An ACP stdio MCP command must be an absolute path.");
    }
  }
}

function toPromptBlocks(blocks: readonly AcpV1PromptBlock[], imageSupported: boolean): acp.ContentBlock[] {
  if (blocks.length === 0) {
    throw new HarnessAdapterError("ACP_INVALID_PROMPT", "The ACP prompt cannot be empty.");
  }
  return blocks.map((block): acp.ContentBlock => {
    if (block.type === "text") return { type: "text", text: block.text };
    if (block.type === "image") {
      if (!imageSupported) {
        throw new HarnessAdapterError("ACP_IMAGE_UNSUPPORTED", "The connected ACP agent does not accept image prompts.");
      }
      return {
        type: "image",
        mimeType: block.mediaType,
        data: block.data,
        ...(block.uri ? { uri: block.uri } : {}),
      };
    }
    return {
      type: "resource_link",
      uri: block.uri,
      name: block.name,
      ...(block.mediaType ? { mimeType: block.mediaType } : {}),
    };
  });
}

function sessionModeState(value: acp.SessionModeState | null | undefined): AcpV1SessionModeState | null {
  if (!value) return null;
  return {
    currentModeId: value.currentModeId,
    availableModes: value.availableModes.map((mode) => ({
      id: mode.id,
      name: mode.name,
      ...(mode.description ? { description: mode.description } : {}),
    })),
  };
}

function sessionConfigOptions(values: readonly acp.SessionConfigOption[] | null | undefined): AcpV1SessionConfigOption[] {
  return (values ?? []).map((option): AcpV1SessionConfigOption => {
    const common = {
      id: option.id,
      name: option.name,
      ...(option.description ? { description: option.description } : {}),
      ...(option.category ? { category: option.category } : {}),
    };
    if (option.type === "boolean") return { ...common, type: "boolean", currentValue: option.currentValue };
    return {
      ...common,
      type: "select",
      currentValue: option.currentValue,
      options: option.options.flatMap((entry) => "group" in entry
        ? entry.options.map((value) => ({
            value: value.value,
            name: value.name,
            ...(value.description ? { description: value.description } : {}),
            group: { id: entry.group, name: entry.name },
          }))
        : [{
            value: entry.value,
            name: entry.name,
            ...(entry.description ? { description: entry.description } : {}),
          }]),
    };
  });
}

function toolSnapshot(
  phase: AcpV1ToolSnapshot["phase"],
  value: acp.ToolCall | acp.ToolCallUpdate,
): AcpV1ToolSnapshot {
  return {
    phase,
    toolCallId: value.toolCallId,
    ...(value.title ? { title: value.title } : {}),
    ...(value.kind ? { kind: value.kind } : {}),
    ...(value.status ? { status: value.status } : {}),
    ...(value.content ? { content: value.content } : {}),
    ...(value.locations ? { locations: value.locations } : {}),
    ...(value.rawInput !== undefined ? { rawInput: value.rawInput } : {}),
    ...(value.rawOutput !== undefined ? { rawOutput: value.rawOutput } : {}),
  };
}

function permissionRequest(value: acp.RequestPermissionRequest): AcpV1PermissionRequest {
  const snapshot = toolSnapshot("update", value.toolCall);
  const { phase: _phase, ...tool } = snapshot;
  return {
    sessionId: value.sessionId,
    tool,
    options: value.options.map((option) => ({
      id: option.optionId,
      name: option.name,
      kind: option.kind,
    })),
  };
}

function selectedPermission(
  decision: AcpV1PermissionDecision,
  offered: ReadonlySet<string>,
): acp.RequestPermissionResponse {
  if (decision.behavior === "cancel") return { outcome: { outcome: "cancelled" } };
  if (!offered.has(decision.optionId)) {
    throw new HarnessAdapterError("ACP_INVALID_PERMISSION_RESPONSE", "The ACP permission choice is no longer available.");
  }
  return { outcome: { outcome: "selected", optionId: decision.optionId } };
}

function publicFailure(options: AcpV1AdapterOptions, error: unknown): HarnessAdapterError | unknown {
  if (error instanceof HarnessAdapterError || error instanceof HarnessAdapterInterruptedError) return error;
  let mapped;
  try {
    mapped = options.publicError?.(error);
  } catch {
    return error;
  }
  return mapped ? new HarnessAdapterError(mapped.code, mapped.message, mapped.retryable === true) : error;
}

function bounded(value: string, limit: number): { value: string; truncated: boolean } {
  return value.length <= limit
    ? { value, truncated: false }
    : { value: `${value.slice(0, Math.max(0, limit - 1))}…`, truncated: true };
}

function boundedExtensions(
  value: Readonly<Record<string, unknown>> | undefined,
  limit: number,
): { value?: Readonly<Record<string, unknown>>; truncated: boolean } {
  if (!value) return { truncated: false };
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined || new TextEncoder().encode(encoded).byteLength > limit) {
      return { truncated: true };
    }
    const decoded: unknown = JSON.parse(encoded);
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
      return { truncated: true };
    }
    return { value: decoded as Readonly<Record<string, unknown>>, truncated: false };
  } catch {
    return { truncated: true };
  }
}

interface ToolState {
  title: string;
  kind: string;
  completed: boolean;
}

function presentTool(
  options: AcpV1AdapterOptions,
  snapshot: AcpV1ToolSnapshot,
  turn: HarnessAdapterRunRequest,
  limit: number,
  previous?: ToolState,
): { state: ToolState; event: HarnessAdapterEvent } {
  const presentation = options.presentTool?.(snapshot, turn);
  const title = bounded(presentation?.title ?? snapshot.title ?? previous?.title ?? "Agent tool", limit);
  const kind = bounded(presentation?.toolKind ?? snapshot.kind ?? previous?.kind ?? "other", limit);
  const state = { title: title.value, kind: kind.value, completed: snapshot.phase === "complete" };
  const displayed = toolPresentation(presentation, limit);
  if (snapshot.phase === "start") {
    return {
      state,
      event: {
        kind: "tool-started",
        toolId: snapshot.toolCallId,
        toolKind: kind.value,
        title: title.value,
        ...(displayed.detail ? { detail: displayed.detail } : {}),
        ...(displayed.command ? { command: displayed.command } : {}),
        ...(displayed.paths ? { paths: displayed.paths } : {}),
        ...(displayed.extensions ? { extensions: displayed.extensions } : {}),
      },
    };
  }
  if (snapshot.phase === "complete") {
    const status: HarnessToolStatus = snapshot.status === "failed" ? "failed" : "completed";
    return {
      state,
      event: {
        kind: "tool-completed",
        toolId: snapshot.toolCallId,
        status,
        toolKind: kind.value,
        title: title.value,
        ...(displayed.outputAppend ? { outputAppend: displayed.outputAppend } : {}),
        ...(displayed.error ? { error: displayed.error } : {}),
        ...(displayed.exitCode !== undefined ? { exitCode: displayed.exitCode } : {}),
        ...(displayed.truncated ? { truncated: true } : {}),
        ...(displayed.extensions ? { extensions: displayed.extensions } : {}),
      },
    };
  }
  return {
    state,
    event: {
      kind: "tool-updated",
      toolId: snapshot.toolCallId,
      toolKind: kind.value,
      title: title.value,
      ...(displayed.outputAppend ? { outputAppend: displayed.outputAppend } : {}),
      ...(displayed.detail ? { detail: displayed.detail } : {}),
      ...(displayed.truncated ? { truncated: true } : {}),
      ...(displayed.extensions ? { extensions: displayed.extensions } : {}),
    },
  };
}

function toolPresentation(
  value: AcpV1ToolPresentation | undefined,
  limit: number,
): AcpV1ToolPresentation {
  if (!value) return {};
  const detail = value.detail ? bounded(value.detail, limit) : undefined;
  const command = value.command ? bounded(value.command, limit) : undefined;
  const output = value.outputAppend ? bounded(value.outputAppend, limit) : undefined;
  const error = value.error ? bounded(value.error, limit) : undefined;
  const paths = value.paths?.slice(0, 32).map((path) => bounded(path, limit).value);
  const extensions = boundedExtensions(value.extensions, limit);
  return {
    ...(detail ? { detail: detail.value } : {}),
    ...(command ? { command: command.value } : {}),
    ...(paths && paths.length > 0 ? { paths } : {}),
    ...(output ? { outputAppend: output.value } : {}),
    ...(error ? { error: error.value } : {}),
    ...(value.exitCode !== undefined ? { exitCode: value.exitCode } : {}),
    ...(value.truncated || detail?.truncated || command?.truncated || output?.truncated || error?.truncated
      || extensions.truncated
      ? { truncated: true }
      : {}),
    ...(extensions.value ? { extensions: extensions.value } : {}),
  };
}

function usageDelta(current: acp.Usage, previous: acp.Usage | null): HarnessUsage | null {
  if (!previous) return null;
  const difference = (value: number, before: number): number | undefined => {
    const delta = value - before;
    return Number.isFinite(delta) && delta >= 0 ? delta : undefined;
  };
  const inputTokens = difference(current.inputTokens, previous.inputTokens);
  const outputTokens = difference(current.outputTokens, previous.outputTokens);
  const cachedInputTokens = difference(current.cachedReadTokens ?? 0, previous.cachedReadTokens ?? 0);
  const totalTokens = difference(current.totalTokens, previous.totalTokens);
  const usage: HarnessUsage = {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  };
  return Object.keys(usage).length > 0 ? usage : null;
}

interface PendingPermission {
  authorization: AcpV1DeferredPermission;
  offered: ReadonlySet<string>;
  response: ReturnType<typeof deferred<acp.RequestPermissionResponse>>;
  resolving: boolean;
  settled: boolean;
  turn: ActiveTurn;
}

interface ActiveTurn {
  request: HarnessAdapterRunRequest;
  queue: AdapterEventQueue;
  permissions: Set<string>;
  acceptUpdates: boolean;
  cancelled: boolean;
  providerSettled: ReturnType<typeof deferred<void>>;
  promptStarted: boolean;
  turnCostUsd: number;
  tools: Map<string, ToolState>;
  textChars: number;
  truncatedKinds: Set<"assistant-text" | "thinking" | "plan">;
}

export interface AcpV1AdapterSession extends HarnessAdapterSession {
  cancel(): Promise<void>;
  checkpoint(): string | null;
  close(): Promise<void>;
}

export interface AcpV1Adapter extends HarnessAdapter {
  open(request: {
    session: AcpV1ConnectRequest["session"];
    resumeToken: string | null;
    signal: AbortSignal;
    persistCheckpoint?(resumeToken: string | null): Promise<void>;
  }): Promise<AcpV1AdapterSession>;
}

/** Persisted session-id format shared by stable ACP v1 connections. */
export const ACP_V1_CHECKPOINT_FORMAT = "agent-client-protocol:session-id@1";

const ACP_V1_PERSISTED_EXTENSION_NAMES = new Set(["content-truncated", "stop-reason"]);

/** Compose a Harness adapter over the official stable ACP v1 protocol. */
export function createAcpV1Adapter(options: AcpV1AdapterOptions): AcpV1Adapter {
  const id = options.id ?? "acp";
  const cancelTimeoutMs = options.cancelTimeoutMs ?? 2_000;
  const eventTextLimit = options.eventTextLimit ?? 16_000;
  const turnTextLimit = options.turnTextLimit ?? 1_000_000;
  const planEntryLimit = options.planEntryLimit ?? 256;
  if (!Number.isFinite(cancelTimeoutMs) || cancelTimeoutMs < 1) {
    throw new Error("cancelTimeoutMs must be a positive number");
  }
  if (!Number.isSafeInteger(eventTextLimit) || eventTextLimit < 64) {
    throw new Error("eventTextLimit must be an integer of at least 64 characters");
  }
  if (!Number.isSafeInteger(turnTextLimit) || turnTextLimit < eventTextLimit) {
    throw new Error("turnTextLimit must be an integer at least as large as eventTextLimit");
  }
  if (!Number.isSafeInteger(planEntryLimit) || planEntryLimit < 1) {
    throw new Error("planEntryLimit must be a positive integer");
  }

  return {
    id,
    checkpoint: { format: ACP_V1_CHECKPOINT_FORMAT },
    persistence: {
      projectExtension: (event) => event.namespace === ACP_V1_NAMESPACE
        && ACP_V1_PERSISTED_EXTENSION_NAMES.has(event.name)
        ? event.payload
        : undefined,
      projectToolExtensions: (event) => event.extensions,
    },
    capabilities: () => options.capabilities ?? ACP_V1_CAPABILITIES,
    profile: (request) => discovery(options.profile ?? defaultAcpV1Profile(id), request),
    models: (request) => discovery(options.models, request),
    limits: (request) => options.limits
      ? discovery(options.limits, request)
      : { status: "unsupported" },

    async open({ session, resumeToken, persistCheckpoint }) {
      let checkpoint = resumeToken;
      let closed = false;
      let active: ActiveTurn | null = null;
      let permissionSequence = 0;
      let binding: string | null = null;
      let raw: AcpV1ByteConnection | null = null;
      let connection: acp.ClientConnection | null = null;
      let connecting: Promise<void> | null = null;
      let sessionId: string | null = resumeToken;
      let modes: AcpV1SessionModeState | null = null;
      let configOptions: AcpV1SessionConfigOption[] = [];
      let imageSupported = false;
      let previousUsage: acp.Usage | null = resumeToken ? null : {
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
      };
      let previousCostUsd: number | null = resumeToken ? null : 0;
      const lifetime = new AbortController();
      const pending = new Map<string, PendingPermission>();

      const closeTransport = async (error?: unknown): Promise<void> => {
        const sdk = connection;
        const provider = raw;
        connection = null;
        raw = null;
        sdk?.close(error);
        if (provider) await provider.close();
      };

      const settlePermission = (
        interactionId: string,
        item: PendingPermission,
        outcome: acp.RequestPermissionResponse,
        response: HarnessInteractionResponse,
      ): boolean => {
        if (item.settled) return false;
        item.settled = true;
        pending.delete(interactionId);
        item.turn.permissions.delete(interactionId);
        item.turn.queue.push({ kind: "interaction-resolved", interactionId, response });
        item.response.resolve(outcome);
        return true;
      };

      const invalidatePermission = (
        interactionId: string,
        item: PendingPermission,
      ): boolean => {
        if (item.settled) return false;
        item.settled = true;
        pending.delete(interactionId);
        item.turn.permissions.delete(interactionId);
        item.turn.queue.push({
          kind: "interaction-invalidated",
          interactionId,
          reason: "turn-ended",
        });
        item.response.resolve({ outcome: { outcome: "cancelled" } });
        return true;
      };

      const settlePermissions = (turn: ActiveTurn): void => {
        for (const interactionId of [...turn.permissions]) {
          const item = pending.get(interactionId);
          if (!item) continue;
          invalidatePermission(interactionId, item);
        }
      };

      const closeOpenTools = (turn: ActiveTurn, status: "failed" | "cancelled"): void => {
        for (const [toolId, tool] of turn.tools) {
          if (tool.completed) continue;
          tool.completed = true;
          turn.queue.push({
            kind: "tool-completed",
            toolId,
            status,
            toolKind: tool.kind,
            title: tool.title,
          });
        }
      };

      const noteTruncation = (
        turn: ActiveTurn,
        kind: "assistant-text" | "thinking" | "plan",
        limit: number,
      ): void => {
        if (turn.truncatedKinds.has(kind)) return;
        turn.truncatedKinds.add(kind);
        turn.queue.push({
          kind: "extension",
          namespace: ACP_V1_NAMESPACE,
          name: "content-truncated",
          payload: { kind, limit },
        });
      };

      const pushText = (
        turn: ActiveTurn,
        kind: "assistant-text" | "thinking",
        text: string,
      ): void => {
        const available = Math.max(0, turnTextLimit - turn.textChars);
        const retained = text.slice(0, available);
        turn.textChars += retained.length;
        for (let offset = 0; offset < retained.length; offset += eventTextLimit) {
          turn.queue.push({ kind, text: retained.slice(offset, offset + eventTextLimit) });
        }
        if (retained.length < text.length) noteTruncation(turn, kind, turnTextLimit);
      };

      const handlePermission = async (
        params: acp.RequestPermissionRequest,
      ): Promise<acp.RequestPermissionResponse> => {
        const turn = active;
        if (!turn || !turn.acceptUpdates || turn.cancelled || params.sessionId !== sessionId) {
          return { outcome: { outcome: "cancelled" } };
        }
        const request = permissionRequest(params);
        const offered = new Set(request.options.map((option) => option.id));
        if (offered.size !== request.options.length || [...offered].some((optionId) => optionId.trim() === "")) {
          throw new HarnessAdapterError("ACP_INVALID_PERMISSION", "The ACP agent supplied invalid permission options.");
        }
        let authorization: AcpV1PermissionAuthorization;
        if (options.authorizePermission) {
          authorization = await options.authorizePermission(request, turn.request);
        } else {
          const interactionId = `${id}:permission:${++permissionSequence}`;
          authorization = {
            behavior: "ask",
            interaction: {
              id: interactionId,
              kind: "permission",
              title: bounded(request.tool.title ?? "Allow agent tool?", eventTextLimit).value,
              choices: request.options.map((option) => ({
                id: option.id,
                label: bounded(option.name, eventTextLimit).value,
                allow: option.kind === "allow_once" || option.kind === "allow_always",
              })),
            },
            resolve: (response) => response.choiceId
              ? { behavior: "select", optionId: response.choiceId }
              : { behavior: "cancel" },
          };
        }
        if (turn.cancelled || !turn.acceptUpdates || active !== turn) {
          return { outcome: { outcome: "cancelled" } };
        }
        if (authorization.behavior !== "ask") return selectedPermission(authorization, offered);
        const interactionId = authorization.interaction.id;
        if (interactionId.trim() === "" || pending.has(interactionId)) {
          throw new HarnessAdapterError("ACP_INVALID_PERMISSION", "The ACP permission interaction identifier is invalid.");
        }
        const response = deferred<acp.RequestPermissionResponse>();
        pending.set(interactionId, {
          authorization,
          offered,
          response,
          resolving: false,
          settled: false,
          turn,
        });
        turn.permissions.add(interactionId);
        turn.queue.push({ kind: "interaction-requested", interaction: authorization.interaction });
        return response.promise;
      };

      const handleUsageUpdate = (update: acp.UsageUpdate, turn: ActiveTurn): void => {
        const contextLimit = {
          id: "acp:context-window",
          label: "Context window",
          kind: "context" as const,
          scope: "turn" as const,
          unit: "tokens",
          used: update.used,
          remaining: Math.max(0, update.size - update.used),
          limit: update.size,
          ...(update.size > 0 ? { usedPercent: (update.used / update.size) * 100 } : {}),
        };
        const limits: HarnessLimitSnapshot["limits"][number][] = [contextLimit];
        if (update.cost && Number.isFinite(update.cost.amount)) {
          limits.push({
            id: "acp:session-cost",
            label: "Session cost",
            kind: "spend",
            scope: "account",
            unit: update.cost.currency,
            used: update.cost.amount,
          });
          if (update.cost.currency.toUpperCase() === "USD") {
            if (previousCostUsd !== null) {
              const delta = update.cost.amount - previousCostUsd;
              if (Number.isFinite(delta) && delta >= 0) turn.turnCostUsd += delta;
            }
            previousCostUsd = update.cost.amount;
          }
        }
        const snapshot = { limits } satisfies HarnessLimitSnapshot;
        options.onLimits?.(snapshot, checkpointRequest({
          ...turn.request,
          resumeToken: checkpoint,
          signal: lifetime.signal,
        }));
      };

      const handleUpdate = (notification: acp.SessionNotification): void => {
        const turn = active;
        if (!turn || !turn.acceptUpdates || turn.cancelled || notification.sessionId !== sessionId) return;
        const update = notification.update;
        if (update.sessionUpdate === "agent_message_chunk") {
          if (update.content.type === "text") pushText(turn, "assistant-text", update.content.text);
          return;
        }
        if (update.sessionUpdate === "agent_thought_chunk") {
          if (update.content.type === "text") pushText(turn, "thinking", update.content.text);
          return;
        }
        if (update.sessionUpdate === "plan") {
          const entries = update.entries.slice(0, planEntryLimit);
          turn.queue.push({
            kind: "plan-updated",
            steps: entries.map((entry) => ({
              text: bounded(entry.content, eventTextLimit).value,
              status: bounded(entry.status, eventTextLimit).value,
            })),
          });
          if (entries.length < update.entries.length
            || entries.some((entry) => entry.content.length > eventTextLimit || entry.status.length > eventTextLimit)) {
            noteTruncation(turn, "plan", planEntryLimit);
          }
          return;
        }
        if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
          const existing = turn.tools.get(update.toolCallId);
          if (existing?.completed) return;
          if (!existing) {
            const started = presentTool(options, toolSnapshot("start", update), turn.request, eventTextLimit);
            turn.tools.set(update.toolCallId, started.state);
            turn.queue.push(started.event);
          }
          const current = turn.tools.get(update.toolCallId);
          if (update.status === "completed" || update.status === "failed") {
            const completed = presentTool(options, toolSnapshot("complete", update), turn.request, eventTextLimit, current);
            turn.tools.set(update.toolCallId, completed.state);
            turn.queue.push(completed.event);
          } else if (update.sessionUpdate === "tool_call_update") {
            const changed = presentTool(options, toolSnapshot("update", update), turn.request, eventTextLimit, current);
            turn.tools.set(update.toolCallId, changed.state);
            turn.queue.push(changed.event);
          }
          return;
        }
        if (update.sessionUpdate === "usage_update") {
          handleUsageUpdate(update, turn);
          return;
        }
        if (update.sessionUpdate === "current_mode_update") {
          if (modes) modes = { ...modes, currentModeId: update.currentModeId };
          return;
        }
        if (update.sessionUpdate === "config_option_update") {
          configOptions = sessionConfigOptions(update.configOptions);
        }
      };

      const ensureConnected = async (
        request: HarnessAdapterRunRequest,
        setup: AcpV1SessionSetup,
      ): Promise<void> => {
        if (connection && sessionId) return;
        if (connecting) return connecting;
        const connectRequest: AcpV1ConnectRequest = {
          session,
          resumeToken: checkpoint,
          runId: request.runId,
          turnId: request.turnId,
          ...(request.model ? { model: request.model } : {}),
          ...(request.effort ? { effort: request.effort } : {}),
          ...(request.accountId ? { accountId: request.accountId } : {}),
          ...(request.settings ? { settings: request.settings } : {}),
          ...(request.configuration ? { configuration: request.configuration } : {}),
          signal: lifetime.signal,
        };
        connecting = (async () => {
          let created: AcpV1ByteConnection | null = null;
          try {
            const providerPromise = Promise.resolve().then(() => options.connect(connectRequest));
            let abandoned = false;
            let rejectAbort!: (error: HarnessAdapterInterruptedError) => void;
            const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
            const abort = (): void => rejectAbort(new HarnessAdapterInterruptedError());
            if (request.signal.aborted || lifetime.signal.aborted) abort();
            else {
              request.signal.addEventListener("abort", abort, { once: true });
              lifetime.signal.addEventListener("abort", abort, { once: true });
            }
            void providerPromise.then((provider) => {
              if (abandoned || closed || request.signal.aborted) {
                void Promise.resolve(provider.close()).catch(() => undefined);
              }
            }, () => undefined);
            let providerConnection: AcpV1ByteConnection;
            try {
              providerConnection = await Promise.race([providerPromise, aborted]);
            } catch (error) {
              abandoned = true;
              throw error;
            } finally {
              request.signal.removeEventListener("abort", abort);
              lifetime.signal.removeEventListener("abort", abort);
            }
            let providerClosed = false;
            created = {
              readable: providerConnection.readable,
              writable: providerConnection.writable,
              async close() {
                if (providerClosed) return;
                providerClosed = true;
                await providerConnection.close();
              },
            };
            if (closed || request.signal.aborted) {
              await created.close();
              throw new HarnessAdapterInterruptedError();
            }
            raw = created;
            const app = acp.client({ name: options.clientInfo?.name ?? "fold-harness" })
              .onRequest(acp.methods.client.session.requestPermission, ({ params }) => handlePermission(params))
              .onNotification(acp.methods.client.session.update, ({ params }) => { handleUpdate(params); });
            const sdk = app.connect(acp.ndJsonStream(created.writable, created.readable));
            connection = sdk;
            void sdk.closed.then(() => {
              const wasCurrent = connection === sdk;
              if (wasCurrent) connection = null;
              if (raw === created) raw = null;
              void created?.close();
              const turn = active;
              if (wasCurrent && turn && !turn.cancelled) {
                turn.queue.fail(sdk.signal.reason ?? new Error("ACP connection closed"));
              }
            });
            const initialized = await sdk.agent.request(acp.methods.agent.initialize, {
              protocolVersion: ACP_V1_PROTOCOL_VERSION,
              clientCapabilities: {},
              clientInfo: {
                name: options.clientInfo?.name ?? "fold-harness",
                version: options.clientInfo?.version ?? "0.1.0",
                ...(options.clientInfo?.title ? { title: options.clientInfo.title } : {}),
              },
            });
            if (initialized.protocolVersion !== ACP_V1_PROTOCOL_VERSION) {
              throw new HarnessAdapterError(
                "ACP_PROTOCOL_VERSION_UNSUPPORTED",
                `The ACP agent selected unsupported protocol version ${initialized.protocolVersion}.`,
              );
            }
            const agentCapabilities = initialized.agentCapabilities;
            imageSupported = agentCapabilities?.promptCapabilities?.image === true;
            const negotiated: AcpV1NegotiatedAgent = {
              protocolVersion: ACP_V1_PROTOCOL_VERSION,
              ...(initialized.agentInfo ? {
                agentInfo: {
                  name: initialized.agentInfo.name,
                  version: initialized.agentInfo.version,
                  ...(initialized.agentInfo.title ? { title: initialized.agentInfo.title } : {}),
                },
              } : {}),
              capabilities: {
                loadSession: agentCapabilities?.loadSession === true,
                imagePrompt: imageSupported,
                additionalDirectories: agentCapabilities?.sessionCapabilities?.additionalDirectories != null,
                mcp: {
                  stdio: true,
                  http: agentCapabilities?.mcpCapabilities?.http === true,
                  sse: agentCapabilities?.mcpCapabilities?.sse === true,
                },
              },
            };
            if ((setup.additionalDirectories?.length ?? 0) > 0 && !negotiated.capabilities.additionalDirectories) {
              throw new HarnessAdapterError(
                "ACP_ADDITIONAL_DIRECTORIES_UNSUPPORTED",
                "The connected ACP agent does not accept additional workspace roots.",
              );
            }
            for (const server of setup.mcpServers ?? []) {
              if (server.type === "http" && !negotiated.capabilities.mcp.http) {
                throw new HarnessAdapterError("ACP_MCP_UNSUPPORTED", "The connected ACP agent does not accept HTTP MCP servers.");
              }
              if (server.type === "sse" && !negotiated.capabilities.mcp.sse) {
                throw new HarnessAdapterError("ACP_MCP_UNSUPPORTED", "The connected ACP agent does not accept SSE MCP servers.");
              }
            }
            await options.onNegotiated?.(negotiated, checkpointRequest(connectRequest));
            const sessionRequest = {
              cwd: setup.cwd,
              ...(setup.additionalDirectories ? { additionalDirectories: [...setup.additionalDirectories] } : {}),
              mcpServers: (setup.mcpServers ?? []).map(mapMcpServer),
            };
            if (checkpoint) {
              if (!negotiated.capabilities.loadSession) {
                throw new HarnessAdapterError(
                  "ACP_RESUME_UNSUPPORTED",
                  "The connected ACP agent cannot restore this saved session.",
                );
              }
              const loaded = await sdk.agent.request(acp.methods.agent.session.load, {
                ...sessionRequest,
                sessionId: checkpoint,
              });
              sessionId = checkpoint;
              modes = sessionModeState(loaded.modes);
              configOptions = sessionConfigOptions(loaded.configOptions);
              previousUsage = null;
              previousCostUsd = null;
            } else {
              const createdSession = await sdk.agent.request<acp.NewSessionResponse, acp.NewSessionRequest>(
                acp.methods.agent.session.new,
                sessionRequest,
              );
              sessionId = createdSession.sessionId;
              checkpoint = createdSession.sessionId;
              modes = sessionModeState(createdSession.modes);
              configOptions = sessionConfigOptions(createdSession.configOptions);
              await persistCheckpoint?.(createdSession.sessionId);
              await options.onCheckpoint?.(createdSession.sessionId, checkpointRequest(connectRequest));
            }
          } catch (error) {
            if (created && raw !== created) await Promise.resolve(created.close()).catch(() => undefined);
            await closeTransport().catch(() => undefined);
            throw publicFailure(options, error);
          } finally {
            connecting = null;
          }
        })();
        return connecting;
      };

      const controller = (): AcpV1SessionController => ({
        get sessionId() { return sessionId ?? ""; },
        get modes() {
          return modes ? {
            currentModeId: modes.currentModeId,
            availableModes: modes.availableModes.map((mode) => ({ ...mode })),
          } : null;
        },
        get configOptions() {
          return configOptions.map((option) => option.type === "boolean"
            ? { ...option }
            : {
                ...option,
                options: option.options.map((value) => ({
                  ...value,
                  ...(value.group ? { group: { ...value.group } } : {}),
                })),
              });
        },
        async setMode(modeId) {
          if (!connection || !sessionId || !modes?.availableModes.some((mode) => mode.id === modeId)) {
            throw new HarnessAdapterError("ACP_INVALID_MODE", "The selected ACP session mode is unavailable.");
          }
          await connection.agent.request(acp.methods.agent.session.setMode, { sessionId, modeId });
          modes = { ...modes, currentModeId: modeId };
        },
        async setConfigOption(configId, value) {
          if (!connection || !sessionId) throw new HarnessAdapterError("ACP_SESSION_CLOSED", "The ACP session is closed.");
          const option = configOptions.find((entry) => entry.id === configId);
          const valid = option?.type === "boolean"
            ? typeof value === "boolean"
            : option?.type === "select"
              ? typeof value === "string" && option.options.some((entry) => entry.value === value)
              : false;
          if (!valid || !option) {
            throw new HarnessAdapterError("ACP_INVALID_CONFIG_OPTION", "The selected ACP configuration value is unavailable.");
          }
          const result = await connection.agent.request(acp.methods.agent.session.setConfigOption, option.type === "boolean"
            ? { sessionId, configId, type: "boolean", value: value as boolean }
            : { sessionId, configId, value: value as string });
          configOptions = sessionConfigOptions(result.configOptions);
        },
      });

      return {
        async *run(request) {
          if (closed) throw new HarnessAdapterInterruptedError();
          if (active) throw new HarnessAdapterError("ACP_SESSION_BUSY", "The ACP session already has a running turn.");
          const setup = await options.session(request);
          validateSetup(setup);
          const key = digest({
            accountId: request.accountId ?? null,
            setup,
            connection: options.connectionKey
              ? options.connectionKey(request)
              : {
                  configuration: request.configuration ?? null,
                  ...(options.configureSession ? {} : {
                    model: request.model ?? null,
                    effort: request.effort ?? null,
                    settings: request.settings ?? null,
                  }),
                },
          });
          if (binding !== null && binding !== key) {
            throw new HarnessAdapterError(
              "ACP_CONNECTION_CHANGED",
              "This turn requires a different ACP process or session configuration.",
            );
          }
          binding ??= key;
          const turn: ActiveTurn = {
            request,
            queue: new AdapterEventQueue(),
            permissions: new Set(),
            acceptUpdates: false,
            cancelled: false,
            providerSettled: deferred<void>(),
            promptStarted: false,
            turnCostUsd: 0,
            tools: new Map(),
            textChars: 0,
            truncatedKinds: new Set(),
          };
          active = turn;
          try {
            let blocks: readonly AcpV1PromptBlock[];
            try {
              blocks = options.mapPrompt
                ? await options.mapPrompt(request)
                : defaultAcpV1Prompt(request.input, request.context, request.inlineContext);
            } catch (error) {
              if (error instanceof Error && error.message === "ACP_CONTEXT_MAPPING_REQUIRED") {
                throw new HarnessAdapterError(
                  "ACP_CONTEXT_MAPPING_REQUIRED",
                  "The host must map prepared context into ACP prompt blocks explicitly.",
                );
              }
              throw error;
            }
            await ensureConnected(request, setup);
            if (request.signal.aborted || turn.cancelled) throw new HarnessAdapterInterruptedError();
            await options.configureSession?.(controller(), request);
            if (!connection || !sessionId) throw new Error("ACP connection did not create a session");
            turn.acceptUpdates = true;
            const prompt = connection.agent.request(acp.methods.agent.session.prompt, {
              sessionId,
              prompt: toPromptBlocks(blocks, imageSupported),
            });
            turn.promptStarted = true;
            void prompt.then(
              (response) => {
                turn.acceptUpdates = false;
                settlePermissions(turn);
                closeOpenTools(turn, response.stopReason === "cancelled" ? "cancelled" : "failed");
                turn.providerSettled.resolve();
                turn.queue.close();
              },
              (error) => {
                turn.acceptUpdates = false;
                settlePermissions(turn);
                closeOpenTools(turn, turn.cancelled ? "cancelled" : "failed");
                turn.providerSettled.resolve();
                turn.queue.fail(error);
              },
            );
            for await (const event of turn.queue) yield event;
            const response = await prompt;
            if (response.stopReason === "cancelled" || turn.cancelled || request.signal.aborted) {
              throw new HarnessAdapterInterruptedError();
            }
            if (response.usage) {
              const usage = usageDelta(response.usage, previousUsage);
              previousUsage = response.usage;
              if (usage || turn.turnCostUsd > 0) {
                yield {
                  kind: "usage",
                  usage: {
                    ...(usage ?? {}),
                    ...(turn.turnCostUsd > 0 ? { costUsd: turn.turnCostUsd } : {}),
                  },
                };
              }
            } else if (turn.turnCostUsd > 0) {
              yield { kind: "usage", usage: { costUsd: turn.turnCostUsd } };
            }
            if (response.stopReason !== "end_turn") {
              yield {
                kind: "extension",
                namespace: ACP_V1_NAMESPACE,
                name: "stop-reason",
                payload: { reason: response.stopReason },
              };
            }
          } catch (error) {
            if (turn.cancelled || request.signal.aborted) throw new HarnessAdapterInterruptedError();
            throw publicFailure(options, error);
          } finally {
            settlePermissions(turn);
            if (active === turn) active = null;
          }
        },

        async respond(interactionId: string, response: HarnessInteractionResponse): Promise<void> {
          const item = pending.get(interactionId);
          if (!item || item.resolving || item.turn !== active || item.turn.cancelled) {
            throw new HarnessAdapterError("INTERACTION_NOT_ACTIVE", "The ACP permission request is no longer open.");
          }
          item.resolving = true;
          let decision: AcpV1PermissionDecision;
          try {
            decision = await item.authorization.resolve(response);
            if (item.settled || item.turn.cancelled || item.turn !== active) {
              throw new HarnessAdapterError("INTERACTION_NOT_ACTIVE", "The ACP permission request is no longer open.");
            }
            const outcome = selectedPermission(decision, item.offered);
            settlePermission(interactionId, item, outcome, response);
          } catch (error) {
            if (!item.settled) item.resolving = false;
            throw error;
          }
        },

        async cancel(): Promise<void> {
          const turn = active;
          if (!turn || turn.cancelled) return;
          turn.cancelled = true;
          settlePermissions(turn);
          if (connection && sessionId) {
            await connection.agent.notify(acp.methods.agent.session.cancel, { sessionId }).catch(() => undefined);
          }
          if (!turn.promptStarted) {
            await closeTransport(new HarnessAdapterInterruptedError()).catch(() => undefined);
            return;
          }
          let timer: ReturnType<typeof setTimeout> | undefined;
          const outcome = await Promise.race([
            turn.providerSettled.promise.then(() => "settled" as const),
            new Promise<"timeout">((resolve) => {
              timer = setTimeout(() => resolve("timeout"), cancelTimeoutMs);
            }),
          ]);
          if (timer) clearTimeout(timer);
          // ACP updates identify only the session, not the prompt that
          // produced them. Retire every cancelled transport before another
          // turn can load the same session so a delayed update from the old
          // prompt cannot be attributed to its replacement.
          await closeTransport(new HarnessAdapterInterruptedError()).catch(() => undefined);
        },

        checkpoint: () => checkpoint,

        async close(): Promise<void> {
          if (closed) return;
          closed = true;
          lifetime.abort();
          if (active) {
            active.cancelled = true;
            settlePermissions(active);
          }
          await closeTransport(new HarnessAdapterInterruptedError()).catch(() => undefined);
          const pendingConnection = connecting;
          if (pendingConnection) await pendingConnection.catch(() => undefined);
        },
      };
    },
  };
}
