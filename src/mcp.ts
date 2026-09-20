/** A transport-neutral MCP stdio protocol surface over one trusted tool host. */

import type {
  HarnessToolContent,
  HarnessToolContext,
  HarnessToolDescriptor,
  HarnessToolHost,
  HarnessToolResult,
} from "./tools.js";

/** MCP versions implemented by the bounded JSON-RPC server, newest first. */
export const HARNESS_MCP_PROTOCOL_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
  "2024-10-07",
] as const;

export const HARNESS_MCP_LATEST_PROTOCOL_VERSION = HARNESS_MCP_PROTOCOL_VERSIONS[0];

/** The default maximum size of one inbound or outbound MCP frame. */
export const HARNESS_MCP_DEFAULT_MAX_FRAME_BYTES = 4_000_000;

export interface HarnessMcpServerInfo {
  name: string;
  version: string;
}

export interface HarnessMcpServerOptions {
  host: HarnessToolHost;
  /** Captured by the host. A caller on the wire cannot replace this scope. */
  context: HarnessToolContext;
  serverInfo: HarnessMcpServerInfo;
  /**
   * Synchronously accept or buffer one COMPLETE frame, including its newline.
   * A partial or asynchronous transport needs its own draining queue here and
   * must throw if the frame cannot be retained whole.
   */
  write(frame: Uint8Array): void;
  maxFrameBytes?: number;
  maxConcurrentCalls?: number;
  maxToolsPerPage?: number;
  protocolVersions?: readonly string[];
}

export interface HarnessMcpServer {
  /** Feed raw bytes from any local, remote, browser, or native transport. */
  receive(chunk: Uint8Array): void;
  /** Abort active tool calls and permanently close this scoped server. */
  end(reason?: string): void;
  readonly closed: boolean;
  readonly initialized: boolean;
}

type JsonRpcId = string | number;
type JsonRecord = Record<string, unknown>;

const encoder = new TextEncoder();
const JSON_RPC_VERSION = "2.0";
const ID_MAX_CHARS = 256;
const DEFAULT_MAX_CONCURRENT_CALLS = 16;
const DEFAULT_MAX_TOOLS_PER_PAGE = 100;
const TOOL_CURSOR_PREFIX = "reins:v1:";

const isRecord = (value: unknown): value is JsonRecord => (
  typeof value === "object" && value !== null && !Array.isArray(value)
);

const requestId = (value: unknown): JsonRpcId | null => {
  if (typeof value === "string") return value.length <= ID_MAX_CHARS ? value : null;
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  return null;
};

const requestKey = (id: JsonRpcId): string => `${typeof id}:${id}`;

const failedResult = (name: string): HarnessToolResult => ({
  content: [{ type: "text", text: `Tool failed: ${name}` }],
  isError: true,
  code: "TOOL_EXECUTION_FAILED",
});

/**
 * Expose a `HarnessToolHost` as a bounded MCP server without choosing a
 * process, socket, HTTP stack, credential mechanism, or provider SDK.
 */
export function createHarnessMcpServer(options: HarnessMcpServerOptions): HarnessMcpServer {
  const maximum = options.maxFrameBytes ?? HARNESS_MCP_DEFAULT_MAX_FRAME_BYTES;
  if (!Number.isSafeInteger(maximum) || maximum < 1) {
    throw new Error("maxFrameBytes must be a positive integer");
  }
  if (options.serverInfo.name.trim() === "" || options.serverInfo.version.trim() === "") {
    throw new Error("MCP server name and version cannot be empty");
  }
  const maximumCalls = options.maxConcurrentCalls ?? DEFAULT_MAX_CONCURRENT_CALLS;
  if (!Number.isSafeInteger(maximumCalls) || maximumCalls < 1) {
    throw new Error("maxConcurrentCalls must be a positive integer");
  }
  const maximumTools = options.maxToolsPerPage ?? DEFAULT_MAX_TOOLS_PER_PAGE;
  if (!Number.isSafeInteger(maximumTools) || maximumTools < 1) {
    throw new Error("maxToolsPerPage must be a positive integer");
  }
  const versions = [...(options.protocolVersions ?? HARNESS_MCP_PROTOCOL_VERSIONS)];
  if (versions.length === 0 || versions.some((version) => version.trim() === "")) {
    throw new Error("at least one non-empty MCP protocol version is required");
  }
  const serverInfo = { ...options.serverInfo };

  let buffer = new Uint8Array(Math.min(maximum, 4_096));
  let buffered = 0;
  let phase: "new" | "initializing" | "initialized" = "new";
  let closed = false;
  let toolCatalog: readonly JsonRecord[] | null = null;
  const active = new Map<string, AbortController>();

  const end = (_reason = "the MCP server ended"): void => {
    if (closed) return;
    closed = true;
    buffered = 0;
    options.context.signal.removeEventListener("abort", endOnContextAbort);
    for (const controller of active.values()) controller.abort();
    active.clear();
  };
  const endOnContextAbort = (): void => end("the tool context ended");
  if (options.context.signal.aborted) endOnContextAbort();
  else options.context.signal.addEventListener("abort", endOnContextAbort, { once: true });

  const encodeValue = (value: unknown): Uint8Array | null => {
    try {
      const frame = encoder.encode(`${JSON.stringify(value)}\n`);
      return frame.byteLength <= maximum ? frame : null;
    } catch {
      return null;
    }
  };

  const writeValue = (value: unknown): boolean => {
    if (closed) return false;
    const frame = encodeValue(value);
    if (frame === null) return false;
    try {
      options.write(frame);
      return true;
    } catch {
      end("the MCP transport write failed");
      return false;
    }
  };

  const sendError = (id: JsonRpcId | null, code: number, message: string): void => {
    if (!writeValue({ jsonrpc: JSON_RPC_VERSION, id, error: { code, message } })) end();
  };
  const sendResult = (id: JsonRpcId, result: unknown): void => {
    if (writeValue({ jsonrpc: JSON_RPC_VERSION, id, result })) return;
    sendError(id, -32603, "The MCP response exceeded its safe frame limit.");
  };

  const requireInitialized = (id: JsonRpcId): boolean => {
    if (phase === "initialized") return true;
    sendError(id, -32002, "Server not initialized");
    return false;
  };

  const initialize = (id: JsonRpcId, params: unknown): void => {
    if (phase !== "new") {
      sendError(id, -32600, "The MCP server is already initialized.");
      return;
    }
    if (
      !isRecord(params)
      || typeof params.protocolVersion !== "string"
      || !isRecord(params.capabilities)
      || !isRecord(params.clientInfo)
      || typeof params.clientInfo.name !== "string"
      || typeof params.clientInfo.version !== "string"
    ) {
      sendError(id, -32602, "Invalid initialize parameters.");
      return;
    }
    phase = "initializing";
    const protocolVersion = versions.includes(params.protocolVersion)
      ? params.protocolVersion
      : versions[0]!;
    sendResult(id, {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo,
    });
  };

  const listTools = (id: JsonRpcId, params: unknown): void => {
    if (!requireInitialized(id)) return;
    const cursor = listCursor(params);
    if (cursor === null) {
      sendError(id, -32602, "Invalid tools/list cursor.");
      return;
    }
    try {
      toolCatalog ??= options.host.list(options.context).map((tool: HarnessToolDescriptor) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        }));
    } catch {
      sendError(id, -32603, "The tool catalog is unavailable.");
      return;
    }
    if (cursor > toolCatalog.length) {
      sendError(id, -32602, "Invalid tools/list cursor.");
      return;
    }
    let end = Math.min(toolCatalog.length, cursor + maximumTools);
    for (;;) {
      if (end === cursor && cursor < toolCatalog.length) {
        sendError(id, -32603, "A tool descriptor exceeded the MCP frame limit.");
        return;
      }
      const result = {
        tools: toolCatalog.slice(cursor, end),
        ...(end < toolCatalog.length ? { nextCursor: toolCursor(end) } : {}),
      };
      if (encodeValue({ jsonrpc: JSON_RPC_VERSION, id, result }) !== null) {
        sendResult(id, result);
        return;
      }
      end -= 1;
    }
  };

  const callTool = async (id: JsonRpcId, params: unknown): Promise<void> => {
    if (!requireInitialized(id)) return;
    if (!isRecord(params) || typeof params.name !== "string" || params.name.trim() === "") {
      sendError(id, -32602, "Invalid tools/call parameters.");
      return;
    }
    const input = params.arguments ?? {};
    if (!isRecord(input)) {
      sendError(id, -32602, "Tool arguments must be an object.");
      return;
    }
    const key = requestKey(id);
    if (active.has(key)) {
      sendError(id, -32600, "A request with this id is already active.");
      return;
    }
    if (active.size >= maximumCalls) {
      sendError(id, -32000, "Too many tool calls are active.");
      return;
    }
    const controller = new AbortController();
    active.set(key, controller);
    const context: HarnessToolContext = { ...options.context, signal: controller.signal };
    let result: HarnessToolResult;
    try {
      result = await options.host.call(params.name, input, context);
    } catch {
      if (controller.signal.aborted) return;
      result = failedResult(params.name);
    } finally {
      active.delete(key);
    }
    if (closed || controller.signal.aborted) return;
    try {
      sendResult(id, mcpToolResult(result));
    } catch {
      sendResult(id, mcpToolResult(failedResult(params.name)));
    }
  };

  const handleRequest = (id: JsonRpcId, method: string, params: unknown): void => {
    switch (method) {
      case "initialize":
        initialize(id, params);
        return;
      case "ping":
        if (requireInitialized(id)) sendResult(id, {});
        return;
      case "tools/list":
        listTools(id, params);
        return;
      case "tools/call":
        void callTool(id, params);
        return;
      default:
        sendError(id, -32601, `Method not found: ${method}`);
    }
  };

  const handleNotification = (method: string, params: unknown): void => {
    if (method === "notifications/initialized") {
      if (phase === "initializing") phase = "initialized";
      return;
    }
    if (method !== "notifications/cancelled" || !isRecord(params)) return;
    const id = requestId(params.requestId);
    if (id !== null) active.get(requestKey(id))?.abort();
  };

  const handleFrame = (frame: unknown): void => {
    if (!isRecord(frame) || frame.jsonrpc !== JSON_RPC_VERSION || typeof frame.method !== "string") {
      sendError(null, -32600, "Invalid JSON-RPC request.");
      return;
    }
    if (!("id" in frame)) {
      handleNotification(frame.method, frame.params);
      return;
    }
    const id = requestId(frame.id);
    if (id === null) {
      sendError(null, -32600, "Invalid JSON-RPC request id.");
      return;
    }
    handleRequest(id, frame.method, frame.params);
  };

  const receive = (chunk: Uint8Array): void => {
    if (closed || chunk.byteLength === 0) return;
    let start = 0;
    for (let at = 0; at < chunk.byteLength; at += 1) {
      if (chunk[at] !== 10) continue;
      if (!append(chunk.subarray(start, at)) || buffered + 1 > maximum) {
        end("an MCP frame exceeded its safe limit");
        return;
      }
      const line = buffer.slice(0, buffered);
      buffered = 0;
      start = at + 1;
      if (line.byteLength === 0) continue;
      let decoded: string;
      let frame: unknown;
      try {
        decoded = new TextDecoder("utf-8", { fatal: true }).decode(line).trim();
        if (decoded === "") continue;
        frame = JSON.parse(decoded);
      } catch {
        end("the MCP transport sent a malformed frame");
        return;
      }
      handleFrame(frame);
      if (closed) return;
    }
    if (!append(chunk.subarray(start))) end("an MCP frame exceeded its safe limit");
  };

  const append = (chunk: Uint8Array): boolean => {
    if (buffered + chunk.byteLength > maximum) return false;
    const needed = buffered + chunk.byteLength;
    if (needed > buffer.byteLength) {
      let capacity = buffer.byteLength;
      while (capacity < needed) capacity = Math.min(maximum, Math.max(capacity * 2, needed));
      const grown = new Uint8Array(capacity);
      grown.set(buffer.subarray(0, buffered));
      buffer = grown;
    }
    buffer.set(chunk, buffered);
    buffered = needed;
    return true;
  };

  return {
    receive,
    end,
    get closed() {
      return closed;
    },
    get initialized() {
      return phase === "initialized";
    },
  };
}

function toolCursor(offset: number): string {
  return `${TOOL_CURSOR_PREFIX}${offset}`;
}

function listCursor(params: unknown): number | null {
  if (params === undefined) return 0;
  if (!isRecord(params)) return null;
  if (params.cursor === undefined) return 0;
  if (typeof params.cursor !== "string" || !params.cursor.startsWith(TOOL_CURSOR_PREFIX)) return null;
  const offset = Number(params.cursor.slice(TOOL_CURSOR_PREFIX.length));
  return Number.isSafeInteger(offset) && offset >= 0 && toolCursor(offset) === params.cursor
    ? offset
    : null;
}

function mcpToolResult(result: HarnessToolResult): JsonRecord {
  const content = Array.isArray(result.content)
    ? result.content.map(mcpToolContent)
    : [{ type: "text", text: "The tool returned an invalid result." }];
  return {
    content,
    ...(result.isError === true ? { isError: true } : {}),
  };
}

function mcpToolContent(content: HarnessToolContent): JsonRecord {
  switch (content.type) {
    case "text":
      return { type: "text", text: content.text };
    case "image":
      return { type: "image", data: content.data, mimeType: content.mediaType };
    case "resource":
      return {
        type: "resource",
        resource: {
          uri: content.uri,
          ...(content.mediaType ? { mimeType: content.mediaType } : {}),
          text: content.text ?? "",
        },
      };
  }
}
