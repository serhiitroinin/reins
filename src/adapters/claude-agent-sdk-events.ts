/**
 * Stateful normalization of Claude Agent SDK messages.
 *
 * The consumer accepts unknown records so no provider SDK type crosses the
 * package boundary. Tool input and output stay private unless the host opts
 * into a presentation or redaction callback.
 */

import type { HarnessLimit, HarnessLimitSnapshot, HarnessModel, HarnessModelCatalog } from "../profile.js";
import type { HarnessToolStatus, HarnessTurnStatus, HarnessUsage } from "../protocol.js";
import type { HarnessAdapterEvent } from "../runtime.js";

export const CLAUDE_AGENT_SDK_NAMESPACE = "anthropic:claude-agent-sdk";
export const CLAUDE_EVENT_CONTENT_CHUNK_CHARS = 4_000;
export const CLAUDE_TOOL_OUTPUT_MAX_CHARS = 32_000;

export interface ClaudeAgentSdkToolInput {
  id: string;
  name: string;
  input: Readonly<Record<string, unknown>>;
  agentId?: string;
}

export interface ClaudeAgentSdkToolPresentation {
  toolKind: string;
  title: string;
  detail?: string;
  command?: string;
  paths?: readonly string[];
  extensions?: Readonly<Record<string, unknown>>;
}

export interface ClaudeAgentSdkPublicErrorInput {
  subtype?: string;
  message?: string;
}

export interface ClaudeAgentSdkPublicError {
  code: string;
  message: string;
  retryable?: boolean;
}

export interface ClaudeAgentSdkTurnOutcome {
  status: HarnessTurnStatus;
  usage: HarnessUsage;
}

export interface ClaudeAgentSdkEventConsumer {
  message(value: unknown): void;
  /** Close buffered prose and open tools without inventing a provider result. */
  end(openToolStatus?: HarnessToolStatus): void;
}

export interface ClaudeAgentSdkEventConsumerOptions {
  emit(event: HarnessAdapterEvent): void;
  onTurnEnded?(outcome: ClaudeAgentSdkTurnOutcome): void;
  onCheckpoint?(checkpoint: string): void;
  onLimits?(snapshot: HarnessLimitSnapshot): void;
  /** Return and consume the summary captured by the host's PostCompact hook. */
  takeCompactSummary?(): string | null;
  /** True when the host or an adapter interaction denied this tool request. */
  wasDeclined?(toolUseId: string): boolean;
  /** Replace the safe generic label and explicitly select details to persist. */
  presentTool?(tool: ClaudeAgentSdkToolInput): ClaudeAgentSdkToolPresentation | null;
  /** Raw tool output is omitted unless the host explicitly returns safe text. */
  redactToolOutput?(tool: ClaudeAgentSdkToolInput, output: string): string;
  /** Raw subagent failures are omitted unless the host explicitly returns safe text. */
  redactSubagentError?(error: string): string | undefined;
  /** Raw compaction failures are omitted unless the host explicitly returns safe text. */
  redactCompactionError?(error: string): string | undefined;
  /** Raw provider failures are hidden unless the host explicitly maps them. */
  publicError?(error: ClaudeAgentSdkPublicErrorInput): ClaudeAgentSdkPublicError;
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

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 2) {
    throw new Error(`${name} must be an integer greater than one`);
  }
  return resolved;
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

function defaultToolPresentation(tool: ClaudeAgentSdkToolInput): ClaudeAgentSdkToolPresentation {
  return { toolKind: "tool", title: tool.name || "Tool" };
}

function defaultPublicError(error: ClaudeAgentSdkPublicErrorInput): ClaudeAgentSdkPublicError {
  if (error.subtype === "error_max_turns") {
    return {
      code: "CLAUDE_MAX_TURNS",
      message: "Claude reached the step limit for this turn.",
    };
  }
  return { code: "CLAUDE_PROVIDER_ERROR", message: "Claude could not complete the turn." };
}

function resultText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  const parts: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      parts.push(entry);
      continue;
    }
    const block = record(entry);
    if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n");
}

function planSteps(value: unknown): readonly { text: string; status: string }[] {
  const input = record(value);
  const rows = Array.isArray(input?.todos) ? input.todos : [];
  return rows.flatMap((entry) => {
    const row = record(entry);
    const body = text(row?.content);
    if (!body) return [];
    const status = text(row?.status);
    return [{
      text: body,
      status: status === "completed" ? "done" : status === "in_progress" ? "active" : "pending",
    }];
  });
}

function usageFromResult(value: Record<string, unknown>): HarnessUsage {
  const usage = record(value.usage);
  const direct = finite(usage?.input_tokens);
  const cacheRead = finite(usage?.cache_read_input_tokens);
  const cacheCreated = finite(usage?.cache_creation_input_tokens);
  const input = direct === undefined
    ? undefined
    : direct + (cacheRead ?? 0) + (cacheCreated ?? 0);
  const output = finite(usage?.output_tokens);
  return {
    ...(input !== undefined ? { inputTokens: input } : {}),
    ...(output !== undefined ? { outputTokens: output } : {}),
    ...(cacheRead !== undefined ? { cachedInputTokens: cacheRead } : {}),
    ...(input !== undefined && output !== undefined ? { totalTokens: input + output } : {}),
    ...(finite(value.duration_ms) !== undefined ? { durationMs: finite(value.duration_ms)! } : {}),
  };
}

function promptTokens(value: unknown): number | undefined {
  const usage = record(value);
  const input = finite(usage?.input_tokens);
  if (input === undefined) return undefined;
  return input
    + (finite(usage?.cache_read_input_tokens) ?? 0)
    + (finite(usage?.cache_creation_input_tokens) ?? 0);
}

const LIMIT_LABELS: Readonly<Record<string, string>> = {
  five_hour: "5-hour",
  seven_day: "Weekly",
  seven_day_opus: "Weekly · Opus",
  seven_day_sonnet: "Weekly · Sonnet",
  seven_day_oauth_apps: "Weekly · Apps",
  seven_day_overage_included: "Weekly · Overage",
  overage: "Overage",
};

const EFFORT_LABELS: Readonly<Record<string, string>> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

function title(value: string): string {
  return value
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(" ");
}

function windowDuration(id: string): number | undefined {
  if (id === "five_hour") return 300 * 60_000;
  return id.startsWith("seven_day") ? 10_080 * 60_000 : undefined;
}

function rateLimit(id: string, usedPercent: number, resetsAt?: string, label?: string): HarnessLimit {
  const windowDurationMs = windowDuration(id);
  return {
    id,
    label: label ?? LIMIT_LABELS[id] ?? title(id),
    kind: "rate",
    scope: "account",
    unit: "%",
    usedPercent: Math.round(usedPercent),
    ...(resetsAt ? { resetsAt } : {}),
    ...(windowDurationMs !== undefined ? { windowDurationMs } : {}),
  };
}

/** Stream updates report a fraction of one. Larger values are already a percentage. */
function streamedPercent(value: unknown): number | undefined {
  const used = finite(value);
  if (used === undefined) return undefined;
  return used <= 1 ? used * 100 : used;
}

function isoFromSeconds(value: unknown): string | undefined {
  const seconds = finite(value);
  if (seconds === undefined) return undefined;
  const date = new Date(seconds * 1_000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function isoFromText(value: unknown): string | undefined {
  const parsed = Date.parse(text(value));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

/**
 * Convert one Agent SDK push update without retaining its wire type.
 *
 * An update names one window at the top level and may carry every current
 * window under `unifiedWindows`. Both are read; the named window wins.
 */
export function claudeAgentSdkLimitSnapshot(value: unknown): HarnessLimitSnapshot | null {
  const info = record(value);
  if (info === null) return null;
  const limits = new Map<string, HarnessLimit>();
  const windows = record(info.unifiedWindows) ?? record(info.unified_windows) ?? {};
  for (const [id, entry] of Object.entries(windows)) {
    const window = record(entry);
    const usedPercent = streamedPercent(window?.utilization);
    if (window === null || usedPercent === undefined) continue;
    limits.set(id, rateLimit(id, usedPercent, isoFromSeconds(window.resetsAt ?? window.resets_at)));
  }
  const usedPercent = streamedPercent(info.utilization);
  if (usedPercent !== undefined) {
    const id = text(info.rateLimitType) || text(info.rate_limit_type) || "five_hour";
    limits.set(id, rateLimit(id, usedPercent, isoFromSeconds(info.resetsAt ?? info.resets_at)));
  }
  return limits.size > 0 ? { limits: [...limits.values()] } : null;
}

const USAGE_WINDOWS = [
  "five_hour",
  "seven_day",
  "seven_day_opus",
  "seven_day_sonnet",
  "seven_day_oauth_apps",
] as const;

/**
 * Convert the Agent SDK usage response, which reports whole percentages.
 * Returns null when plan limits do not apply, for example with an API key.
 */
export function claudeAgentSdkUsageLimitSnapshot(value: unknown): HarnessLimitSnapshot | null {
  const usage = record(value);
  const windows = record(usage?.rate_limits);
  if (usage === null || windows === null || usage.rate_limits_available === false) return null;
  const limits: HarnessLimit[] = [];
  for (const id of USAGE_WINDOWS) {
    const window = record(windows[id]);
    const usedPercent = finite(window?.utilization);
    if (window === null || usedPercent === undefined) continue;
    limits.push(rateLimit(id, usedPercent, isoFromText(window.resets_at)));
  }
  for (const entry of Array.isArray(windows.model_scoped) ? windows.model_scoped : []) {
    const window = record(entry);
    const name = text(window?.display_name);
    const usedPercent = finite(window?.utilization);
    if (window === null || name === "" || usedPercent === undefined) continue;
    const id = `seven_day_model:${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
    limits.push({
      ...rateLimit(id, usedPercent, isoFromText(window.resets_at), `Weekly · ${name}`),
      scope: "model",
    });
  }
  const plan = text(usage.subscription_type);
  return { ...(plan ? { planLabel: title(plan) } : {}), limits };
}

/** Convert an Agent SDK `supportedModels()` response into the neutral catalog. */
export function claudeAgentSdkModelCatalog(value: unknown): HarnessModelCatalog {
  const models: HarnessModel[] = [];
  for (const entry of Array.isArray(value) ? value : []) {
    const row = record(entry);
    const id = text(row?.value);
    if (row === null || id === "" || models.some((model) => model.id === id)) continue;
    const efforts = row.supportsEffort === false || !Array.isArray(row.supportedEffortLevels)
      ? []
      : row.supportedEffortLevels.filter((level): level is string => typeof level === "string" && level !== "");
    const details = {
      ...(text(row.resolvedModel) ? { resolvedModel: text(row.resolvedModel) } : {}),
      ...(typeof row.supportsAdaptiveThinking === "boolean" ? { adaptiveThinking: row.supportsAdaptiveThinking } : {}),
      ...(typeof row.supportsFastMode === "boolean" ? { fastMode: row.supportsFastMode } : {}),
      ...(typeof row.supportsAutoMode === "boolean" ? { autoMode: row.supportsAutoMode } : {}),
    };
    models.push({
      id,
      label: text(row.displayName) || title(id),
      ...(text(row.description) ? { description: text(row.description) } : {}),
      ...(efforts.length > 0
        ? { effort: { options: efforts.map((level) => ({ id: level, label: EFFORT_LABELS[level] ?? title(level) })) } }
        : {}),
      ...(Object.keys(details).length > 0 ? { extensions: { [CLAUDE_AGENT_SDK_NAMESPACE]: details } } : {}),
    });
  }
  const preferred = models.find((model) => model.id === "default") ?? models[0];
  return {
    models,
    selection: "optional",
    ...(preferred ? { defaultModelId: preferred.id } : {}),
  };
}

interface OpenTool {
  tool: ClaudeAgentSdkToolInput;
  presentation: ClaudeAgentSdkToolPresentation;
}

class ToolTable {
  private readonly open = new Map<string, OpenTool>();

  constructor(
    private readonly emit: (event: HarnessAdapterEvent) => void,
    private readonly present: (tool: ClaudeAgentSdkToolInput) => ClaudeAgentSdkToolPresentation | null,
    private readonly safeOutput: (tool: ClaudeAgentSdkToolInput, output: string) => string,
    private readonly wasDeclined: (id: string) => boolean,
    private readonly outputMaximum: number,
    private readonly chunkMaximum: number,
  ) {}

  has(id: string): boolean {
    return this.open.has(id);
  }

  start(tool: ClaudeAgentSdkToolInput): void {
    const presentation = this.present(tool);
    if (presentation === null) return;
    const normalized = { ...presentation, title: presentation.title || "Tool" };
    this.open.set(tool.id, { tool, presentation: normalized });
    this.emit({ kind: "tool-started", toolId: tool.id, ...normalized });
  }

  complete(id: string, rawOutput: string, failed: boolean): void {
    const held = this.open.get(id);
    if (!held) return;
    this.open.delete(id);
    const output = this.safeOutput(held.tool, rawOutput);
    const truncated = output.length > this.outputMaximum;
    const parts = chunks(truncated ? clip(output, this.outputMaximum) : output, this.chunkMaximum);
    for (const outputAppend of parts.slice(0, -1)) {
      this.emit({
        kind: "tool-updated",
        toolId: id,
        toolKind: held.presentation.toolKind,
        title: held.presentation.title,
        outputAppend,
        ...(held.presentation.extensions ? { extensions: held.presentation.extensions } : {}),
      });
    }
    const outputAppend = parts.at(-1);
    this.emit({
      kind: "tool-completed",
      toolId: id,
      status: this.wasDeclined(id) ? "declined" : failed ? "failed" : "completed",
      toolKind: held.presentation.toolKind,
      title: held.presentation.title,
      ...(outputAppend ? { outputAppend } : {}),
      ...(truncated ? { truncated: true } : {}),
      ...(held.presentation.extensions ? { extensions: held.presentation.extensions } : {}),
    });
  }

  decline(id: string, fallback: ClaudeAgentSdkToolInput): void {
    const held = this.open.get(id);
    if (held) {
      this.open.delete(id);
      this.emit({
        kind: "tool-completed",
        toolId: id,
        status: "declined",
        toolKind: held.presentation.toolKind,
        title: held.presentation.title,
        ...(held.presentation.extensions ? { extensions: held.presentation.extensions } : {}),
      });
      return;
    }
    const presentation = this.present(fallback);
    if (presentation === null) return;
    this.emit({
      kind: "tool-completed",
      toolId: id,
      status: "declined",
      toolKind: presentation.toolKind,
      title: presentation.title || "Tool",
      ...(presentation.extensions ? { extensions: presentation.extensions } : {}),
    });
  }

  close(status: HarnessToolStatus): void {
    for (const [toolId, held] of this.open) {
      this.emit({
        kind: "tool-completed",
        toolId,
        status,
        toolKind: held.presentation.toolKind,
        title: held.presentation.title,
        ...(held.presentation.extensions ? { extensions: held.presentation.extensions } : {}),
      });
    }
    this.open.clear();
  }
}

/** Normalize one Claude turn and its nested subagent streams. */
export function createClaudeAgentSdkEventConsumer(
  options: ClaudeAgentSdkEventConsumerOptions,
): ClaudeAgentSdkEventConsumer {
  const contentMaximum = positiveInteger(
    options.eventContentChunkChars,
    CLAUDE_EVENT_CONTENT_CHUNK_CHARS,
    "eventContentChunkChars",
  );
  const toolOutputMaximum = positiveInteger(
    options.toolOutputMaxChars,
    CLAUDE_TOOL_OUTPUT_MAX_CHARS,
    "toolOutputMaxChars",
  );
  const present = options.presentTool ?? defaultToolPresentation;
  const safeOutput = options.redactToolOutput ?? (() => "");
  const wasDeclined = options.wasDeclined ?? (() => false);
  const toolUseToTask = new Map<string, string>();
  const agentTools = new Map<string, ToolTable>();
  const openAgents = new Map<string, string>();
  let generatedToolIds = 0;
  let prose = "";
  let terminal = false;
  let compacting = false;
  let lastPrompt: { usedTokens: number; model: string | null } | null = null;

  const extension = (name: string, payload: unknown): HarnessAdapterEvent => ({
    kind: "extension",
    namespace: CLAUDE_AGENT_SDK_NAMESPACE,
    name,
    payload,
  });
  const subagentEvent = (agentId: string, event: HarnessAdapterEvent): void => {
    options.emit(extension("subagent-event", { agentId, event }));
  };
  const mainTools = new ToolTable(
    options.emit,
    present,
    safeOutput,
    wasDeclined,
    toolOutputMaximum,
    contentMaximum,
  );
  const toolsForAgent = (agentId: string): ToolTable => {
    let table = agentTools.get(agentId);
    if (!table) {
      table = new ToolTable(
        (event) => subagentEvent(agentId, event),
        present,
        safeOutput,
        wasDeclined,
        toolOutputMaximum,
        contentMaximum,
      );
      agentTools.set(agentId, table);
    }
    return table;
  };
  const flush = (all: boolean): void => {
    if (!prose) return;
    const parts = chunks(prose, contentMaximum);
    const held = !all && parts.at(-1)!.length < contentMaximum;
    for (const part of held ? parts.slice(0, -1) : parts) options.emit({ kind: "assistant-text", text: part });
    prose = held ? parts.at(-1)! : "";
  };
  const toolInput = (block: Record<string, unknown>, agentId?: string): ClaudeAgentSdkToolInput => ({
    id: text(block.id) || `claude-tool-${++generatedToolIds}`,
    name: text(block.name) || "Tool",
    input: record(block.input) ?? {},
    ...(agentId ? { agentId } : {}),
  });
  const assistant = (message: Record<string, unknown>, agentId?: string): void => {
    const body = record(message.message);
    if (!agentId) {
      const usedTokens = promptTokens(record(body?.usage));
      if (usedTokens !== undefined) {
        lastPrompt = { usedTokens, model: text(body?.model) || null };
      }
    }
    const content = Array.isArray(body?.content) ? body.content : [];
    for (const value of content) {
      const block = record(value);
      if (!block) continue;
      if (block.type === "text" && text(block.text)) {
        if (agentId) {
          for (const part of chunks(text(block.text), contentMaximum)) {
            subagentEvent(agentId, { kind: "assistant-text", text: part });
          }
        } else {
          prose += text(block.text);
          flush(false);
        }
        continue;
      }
      if (block.type === "thinking" && text(block.thinking)) {
        if (!agentId) flush(true);
        for (const part of chunks(text(block.thinking), contentMaximum)) {
          const event: HarnessAdapterEvent = { kind: "thinking", text: part };
          if (agentId) subagentEvent(agentId, event);
          else options.emit(event);
        }
        continue;
      }
      if (block.type !== "tool_use") continue;
      const tool = toolInput(block, agentId);
      if (!agentId) flush(true);
      if (!agentId && tool.name === "TodoWrite") {
        options.emit({ kind: "plan-updated", steps: planSteps(tool.input) });
        continue;
      }
      if (tool.name === "Skill") {
        const skill = text(tool.input.skill);
        const args = text(tool.input.args);
        const event = extension("skill", { skill, ...(args ? { args } : {}), ...(agentId ? { agentId } : {}) });
        options.emit(event);
      }
      (agentId ? toolsForAgent(agentId) : mainTools).start(tool);
    }
  };
  const user = (message: Record<string, unknown>, agentId?: string): void => {
    const body = record(message.message);
    const content = body?.content;
    if (agentId && typeof content === "string" && content) {
      options.emit(extension("subagent-event", { agentId, event: { kind: "user-text", text: clip(content, 8_000) } }));
      return;
    }
    const rows = Array.isArray(content) ? content : [];
    const table = agentId ? toolsForAgent(agentId) : mainTools;
    for (const value of rows) {
      const block = record(value);
      if (!block) continue;
      if (block.type === "tool_result") {
        const id = text(block.tool_use_id);
        if (id && table.has(id)) table.complete(id, resultText(block.content), block.is_error === true);
      } else if (agentId && block.type === "text" && text(block.text)) {
        options.emit(extension("subagent-event", {
          agentId,
          event: { kind: "user-text", text: clip(text(block.text), 8_000) },
        }));
      }
    }
  };
  const agent = (phase: "started" | "progress" | "done", message: Record<string, unknown>): void => {
    const taskId = text(message.task_id);
    if (!taskId) return;
    const known = openAgents.get(taskId);
    const description = text(message.description) || known || "subagent";
    if (phase === "started") {
      openAgents.set(taskId, description);
      const toolUseId = text(message.tool_use_id);
      if (toolUseId) toolUseToTask.set(toolUseId, taskId);
    }
    if (phase === "done") openAgents.delete(taskId);
    const usage = record(message.usage);
    const status = text(message.status);
    options.emit(extension("subagent", {
      taskId,
      phase,
      description,
      ...(message.skip_transcript === true ? { skipTranscript: true } : {}),
      ...(text(message.subagent_type) ? { subagentType: text(message.subagent_type) } : {}),
      ...(status === "completed" || status === "failed" || status === "stopped" ? { status } : {}),
      ...(text(message.summary) ? { summary: text(message.summary) } : {}),
      ...(text(message.last_tool_name) ? { lastTool: text(message.last_tool_name) } : {}),
      ...(usage ? {
        usage: {
          ...(finite(usage.total_tokens) !== undefined ? { totalTokens: finite(usage.total_tokens)! } : {}),
          ...(finite(usage.tool_uses) !== undefined ? { toolUses: finite(usage.tool_uses)! } : {}),
          ...(finite(usage.duration_ms) !== undefined ? { durationMs: finite(usage.duration_ms)! } : {}),
        },
      } : {}),
    }));
  };
  const publicFailure = (message: Record<string, unknown>): ClaudeAgentSdkPublicError => {
    const input = {
      ...(text(message.subtype) ? { subtype: text(message.subtype) } : {}),
      ...(text(message.error) ? { message: text(message.error) } : {}),
    };
    return (options.publicError ?? defaultPublicError)(input);
  };
  const finish = (message: Record<string, unknown>): void => {
    if (terminal) return;
    flush(true);
    const usage = usageFromResult(message);
    if (lastPrompt) {
      const perModel = record(message.modelUsage);
      const own = lastPrompt.model === null ? null : record(perModel?.[lastPrompt.model]);
      options.emit(extension("context", {
        usedTokens: lastPrompt.usedTokens,
        ...(finite(own?.contextWindow) !== undefined ? { maxTokens: finite(own?.contextWindow)! } : {}),
      }));
    }
    if (Object.keys(usage).length > 0) options.emit({ kind: "usage", usage });
    const subtype = text(message.subtype);
    const interrupted = subtype === "interrupted"
      || subtype === "cancelled"
      || subtype === "canceled"
      || subtype === "error_interrupted";
    const failed = message.is_error === true && !interrupted;
    if (failed) {
      const failure = publicFailure(message);
      options.emit({
        kind: "error",
        code: failure.code,
        message: failure.message,
        ...(failure.retryable ? { retryable: true } : {}),
      });
    }
    mainTools.close(failed ? "failed" : "cancelled");
    for (const table of agentTools.values()) table.close(failed ? "failed" : "cancelled");
    for (const [taskId, description] of openAgents) {
      options.emit(extension("subagent", { taskId, phase: "done", status: "stopped", description }));
    }
    openAgents.clear();
    terminal = true;
    options.onTurnEnded?.({ status: interrupted ? "interrupted" : failed ? "error" : "completed", usage });
  };

  return {
    message(value) {
      if (terminal) return;
      const message = record(value);
      if (!message) return;
      const type = text(message.type);
      if (type === "system") {
        const subtype = text(message.subtype);
        if (subtype === "init") {
          const checkpoint = text(message.session_id);
          if (checkpoint) options.onCheckpoint?.(checkpoint);
        } else if (subtype === "background_tasks_changed") {
          const rows = Array.isArray(message.tasks) ? message.tasks : [];
          options.emit(extension("background-tasks", rows.flatMap((entry) => {
            const task = record(entry);
            const taskId = text(task?.task_id);
            return taskId ? [{ taskId, taskType: text(task?.task_type), description: text(task?.description) }] : [];
          })));
        } else if (subtype === "task_started") agent("started", message);
        else if (subtype === "task_progress") agent("progress", message);
        else if (subtype === "task_notification") agent("done", message);
        else if (subtype === "task_updated") {
          const taskId = text(message.task_id);
          const patch = record(message.patch) ?? {};
          if (taskId) {
            const raw = text(patch.status);
            const rawError = text(patch.error);
            const safeError = rawError ? options.redactSubagentError?.(rawError) : undefined;
            options.emit(extension("subagent", {
              taskId,
              phase: raw === "completed" || raw === "failed" || raw === "killed" ? "done" : "progress",
              description: text(patch.description) || openAgents.get(taskId) || "subagent",
              ...(raw === "completed" ? { status: "completed" }
                : raw === "failed" ? { status: "failed" }
                  : raw === "killed" ? { status: "stopped" } : {}),
              ...(safeError ? { error: safeError } : {}),
              ...(patch.is_backgrounded === true ? { backgrounded: true } : {}),
            }));
            if (raw === "completed" || raw === "failed" || raw === "killed") openAgents.delete(taskId);
          }
        } else if (subtype === "permission_denied") {
          const toolUseId = text(message.tool_use_id) || `claude-tool-${++generatedToolIds}`;
          const agentId = text(message.agent_id);
          const tool = { id: toolUseId, name: text(message.tool_name) || "Tool", input: {}, ...(agentId ? { agentId } : {}) };
          (agentId ? toolsForAgent(agentId) : mainTools).decline(toolUseId, tool);
        } else if (subtype === "compact_boundary") {
          const metadata = record(message.compact_metadata) ?? {};
          const summary = options.takeCompactSummary?.() ?? null;
          options.emit(extension("compaction", {
            trigger: metadata.trigger === "auto" ? "auto" : "manual",
            preTokens: finite(metadata.pre_tokens) ?? 0,
            ...(finite(metadata.post_tokens) !== undefined ? { postTokens: finite(metadata.post_tokens)! } : {}),
            ...(summary ? { summary } : {}),
          }));
        } else if (subtype === "status") {
          if (message.status === "compacting") {
            compacting = true;
            options.emit(extension("status", { status: "compacting" }));
          } else if (compacting) {
            compacting = false;
            const rawError = text(message.compact_error);
            const safeError = rawError ? options.redactCompactionError?.(rawError) : undefined;
            options.emit(extension("status", {
              status: "working",
              ...(message.compact_result === "failed" ? { compactionFailed: true } : {}),
              ...(safeError ? { error: safeError } : {}),
            }));
          }
        }
        return;
      }
      const parent = text(message.parent_tool_use_id);
      const agentId = parent ? toolUseToTask.get(parent) ?? parent : undefined;
      if (type === "assistant") assistant(message, agentId);
      else if (type === "user") user(message, agentId);
      else if (type === "rate_limit_event") {
        const snapshot = claudeAgentSdkLimitSnapshot(message.rate_limit_info);
        if (snapshot) options.onLimits?.(snapshot);
      } else if (
        type === "result"
        && text(message.subtype) !== ""
        && typeof message.is_error === "boolean"
      ) finish(message);
    },
    end(openToolStatus = "cancelled") {
      if (!terminal) flush(true);
      mainTools.close(openToolStatus);
      for (const table of agentTools.values()) table.close(openToolStatus);
    },
  };
}
