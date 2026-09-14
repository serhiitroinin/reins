/**
 * Stateful normalization of Codex App Server notifications.
 *
 * This module deliberately accepts unknown records rather than exporting the
 * App Server's generated SDK types. Products receive the stable harness event,
 * limit, and turn-outcome contracts; SDK drift remains inside this adapter.
 */

import type { HarnessAdapterEvent } from "../runtime.js";
import type { HarnessLimit, HarnessLimitSnapshot } from "../profile.js";
import type { HarnessToolStatus, HarnessTurnStatus, HarnessUsage } from "../protocol.js";

export const CODEX_ASSISTANT_TEXT_CHUNK_CHARS = 240;
export const CODEX_EVENT_CONTENT_CHUNK_CHARS = 4_000;
export const CODEX_TOOL_OUTPUT_MAX_CHARS = 32_000;

export type CodexToolInput =
  | { id: string; kind: "command"; command: string }
  | { id: string; kind: "mcp"; server: string; name: string; input: unknown }
  | { id: string; kind: "dynamic"; namespace?: string; name: string; input: unknown }
  | { id: string; kind: "file-change"; paths: readonly string[] }
  | { id: string; kind: "web-search"; query: string };

export interface CodexToolPresentation {
  toolKind: string;
  title: string;
  detail?: string;
  command?: string;
  paths?: readonly string[];
  extensions?: Readonly<Record<string, unknown>>;
}

export interface CodexPublicErrorInput {
  code?: string;
  message?: string;
}

export interface CodexPublicError {
  code: string;
  message: string;
  retryable?: boolean;
}

export interface CodexAppServerTurnOutcome {
  status: HarnessTurnStatus;
  usage: HarnessUsage;
}

export interface CodexAppServerEventConsumer {
  notification(method: string, params: Record<string, unknown>): void;
  /**
   * Flush a transport that ended before Codex sent `turn/completed`.
   * This closes open tool rows but does not invent a provider turn outcome.
   */
  end(openToolStatus?: HarnessToolStatus): void;
}

export interface CodexAppServerEventConsumerOptions {
  emit(event: HarnessAdapterEvent): void;
  onTurnEnded?(outcome: CodexAppServerTurnOutcome): void;
  onLimits?(snapshot: HarnessLimitSnapshot): void;
  /** Replace generic tool labels and redact any product-sensitive summary. */
  presentTool?(tool: CodexToolInput): CodexToolPresentation | null;
  /** Redact or replace a tool result before it enters the harness event log. */
  redactToolOutput?(tool: CodexToolInput, output: string): string;
  /** Raw provider failures are hidden unless the host explicitly maps them. */
  publicError?(error: CodexPublicErrorInput): CodexPublicError;
  assistantTextChunkChars?: number;
  /** Chunk size for whole messages, reasoning, and tool output. */
  eventContentChunkChars?: number;
  toolOutputMaxChars?: number;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function field(value: Record<string, unknown> | null, camel: string, snake: string): unknown {
  return value?.[camel] ?? value?.[snake];
}

function clip(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  let end = maximum;
  const code = value.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff && end > 1) end -= 1;
  return value.slice(0, end);
}

function chunks(value: string, maximum: number): string[] {
  if (value === "") return [];
  const output: string[] = [];
  let at = 0;
  while (at < value.length) {
    let end = Math.min(at + maximum, value.length);
    const code = value.charCodeAt(end - 1);
    if (end < value.length && code >= 0xd800 && code <= 0xdbff && end - 1 > at) end -= 1;
    output.push(value.slice(at, end));
    at = end;
  }
  return output;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 2) {
    throw new Error(`${name} must be an integer greater than one`);
  }
  return resolved;
}

function title(value: string): string {
  return value
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(" ");
}

function windowLabel(minutes: number | undefined, fallback: string): string {
  if (minutes === 300) return "5-hour";
  if (minutes === 10_080) return "Weekly";
  if (minutes !== undefined && minutes % 1_440 === 0) return `${minutes / 1_440}-day`;
  if (minutes !== undefined && minutes % 60 === 0) return `${minutes / 60}-hour`;
  if (minutes !== undefined) return `${minutes}-minute`;
  return title(fallback);
}

function isoSeconds(value: unknown): string | undefined {
  const seconds = finite(value);
  if (seconds === undefined) return undefined;
  const date = new Date(seconds * 1_000);
  return Number.isNaN(date.valueOf()) ? undefined : date.toISOString();
}

function decimal(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : undefined;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/** Convert one App Server rate-limit snapshot without retaining its wire type. */
export function codexLimitSnapshot(value: unknown): HarnessLimitSnapshot | null {
  const snapshot = record(value);
  if (snapshot === null) return null;
  const limitId = text(field(snapshot, "limitId", "limit_id")) || "codex";
  const limitName = text(field(snapshot, "limitName", "limit_name"));
  const normalModel = text(field(snapshot, "normalModelSlug", "normal_model_slug"));
  const planType = text(field(snapshot, "planType", "plan_type"));
  const limits: HarnessLimit[] = [];

  for (const windowId of ["primary", "secondary"] as const) {
    const window = record(snapshot[windowId]);
    if (window === null) continue;
    const usedPercent = finite(field(window, "usedPercent", "used_percent"));
    if (usedPercent === undefined) continue;
    const minutes = finite(field(window, "windowDurationMins", "window_minutes"));
    const resetsAt = isoSeconds(field(window, "resetsAt", "resets_at"));
    limits.push({
      id: `${limitId}:${windowId}`,
      label: limitName || windowLabel(minutes, windowId),
      kind: "rate",
      scope: normalModel ? "model" : "account",
      unit: "%",
      usedPercent,
      ...(resetsAt ? { resetsAt } : {}),
      ...(minutes !== undefined ? { windowDurationMs: minutes * 60_000 } : {}),
      ...(normalModel ? { modelIds: [normalModel] } : {}),
    });
  }

  const credits = record(snapshot.credits);
  if (credits !== null) {
    const balance = decimal(credits.balance);
    limits.push({
      id: `${limitId}:credits`,
      label: "Credits",
      kind: "credits",
      scope: "account",
      unit: "credits",
      ...(balance !== undefined ? { remaining: balance } : {}),
      extensions: {
        "openai:has-credits": credits.hasCredits === true || credits.has_credits === true,
        "openai:unlimited": credits.unlimited === true,
      },
    });
  }

  const spend = record(field(snapshot, "individualLimit", "individual_limit"));
  if (spend !== null) {
    const maximum = decimal(spend.limit);
    const used = decimal(spend.used);
    const remainingPercent = finite(field(spend, "remainingPercent", "remaining_percent"));
    const resetsAt = isoSeconds(field(spend, "resetsAt", "resets_at"));
    limits.push({
      id: `${limitId}:spend`,
      label: "Spend",
      kind: "spend",
      scope: "account",
      unit: "currency",
      ...(maximum !== undefined ? { limit: maximum } : {}),
      ...(used !== undefined ? { used } : {}),
      ...(remainingPercent !== undefined ? { usedPercent: Math.max(0, 100 - remainingPercent) } : {}),
      ...(resetsAt ? { resetsAt } : {}),
    });
  }

  if (limits.length === 0 && planType === "") return null;
  const reached = text(field(snapshot, "rateLimitReachedType", "rate_limit_reached_type"));
  const spendReached = field(snapshot, "spendControlReached", "spend_control_reached");
  return {
    ...(planType ? { planLabel: title(planType) } : {}),
    limits,
    ...((reached || typeof spendReached === "boolean") ? {
      extensions: {
        ...(reached ? { "openai:rate-limit-reached": reached } : {}),
        ...(typeof spendReached === "boolean" ? { "openai:spend-control-reached": spendReached } : {}),
      },
    } : {}),
  };
}

function toolInput(value: unknown): CodexToolInput | null {
  const item = record(value);
  if (item === null) return null;
  const id = text(item.id);
  if (item.type === "commandExecution") {
    return { id, kind: "command", command: text(item.command) };
  }
  if (item.type === "mcpToolCall") {
    return {
      id,
      kind: "mcp",
      server: text(item.server),
      name: text(item.tool),
      input: item.arguments,
    };
  }
  if (item.type === "dynamicToolCall") {
    const namespace = text(item.namespace);
    return {
      id,
      kind: "dynamic",
      ...(namespace ? { namespace } : {}),
      name: text(item.tool),
      input: item.arguments,
    };
  }
  if (item.type === "fileChange") {
    const paths = (Array.isArray(item.changes) ? item.changes : []).flatMap((entry) => {
      const path = text(record(entry)?.path);
      return path ? [path] : [];
    });
    return { id, kind: "file-change", paths: [...new Set(paths)] };
  }
  if (item.type === "webSearch") {
    return { id, kind: "web-search", query: text(item.query) };
  }
  return null;
}

function defaultToolPresentation(tool: CodexToolInput): CodexToolPresentation {
  if (tool.kind === "command") {
    return {
      toolKind: "command",
      title: tool.command || "Command",
      ...(tool.command ? { command: tool.command } : {}),
    };
  }
  if (tool.kind === "mcp") {
    const name = [tool.server, tool.name].filter(Boolean).join("/");
    return { toolKind: "mcp", title: name || "MCP tool" };
  }
  if (tool.kind === "dynamic") {
    const name = [tool.namespace, tool.name].filter(Boolean).join("/");
    return { toolKind: "tool", title: name || "Tool" };
  }
  if (tool.kind === "file-change") {
    return {
      toolKind: "file-change",
      title: tool.paths[0] ?? "File change",
      ...(tool.paths.length > 0 ? { paths: tool.paths } : {}),
    };
  }
  return {
    toolKind: "web-search",
    title: tool.query || "Web search",
    ...(tool.query ? { detail: tool.query } : {}),
  };
}

function resultText(value: unknown): string {
  if (typeof value === "string") return value;
  const shape = record(value);
  const content = shape === null ? value : shape.content;
  if (!Array.isArray(content)) return shape === null ? "" : JSON.stringify(shape);
  const parts: string[] = [];
  for (const entry of content) {
    const block = record(entry);
    if ((block?.type === "text" || block?.type === "inputText") && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("\n");
}

function toolOutput(item: Record<string, unknown>, tool: CodexToolInput): string {
  if (tool.kind === "command") return text(item.aggregatedOutput);
  if (tool.kind === "dynamic") return resultText(item.contentItems);
  if (tool.kind !== "mcp") return "";
  const failure = record(item.error);
  if (failure !== null) return text(failure.message) || "The tool call failed.";
  return resultText(item.result);
}

function toolOutcome(item: Record<string, unknown>): { status: HarnessToolStatus; exitCode?: number } {
  const status = text(item.status);
  const exitCode = typeof item.exitCode === "number" && Number.isInteger(item.exitCode)
    ? item.exitCode
    : undefined;
  const failed = status === "failed" || status === "error" || item.success === false
    || (exitCode !== undefined && exitCode !== 0);
  const normalized: HarnessToolStatus = status === "declined"
    ? "declined"
    : status === "cancelled" || status === "canceled"
      ? "cancelled"
      : failed
        ? "failed"
        : "completed";
  return { status: normalized, ...(exitCode !== undefined ? { exitCode } : {}) };
}

function reasoningText(item: Record<string, unknown>): string {
  const summary = Array.isArray(item.summary) ? item.summary.map(text).filter(Boolean) : [];
  const content = Array.isArray(item.content) ? item.content.map(text).filter(Boolean) : [];
  return (summary.length > 0 ? summary : content).join("\n\n");
}

function planSteps(value: unknown): readonly { text: string; status: string }[] {
  return (Array.isArray(value) ? value : []).flatMap((entry) => {
    const row = record(entry);
    const body = text(row?.step) || text(row?.text) || text(row?.content);
    if (!body) return [];
    const status = text(row?.status);
    return [{
      text: body,
      status: row?.completed === true || status === "completed"
        ? "done"
        : status === "inProgress" || status === "in_progress"
          ? "active"
          : "pending",
    }];
  });
}

function publicErrorInput(value: unknown): CodexPublicErrorInput {
  const error = record(value);
  const code = text(error?.code);
  const message = text(error?.message);
  return {
    ...(code ? { code } : {}),
    ...(message ? { message } : {}),
  };
}

function defaultPublicError(): CodexPublicError {
  return { code: "CODEX_PROVIDER_ERROR", message: "Codex could not complete the turn." };
}

function usageTracker(): { update(value: unknown): void; value(): HarnessUsage } {
  let baseInput: number | undefined;
  let baseOutput: number | undefined;
  let baseCached: number | undefined;
  let input: number | undefined;
  let output: number | undefined;
  let cached: number | undefined;
  return {
    update(value) {
      const usage = record(value);
      const total = record(usage?.total);
      const last = record(usage?.last);
      if (total === null) return;
      const totalInput = finite(field(total, "inputTokens", "input_tokens"));
      const totalOutput = finite(field(total, "outputTokens", "output_tokens"));
      const totalCached = finite(field(total, "cachedInputTokens", "cached_input_tokens"));
      if (totalInput === undefined || totalOutput === undefined) return;
      if (baseInput === undefined || baseOutput === undefined) {
        baseInput = totalInput - (finite(field(last, "inputTokens", "input_tokens")) ?? 0);
        baseOutput = totalOutput - (finite(field(last, "outputTokens", "output_tokens")) ?? 0);
        if (totalCached !== undefined) {
          baseCached = totalCached - (finite(field(last, "cachedInputTokens", "cached_input_tokens")) ?? 0);
        }
      }
      input = Math.max(0, totalInput - baseInput);
      output = Math.max(0, totalOutput - baseOutput);
      if (totalCached !== undefined && baseCached !== undefined) cached = Math.max(0, totalCached - baseCached);
    },
    value() {
      return {
        ...(input !== undefined ? { inputTokens: input } : {}),
        ...(output !== undefined ? { outputTokens: output } : {}),
        ...(cached !== undefined ? { cachedInputTokens: cached } : {}),
        ...(input !== undefined && output !== undefined ? { totalTokens: input + output } : {}),
      };
    },
  };
}

function commonPrefixLength(left: string, right: string): number {
  const maximum = Math.min(left.length, right.length);
  let at = 0;
  while (at < maximum && left.charCodeAt(at) === right.charCodeAt(at)) at += 1;
  const code = right.charCodeAt(at - 1);
  if (at > 0 && at < right.length && code >= 0xd800 && code <= 0xdbff) at -= 1;
  return at;
}

/**
 * Normalize one Codex turn. The consumer is intentionally turn-scoped: token
 * baselines, open tools, and assistant delta reconciliation must never leak
 * across resumed turns.
 */
export function createCodexAppServerEventConsumer(
  options: CodexAppServerEventConsumerOptions,
): CodexAppServerEventConsumer {
  const textChunkChars = positiveInteger(
    options.assistantTextChunkChars,
    CODEX_ASSISTANT_TEXT_CHUNK_CHARS,
    "assistantTextChunkChars",
  );
  const toolOutputMaximum = positiveInteger(
    options.toolOutputMaxChars,
    CODEX_TOOL_OUTPUT_MAX_CHARS,
    "toolOutputMaxChars",
  );
  const contentChunkChars = positiveInteger(
    options.eventContentChunkChars,
    CODEX_EVENT_CONTENT_CHUNK_CHARS,
    "eventContentChunkChars",
  );
  const present = options.presentTool ?? defaultToolPresentation;
  const open = new Map<string, { tool: CodexToolInput; presentation: CodexToolPresentation }>();
  const unnamed: string[] = [];
  const usage = usageTracker();
  let generatedIds = 0;
  let assistantId = "";
  let assistantText = "";
  let assistantEmitted = 0;
  let terminal = false;

  const emitText = (all: boolean): void => {
    const held = assistantText.slice(assistantEmitted);
    if (!held) return;
    const parts = chunks(held, textChunkChars);
    // Keep a bounded reconciliation tail while deltas are still arriving.
    // Codex's completed message is authoritative and may revise its newest
    // sentence; retaining two chunks lets that normal tail change be replaced
    // without duplicating text already persisted by the host.
    const ready = all ? parts : parts.slice(0, -2);
    for (const part of ready) {
      options.emit({ kind: "assistant-text", text: part });
      assistantEmitted += part.length;
    }
  };

  const closeText = (): void => {
    emitText(true);
    assistantId = "";
    assistantText = "";
    assistantEmitted = 0;
  };

  const delta = (itemId: string, value: string): void => {
    if (!value) return;
    if (assistantId !== itemId) closeText();
    assistantId = itemId;
    assistantText += value;
    emitText(false);
  };

  const presentationFor = (tool: CodexToolInput): CodexToolPresentation | null => {
    const value = present(tool);
    if (value === null) return null;
    return {
      ...value,
      title: value.title || "Tool",
    };
  };

  const startTool = (value: unknown): void => {
    const parsed = toolInput(value);
    if (parsed === null) return;
    closeText();
    let toolId = parsed.id;
    if (!toolId) {
      generatedIds += 1;
      toolId = `codex-tool-${generatedIds}`;
      unnamed.push(toolId);
    }
    const tool = { ...parsed, id: toolId } as CodexToolInput;
    const presentation = presentationFor(tool);
    if (presentation === null) return;
    open.set(toolId, { tool, presentation });
    options.emit({ kind: "tool-started", toolId, ...presentation });
  };

  const completeTool = (item: Record<string, unknown>): void => {
    closeText();
    const parsed = toolInput(item);
    if (parsed === null) return;
    const toolId = parsed.id || unnamed.shift() || `codex-tool-${++generatedIds}`;
    const held = open.get(toolId);
    const tool = held?.tool ?? ({ ...parsed, id: toolId } as CodexToolInput);
    const presentation = held?.presentation ?? presentationFor(tool);
    open.delete(toolId);
    if (presentation === null) return;
    const outcome = toolOutcome(item);
    const rawOutput = toolOutput(item, tool);
    const redacted = options.redactToolOutput?.(tool, rawOutput) ?? rawOutput;
    const truncated = redacted.length > toolOutputMaximum;
    const body = truncated ? clip(redacted, toolOutputMaximum) : redacted;
    const parts = chunks(body, contentChunkChars);
    for (const outputAppend of parts.slice(0, -1)) {
      options.emit({
        kind: "tool-updated",
        toolId,
        toolKind: presentation.toolKind,
        title: presentation.title,
        outputAppend,
        ...(presentation.extensions ? { extensions: presentation.extensions } : {}),
      });
    }
    const outputAppend = parts.at(-1);
    options.emit({
      kind: "tool-completed",
      toolId,
      status: outcome.status,
      toolKind: presentation.toolKind,
      title: presentation.title,
      ...(outputAppend ? { outputAppend } : {}),
      ...(outcome.exitCode !== undefined ? { exitCode: outcome.exitCode } : {}),
      ...(truncated ? { truncated: true } : {}),
      ...(presentation.extensions ? { extensions: presentation.extensions } : {}),
    });
  };

  const closeOpenTools = (status: HarnessToolStatus): void => {
    for (const [toolId, held] of open) {
      options.emit({
        kind: "tool-completed",
        toolId,
        status,
        toolKind: held.presentation.toolKind,
        title: held.presentation.title,
        ...(held.presentation.extensions ? { extensions: held.presentation.extensions } : {}),
      });
    }
    open.clear();
    unnamed.length = 0;
  };

  const finish = (status: HarnessTurnStatus, error?: unknown): void => {
    if (terminal) return;
    closeText();
    closeOpenTools(status === "completed" ? "completed" : status === "interrupted" ? "cancelled" : "failed");
    if (error !== undefined) emitError(error);
    terminal = true;
    options.onTurnEnded?.({ status, usage: usage.value() });
  };

  const emitError = (value: unknown): void => {
    const failure = (options.publicError ?? defaultPublicError)(publicErrorInput(value));
    options.emit({
      kind: "error",
      code: failure.code,
      message: failure.message,
      ...(failure.retryable ? { retryable: true } : {}),
    });
  };

  return {
    notification(method, params) {
      if (terminal) return;
      if (method === "item/agentMessage/delta") {
        delta(text(params.itemId), text(params.delta));
        return;
      }
      if (method === "item/started") {
        const item = record(params.item);
        if (item !== null && item.type !== "agentMessage") startTool(item);
        return;
      }
      if (method === "item/completed") {
        const item = record(params.item);
        if (item === null) return;
        if (item.type === "agentMessage") {
          const whole = text(item.text);
          if (!whole) return;
          if (assistantId && text(item.id) === assistantId) {
            const agreed = commonPrefixLength(assistantText.slice(0, assistantEmitted), whole);
            assistantText = whole;
            assistantEmitted = agreed;
            closeText();
            return;
          }
          closeText();
          for (const part of chunks(whole, contentChunkChars)) {
            options.emit({ kind: "assistant-text", text: part });
          }
          return;
        }
        if (item.type === "reasoning") {
          closeText();
          for (const part of chunks(reasoningText(item), contentChunkChars)) {
            options.emit({ kind: "thinking", text: part });
          }
          return;
        }
        completeTool(item);
        return;
      }
      if (method === "turn/plan/updated") {
        closeText();
        options.emit({ kind: "plan-updated", steps: planSteps(params.plan) });
        return;
      }
      if (method === "thread/tokenUsage/updated") {
        usage.update(params.tokenUsage);
        return;
      }
      if (method === "account/rateLimits/updated") {
        const snapshot = codexLimitSnapshot(params.rateLimits);
        if (snapshot !== null) options.onLimits?.(snapshot);
        return;
      }
      if (method === "error") {
        if (params.willRetry === true) return;
        finish("error", params.error);
        return;
      }
      if (method === "turn/completed") {
        const turn = record(params.turn);
        const status = text(turn?.status);
        if (status !== "completed" && status !== "failed" && status !== "interrupted") return;
        finish(
          status === "failed" ? "error" : status === "interrupted" ? "interrupted" : "completed",
          status === "failed" ? turn?.error : undefined,
        );
      }
    },
    end(openToolStatus = "cancelled") {
      if (!terminal) closeText();
      closeOpenTools(openToolStatus);
    },
  };
}
