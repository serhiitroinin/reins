/**
 * Ready-to-use Node connector for the Claude Agent SDK adapter.
 *
 * The connector owns SDK stream mechanics and the in-process application-tool
 * bridge. The host still supplies every authority-bearing launch option.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  HookCallback,
  HookCallbackMatcher,
  McpServerConfig,
  Options,
  PermissionMode,
  Query,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import {
  HarnessAdapterError,
  HarnessAdapterInterruptedError,
} from "../runtime.js";
import type {
  HarnessDiscovery,
  HarnessDiscoveryRequest,
  HarnessLimitSnapshot,
  HarnessModelCatalog,
} from "../profile.js";
import type { HarnessInput, HarnessInlineContext } from "../protocol.js";
import type { HarnessToolContent, HarnessToolResult } from "../tools.js";
import { createPushableAsyncIterable } from "../transports/async-iterable.js";
import type {
  ClaudeAgentSdkConnectRequest,
  ClaudeAgentSdkConnection,
  ClaudeAgentSdkTurnInput,
} from "./claude-agent-sdk-adapter.js";
import {
  claudeAgentSdkModelCatalog,
  claudeAgentSdkUsageLimitSnapshot,
} from "./claude-agent-sdk-events.js";

export const CLAUDE_AGENT_SDK_TOOL_SERVER = "reins";

export const CLAUDE_AGENT_SDK_CONNECTOR_ERRORS = {
  invalidConfiguration: "CLAUDE_CONNECTOR_INVALID_CONFIGURATION",
  mcpNameConflict: "CLAUDE_CONNECTOR_MCP_NAME_CONFLICT",
  unsupportedEffort: "CLAUDE_CONNECTOR_UNSUPPORTED_EFFORT",
  inputMappingFailed: "CLAUDE_CONNECTOR_INPUT_MAPPING_FAILED",
  streamClosed: "CLAUDE_CONNECTOR_STREAM_CLOSED",
} as const;

export type ClaudeAgentSdkSettingSource = "user" | "project" | "local";

export type ClaudeAgentSdkPermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan"
  | "dontAsk"
  | "auto";

export type ClaudeAgentSdkSystemPrompt =
  | string
  | {
      type: "preset";
      preset: "claude_code";
      append?: string;
      excludeDynamicSections?: readonly string[];
    }
  | {
      type: "custom";
      prompt: string;
    };

export interface ClaudeAgentSdkPlugin {
  type: "local";
  path: string;
  skipMcpDiscovery?: boolean;
}

/**
 * Explicit authority and process configuration for one SDK connection.
 *
 * Required arrays may be empty. Empty `tools`, `skills`, and `settingSources`
 * close those implicit Claude surfaces rather than accepting SDK defaults.
 */
export interface ClaudeAgentSdkSessionConfiguration {
  /** A placement default, not a filesystem security boundary. */
  cwd: string;
  /** Exact subprocess environment. It is never merged with `process.env`. */
  env: Readonly<Record<string, string>>;
  /** Complete built-in Claude tool surface. An empty array disables it. */
  tools: readonly string[];
  /** Complete native skill allowlist. An empty array disables native skills. */
  skills: readonly string[];
  /** Filesystem settings sources to load. Use an empty array for isolation. */
  settingSources: readonly ClaudeAgentSdkSettingSource[];
  /** Required so file-mounted MCP configuration cannot expand the surface. */
  strictMcpConfig: true;
  permissionMode: ClaudeAgentSdkPermissionMode;
  systemPrompt: ClaudeAgentSdkSystemPrompt;
  maxTurns?: number;
  managedSettings?: Readonly<Record<string, unknown>>;
  sandbox?: Readonly<Record<string, unknown>>;
  plugins?: readonly ClaudeAgentSdkPlugin[];
  /** Explicit additional MCP servers. The application-tool server is added separately. */
  mcpServers?: Readonly<Record<string, unknown>>;
  forwardSubagentText?: boolean;
  agentProgressSummaries?: boolean;
  persistSession?: boolean;
  allowDangerouslySkipPermissions?: boolean;
  /**
   * Explicit provider escape hatch for options not modeled yet. Connector-owned
   * fields cannot be replaced here. Audit additions as SDK authority changes.
   */
  extensions?: Readonly<Record<string, unknown>>;
}

export type ClaudeAgentSdkPromptContent = string | readonly unknown[];

export interface ClaudeAgentSdkQueryLike extends AsyncIterable<unknown> {
  interrupt(): Promise<unknown>;
  stopTask(taskId: string): Promise<void>;
  close(): void;
}

export interface ClaudeAgentSdkQueryRequest {
  prompt: AsyncIterable<unknown>;
  /** SDK launch options, exposed as unknown only for deterministic test seams. */
  options: Readonly<Record<string, unknown>>;
}

export interface ClaudeAgentSdkConnectorOptions {
  /** Resolve credentials, environment, tools, settings, and policy explicitly. */
  configure(
    request: ClaudeAgentSdkConnectRequest,
  ): Promise<ClaudeAgentSdkSessionConfiguration> | ClaudeAgentSdkSessionConfiguration;
  /**
   * Convert a normalized turn to Agent SDK user content. The default mapper
   * preserves host-instruction and untrusted-content labels and supports text,
   * images, resources, and inline context references.
   */
  mapInput?(
    input: ClaudeAgentSdkTurnInput,
    request: ClaudeAgentSdkConnectRequest,
  ): Promise<ClaudeAgentSdkPromptContent> | ClaudeAgentSdkPromptContent;
  toolServerName?: string;
  toolServerVersion?: string;
  toolTimeoutMs?: number;
  /** Receives private SDK stderr. Nothing is emitted as a harness event. */
  onStderr?(chunk: string, request: ClaudeAgentSdkConnectRequest): void;
  /** Deterministic injection seam. Production callers should omit it. */
  createQuery?(request: ClaudeAgentSdkQueryRequest): ClaudeAgentSdkQueryLike;
}

const SDK_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const SDK_PERMISSION_MODES = new Set([
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
  "dontAsk",
  "auto",
]);

const RESERVED_EXTENSION_OPTIONS = new Set([
  "abortController",
  "agentProgressSummaries",
  "allowDangerouslySkipPermissions",
  "canUseTool",
  "cwd",
  "effort",
  "env",
  "forwardSubagentText",
  "hooks",
  "managedSettings",
  "maxTurns",
  "mcpServers",
  "model",
  "permissionMode",
  "persistSession",
  "plugins",
  "resume",
  "sandbox",
  "settingSources",
  "skills",
  "stderr",
  "strictMcpConfig",
  "systemPrompt",
  "tools",
]);

function connectorError(code: string, message: string): HarnessAdapterError {
  return new HarnessAdapterError(code, message);
}

function validateStringList(values: readonly string[], name: string): string[] {
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string" || value.trim() === "")) {
    throw connectorError(
      CLAUDE_AGENT_SDK_CONNECTOR_ERRORS.invalidConfiguration,
      `${name} must contain only non-empty strings.`,
    );
  }
  return [...values];
}

function validateConfiguration(
  value: ClaudeAgentSdkSessionConfiguration,
  toolServerName: string,
): ClaudeAgentSdkSessionConfiguration {
  if (!value || typeof value !== "object") {
    throw connectorError(
      CLAUDE_AGENT_SDK_CONNECTOR_ERRORS.invalidConfiguration,
      "Claude connection configuration is required.",
    );
  }
  if (typeof value.cwd !== "string" || value.cwd.trim() === "") {
    throw connectorError(
      CLAUDE_AGENT_SDK_CONNECTOR_ERRORS.invalidConfiguration,
      "Claude cwd must be a non-empty path.",
    );
  }
  if (!value.env || typeof value.env !== "object" || Array.isArray(value.env)) {
    throw connectorError(
      CLAUDE_AGENT_SDK_CONNECTOR_ERRORS.invalidConfiguration,
      "Claude env must be an explicit string map.",
    );
  }
  for (const [key, entry] of Object.entries(value.env)) {
    if (key.trim() === "" || typeof entry !== "string") {
      throw connectorError(
        CLAUDE_AGENT_SDK_CONNECTOR_ERRORS.invalidConfiguration,
        "Claude env must contain only non-empty keys and string values.",
      );
    }
  }
  validateStringList(value.tools, "Claude tools");
  validateStringList(value.skills, "Claude skills");
  if (
    !Array.isArray(value.settingSources)
    || value.settingSources.some((source) => source !== "user" && source !== "project" && source !== "local")
  ) {
    throw connectorError(
      CLAUDE_AGENT_SDK_CONNECTOR_ERRORS.invalidConfiguration,
      "Claude settingSources must be an explicit list of user, project, or local.",
    );
  }
  if (value.strictMcpConfig !== true) {
    throw connectorError(
      CLAUDE_AGENT_SDK_CONNECTOR_ERRORS.invalidConfiguration,
      "Claude strictMcpConfig must be true.",
    );
  }
  if (!SDK_PERMISSION_MODES.has(value.permissionMode)) {
    throw connectorError(
      CLAUDE_AGENT_SDK_CONNECTOR_ERRORS.invalidConfiguration,
      `Unsupported Claude permission mode: ${String(value.permissionMode)}`,
    );
  }
  if (
    typeof value.systemPrompt !== "string"
    && (!value.systemPrompt || typeof value.systemPrompt !== "object")
  ) {
    throw connectorError(
      CLAUDE_AGENT_SDK_CONNECTOR_ERRORS.invalidConfiguration,
      "Claude systemPrompt must be explicit.",
    );
  }
  if (value.maxTurns !== undefined && (!Number.isSafeInteger(value.maxTurns) || value.maxTurns < 1)) {
    throw connectorError(
      CLAUDE_AGENT_SDK_CONNECTOR_ERRORS.invalidConfiguration,
      "Claude maxTurns must be a positive integer.",
    );
  }
  if (value.mcpServers && Object.hasOwn(value.mcpServers, toolServerName)) {
    throw connectorError(
      CLAUDE_AGENT_SDK_CONNECTOR_ERRORS.mcpNameConflict,
      `Claude MCP server name is reserved by the application tool bridge: ${toolServerName}`,
    );
  }
  for (const key of Object.keys(value.extensions ?? {})) {
    if (RESERVED_EXTENSION_OPTIONS.has(key)) {
      throw connectorError(
        CLAUDE_AGENT_SDK_CONNECTOR_ERRORS.invalidConfiguration,
        `Claude extension options cannot replace connector-owned field: ${key}`,
      );
    }
  }
  return value;
}

function inlineRecord(
  contextId: string,
  inlineContext: HarnessInlineContext | undefined,
): string {
  const record = inlineContext?.records.find((entry) => entry.id === contextId);
  if (!record) return `[Unavailable context reference: ${contextId}]`;
  return [
    `<untrusted-context-reference id=${JSON.stringify(record.id)} kind=${JSON.stringify(record.kind)} label=${JSON.stringify(record.label)}>`,
    JSON.stringify(record.payload),
    "</untrusted-context-reference>",
  ].join("\n");
}

function inputBlock(input: HarnessInput, inlineContext?: HarnessInlineContext): unknown {
  if (input.type === "text") return { type: "text", text: input.text };
  if (input.type === "image") {
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: input.mediaType,
        data: Buffer.from(input.data).toString("base64"),
      },
    };
  }
  if (input.type === "context-reference") {
    return { type: "text", text: inlineRecord(input.contextId, inlineContext) };
  }
  return {
    type: "text",
    text: `[Unfetched resource: ${input.name ?? input.uri} (${input.uri})]`,
  };
}

/** Default provider mapping with explicit trust labels and no resource fetches. */
export function defaultClaudeAgentSdkInput(
  input: ClaudeAgentSdkTurnInput,
): readonly unknown[] {
  const blocks: unknown[] = [];
  for (const source of input.context.sources) {
    if (source.value.instructions) {
      blocks.push({
        type: "text",
        text: [
          `<host-context-instructions source=${JSON.stringify(source.sourceId)}>`,
          source.value.instructions,
          "</host-context-instructions>",
        ].join("\n"),
      });
    }
    blocks.push({
      type: "text",
      text: `<untrusted-context source=${JSON.stringify(source.sourceId)}>`,
    });
    blocks.push(...source.value.content.map((part) => inputBlock(part, input.inlineContext)));
    blocks.push({ type: "text", text: "</untrusted-context>" });
  }
  blocks.push(...input.input.map((part) => inputBlock(part, input.inlineContext)));
  return blocks;
}

function mcpContent(content: HarnessToolContent): CallToolResult["content"][number] {
  if (content.type === "text") return { type: "text", text: content.text };
  if (content.type === "image") {
    return { type: "image", mimeType: content.mediaType, data: content.data };
  }
  if (content.text !== undefined) {
    return {
      type: "resource",
      resource: {
        uri: content.uri,
        ...(content.mediaType ? { mimeType: content.mediaType } : {}),
        text: content.text,
      },
    };
  }
  return { type: "text", text: `[Resource: ${content.uri}]` };
}

function mcpResult(result: HarnessToolResult): CallToolResult {
  return {
    content: result.content.map(mcpContent),
    ...(result.isError ? { isError: true } : {}),
    ...(result.metadata || result.code
      ? { _meta: { ...(result.metadata ?? {}), ...(result.code ? { code: result.code } : {}) } }
      : {}),
  };
}

function toolServer(
  request: ClaudeAgentSdkConnectRequest,
  name: string,
  version: string,
): McpServer {
  const server = new McpServer(
    { name, version },
    { capabilities: { tools: {} } },
  );
  server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: request.tools.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  }));
  server.server.setRequestHandler(CallToolRequestSchema, async (message) => {
    try {
      return mcpResult(await request.tools.call(message.params.name, message.params.arguments ?? {}));
    } catch {
      return mcpResult({
        content: [{ type: "text", text: `Tool failed: ${message.params.name}` }],
        isError: true,
        code: "TOOL_EXECUTION_FAILED",
      });
    }
  });
  return server;
}

function cloneMcpServers(
  source: Readonly<Record<string, unknown>> | undefined,
): Record<string, McpServerConfig> {
  return Object.fromEntries(Object.entries(source ?? {})) as Record<string, McpServerConfig>;
}

function sdkQuery(request: ClaudeAgentSdkQueryRequest): ClaudeAgentSdkQueryLike {
  return query({
    prompt: request.prompt as AsyncIterable<SDKUserMessage>,
    options: request.options as Options,
  }) as Query;
}

function sdkEffort(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (SDK_EFFORTS.has(value)) return value;
  throw connectorError(
    CLAUDE_AGENT_SDK_CONNECTOR_ERRORS.unsupportedEffort,
    `Claude Agent SDK does not support effort: ${value}`,
  );
}

/**
 * Create the `connect` callback consumed by `createClaudeAgentSdkAdapter`.
 */
export function createClaudeAgentSdkConnector(
  options: ClaudeAgentSdkConnectorOptions,
): (request: ClaudeAgentSdkConnectRequest) => Promise<ClaudeAgentSdkConnection> {
  const name = options.toolServerName ?? CLAUDE_AGENT_SDK_TOOL_SERVER;
  const version = options.toolServerVersion ?? "1.0.0";
  if (name.trim() === "" || version.trim() === "") {
    throw new Error("Claude tool server name and version cannot be empty");
  }
  if (
    options.toolTimeoutMs !== undefined
    && (!Number.isSafeInteger(options.toolTimeoutMs) || options.toolTimeoutMs < 1_000)
  ) {
    throw new Error("Claude toolTimeoutMs must be an integer of at least 1000");
  }
  const createQuery = options.createQuery ?? sdkQuery;

  return async (request): Promise<ClaudeAgentSdkConnection> => {
    if (request.signal.aborted) throw new HarnessAdapterInterruptedError();
    const configured = validateConfiguration(await options.configure(request), name);
    if (request.signal.aborted) throw new HarnessAdapterInterruptedError();

    const applicationTools = toolServer(request, name, version);
    const prompt = createPushableAsyncIterable<unknown>();
    const abortController = new AbortController();
    const abort = (): void => abortController.abort();
    request.signal.addEventListener("abort", abort, { once: true });

    const postCompact: HookCallback = async (input) => {
      if (input.hook_event_name === "PostCompact") {
        request.noteCompactSummary(input.compact_summary);
      }
      return {};
    };
    const extra = { ...(configured.extensions ?? {}) };
    const hooks: Record<string, HookCallbackMatcher[]> = {
      PostCompact: [{ hooks: [postCompact] }],
    };
    const mcpServers = cloneMcpServers(configured.mcpServers);
    mcpServers[name] = {
      type: "sdk",
      name,
      instance: applicationTools,
      ...(options.toolTimeoutMs ? { timeout: options.toolTimeoutMs } : {}),
    };
    const effort = sdkEffort(request.effort);
    const sdkOptions: Readonly<Record<string, unknown>> = {
      ...extra,
      abortController,
      cwd: configured.cwd,
      env: { ...configured.env },
      tools: validateStringList(configured.tools, "Claude tools"),
      skills: validateStringList(configured.skills, "Claude skills"),
      settingSources: [...configured.settingSources],
      strictMcpConfig: true,
      permissionMode: configured.permissionMode as PermissionMode,
      systemPrompt: configured.systemPrompt,
      ...(configured.maxTurns === undefined ? {} : { maxTurns: configured.maxTurns }),
      ...(configured.managedSettings ? { managedSettings: configured.managedSettings } : {}),
      ...(configured.sandbox ? { sandbox: configured.sandbox } : {}),
      ...(configured.plugins ? { plugins: configured.plugins.map((plugin) => ({ ...plugin })) } : {}),
      ...(configured.forwardSubagentText === undefined
        ? {}
        : { forwardSubagentText: configured.forwardSubagentText }),
      ...(configured.agentProgressSummaries === undefined
        ? {}
        : { agentProgressSummaries: configured.agentProgressSummaries }),
      ...(configured.persistSession === undefined ? {} : { persistSession: configured.persistSession }),
      ...(configured.allowDangerouslySkipPermissions === undefined
        ? {}
        : { allowDangerouslySkipPermissions: configured.allowDangerouslySkipPermissions }),
      mcpServers,
      hooks,
      canUseTool: async (
        toolName: string,
        input: Record<string, unknown>,
        detail?: {
          toolUseID?: string;
          agentID?: string;
          blockedPath?: string;
          decisionReason?: string;
          title?: string;
          displayName?: string;
          description?: string;
        },
      ) => {
        const metadata = detail ?? {};
        const decision = await request.canUseTool({
          toolName,
          input,
          ...(metadata.toolUseID ? { toolUseId: metadata.toolUseID } : {}),
          ...(metadata.agentID ? { agentId: metadata.agentID } : {}),
          ...(metadata.blockedPath ? { blockedPath: metadata.blockedPath } : {}),
          ...(metadata.decisionReason ? { decisionReason: metadata.decisionReason } : {}),
          ...(metadata.title ? { title: metadata.title } : {}),
          ...(metadata.displayName ? { displayName: metadata.displayName } : {}),
          ...(metadata.description ? { description: metadata.description } : {}),
        });
        return decision.behavior === "allow"
          ? {
              behavior: "allow" as const,
              updatedInput: decision.updatedInput ?? input,
              ...(metadata.toolUseID ? { toolUseID: metadata.toolUseID } : {}),
            }
          : {
              behavior: "deny" as const,
              message: decision.message ?? "The host denied this call.",
              ...(metadata.toolUseID ? { toolUseID: metadata.toolUseID } : {}),
            };
      },
      stderr: (chunk: string) => options.onStderr?.(chunk, request),
      ...(request.model ? { model: request.model } : {}),
      ...(effort ? { effort } : {}),
      ...(request.resumeToken ? { resume: request.resumeToken } : {}),
    };

    let sdk: ClaudeAgentSdkQueryLike;
    try {
      sdk = createQuery({ prompt, options: sdkOptions });
    } catch (error) {
      request.signal.removeEventListener("abort", abort);
      await applicationTools.close().catch(() => undefined);
      throw error;
    }

    let closed = false;
    return {
      messages: sdk,
      async send(input) {
        if (closed || prompt.closed) {
          throw connectorError(
            CLAUDE_AGENT_SDK_CONNECTOR_ERRORS.streamClosed,
            "The Claude input stream is closed.",
          );
        }
        let content: ClaudeAgentSdkPromptContent;
        try {
          content = await (options.mapInput?.(input, request) ?? defaultClaudeAgentSdkInput(input));
        } catch (error) {
          if (error instanceof HarnessAdapterError) throw error;
          throw connectorError(
            CLAUDE_AGENT_SDK_CONNECTOR_ERRORS.inputMappingFailed,
            "Claude input mapping failed.",
          );
        }
        const accepted = prompt.push({
          type: "user",
          message: { role: "user", content },
          parent_tool_use_id: null,
          session_id: "",
        });
        if (!accepted) {
          throw connectorError(
            CLAUDE_AGENT_SDK_CONNECTOR_ERRORS.streamClosed,
            "The Claude input stream is closed.",
          );
        }
      },
      interrupt: async () => { await sdk.interrupt(); },
      stopSubagent: (taskId) => sdk.stopTask(taskId),
      async close() {
        if (closed) return;
        closed = true;
        request.signal.removeEventListener("abort", abort);
        prompt.close();
        abortController.abort();
        await sdk.interrupt().catch(() => undefined);
        try {
          sdk.close();
        } catch {}
        await applicationTools.close().catch(() => undefined);
      },
    };
  };
}

export const CLAUDE_AGENT_SDK_DISCOVERY_ERRORS = {
  failed: "CLAUDE_DISCOVERY_FAILED",
  signedOut: "CLAUDE_DISCOVERY_SIGNED_OUT",
} as const;

/** Process placement for a discovery probe. It grants no tools or settings. */
export interface ClaudeAgentSdkDiscoveryConfiguration {
  cwd: string;
  /** Exact subprocess environment. It is never merged with `process.env`. */
  env: Readonly<Record<string, string>>;
  /** Provider launch options such as `pathToClaudeCodeExecutable`. */
  extensions?: Readonly<Record<string, unknown>>;
}

export interface ClaudeAgentSdkDiscoveryQueryLike {
  supportedModels(): Promise<unknown>;
  accountInfo?(): Promise<unknown>;
  /** The Agent SDK marks its usage request experimental. It may be absent. */
  usage?(): Promise<unknown>;
  close(): void;
}

export interface ClaudeAgentSdkDiscoveryOptions {
  configure(
    request: HarnessDiscoveryRequest,
  ): Promise<ClaudeAgentSdkDiscoveryConfiguration> | ClaudeAgentSdkDiscoveryConfiguration;
  /** How long a model catalog is served from cache. Defaults to ten minutes. */
  modelsTtlMs?: number;
  /** How long a limit snapshot is served from cache. Defaults to one minute. */
  limitsTtlMs?: number;
  /** Bound one probe, including process start. Defaults to fifteen seconds. */
  timeoutMs?: number;
  now?: () => Date;
  /** Receives private SDK stderr. */
  onStderr?(chunk: string): void;
  /** Deterministic injection seam. Production callers should omit it. */
  createQuery?(request: ClaudeAgentSdkQueryRequest): ClaudeAgentSdkDiscoveryQueryLike;
}

export interface ClaudeAgentSdkDiscovery {
  models(request: HarnessDiscoveryRequest): Promise<HarnessDiscovery<HarnessModelCatalog>>;
  limits(request: HarnessDiscoveryRequest): Promise<HarnessDiscovery<HarnessLimitSnapshot>>;
}

interface DiscoveryProbe {
  at: number;
  models: HarnessDiscovery<HarnessModelCatalog>;
  limits: HarnessDiscovery<HarnessLimitSnapshot>;
}

function sdkDiscoveryQuery(request: ClaudeAgentSdkQueryRequest): ClaudeAgentSdkDiscoveryQueryLike {
  const sdk = query({
    prompt: request.prompt as AsyncIterable<SDKUserMessage>,
    options: request.options as Options,
  });
  return {
    supportedModels: () => sdk.supportedModels(),
    accountInfo: () => sdk.accountInfo(),
    usage: () => sdk.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(),
    close: () => sdk.close(),
  };
}

function signedOut(account: unknown): boolean {
  if (typeof account !== "object" || account === null) return false;
  const info = account as Record<string, unknown>;
  const provider = info.apiProvider ?? "firstParty";
  return provider === "firstParty" && info.tokenSource === "none" && !info.apiKeySource;
}

function duration(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved < 0) throw new Error(`${name} must not be negative`);
  return resolved;
}

/**
 * Live model and limit sources for `createClaudeAgentSdkAdapter`.
 *
 * One short-lived SDK process answers control requests and is closed. Its
 * input stream never yields, so no turn starts and no session is persisted.
 */
export function createClaudeAgentSdkDiscovery(
  options: ClaudeAgentSdkDiscoveryOptions,
): ClaudeAgentSdkDiscovery {
  const modelsTtlMs = duration(options.modelsTtlMs, 600_000, "modelsTtlMs");
  const limitsTtlMs = duration(options.limitsTtlMs, 60_000, "limitsTtlMs");
  const timeoutMs = duration(options.timeoutMs, 15_000, "timeoutMs");
  const now = options.now ?? (() => new Date());
  const createQuery = options.createQuery ?? sdkDiscoveryQuery;
  const cache = new Map<string, DiscoveryProbe>();
  const pending = new Map<string, Promise<DiscoveryProbe>>();

  const failure = (code: string, message: string): DiscoveryProbe => {
    const result = { status: "unavailable" as const, message, code, retryable: true };
    return { at: Number.NEGATIVE_INFINITY, models: result, limits: result };
  };

  const probe = async (request: HarnessDiscoveryRequest): Promise<DiscoveryProbe> => {
    const prompt = createPushableAsyncIterable<unknown>();
    const abortController = new AbortController();
    let sdk: ClaudeAgentSdkDiscoveryQueryLike | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const configured = await options.configure(request);
      sdk = createQuery({
        prompt,
        options: {
          ...(configured.extensions ?? {}),
          abortController,
          cwd: configured.cwd,
          env: { ...configured.env },
          tools: [],
          skills: [],
          settingSources: [],
          strictMcpConfig: true,
          mcpServers: {},
          permissionMode: "default",
          systemPrompt: "",
          persistSession: false,
          stderr: (chunk: string) => options.onStderr?.(chunk),
        },
      });
      const running = sdk;
      const answered = (async () => {
        const models = claudeAgentSdkModelCatalog(await running.supportedModels());
        const account = await running.accountInfo?.().catch(() => undefined);
        const usage = signedOut(account) ? undefined : await running.usage?.().catch(() => undefined);
        return { models, account, usage };
      })();
      const expired = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
      });
      answered.catch(() => undefined);
      const { models, account, usage } = await Promise.race([answered, expired]);
      if (signedOut(account)) {
        return failure(CLAUDE_AGENT_SDK_DISCOVERY_ERRORS.signedOut, "Claude Code is not signed in.");
      }
      if (models.models.length === 0) {
        return failure(CLAUDE_AGENT_SDK_DISCOVERY_ERRORS.failed, "Claude Code listed no models.");
      }
      const at = now();
      const limits = claudeAgentSdkUsageLimitSnapshot(usage);
      return {
        at: at.getTime(),
        models: { status: "available", value: models, fetchedAt: at.toISOString() },
        limits: limits
          ? {
              status: "available",
              value: limits,
              fetchedAt: at.toISOString(),
              expiresAt: new Date(at.getTime() + limitsTtlMs).toISOString(),
            }
          : { status: "unsupported", message: "This Claude account reports no plan limits." },
      };
    } catch {
      return failure(
        CLAUDE_AGENT_SDK_DISCOVERY_ERRORS.failed,
        "Claude Code did not answer discovery. Check that it is installed and signed in.",
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      prompt.close();
      abortController.abort();
      try {
        sdk?.close();
      } catch {}
    }
  };

  const resolve = async (request: HarnessDiscoveryRequest, ttlMs: number): Promise<DiscoveryProbe> => {
    const key = request.accountId ?? "";
    const cached = cache.get(key);
    if (cached && now().getTime() - cached.at < ttlMs) return cached;
    let running = pending.get(key);
    if (!running) {
      running = probe(request).then((result) => {
        if (result.models.status === "available") cache.set(key, result);
        else cache.delete(key);
        return result;
      }).finally(() => pending.delete(key));
      pending.set(key, running);
    }
    return running;
  };

  return {
    models: async (request) => (await resolve(request, modelsTtlMs)).models,
    limits: async (request) => (await resolve(request, limitsTtlMs)).limits,
  };
}
