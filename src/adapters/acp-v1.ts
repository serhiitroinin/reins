/**
 * SDK-free public contracts for the stable Agent Client Protocol v1 adapter.
 *
 * The host owns the process, environment, credentials, workspace policy, and
 * transport. These types deliberately do not expose the official SDK's types.
 */

import { Buffer } from "node:buffer";
import type { HarnessPreparedContext } from "../context.js";
import type {
  HarnessDiscovery,
  HarnessDiscoveryRequest,
  HarnessEngineProfile,
  HarnessLimitSnapshot,
  HarnessModelCatalog,
  HarnessRunSettings,
} from "../profile.js";
import type {
  HarnessCapabilities,
  HarnessInput,
  HarnessInteraction,
  HarnessInteractionResponse,
  HarnessSessionKey,
} from "../protocol.js";
import type { HarnessAdapterRunRequest } from "../runtime.js";

export const ACP_V1_PROTOCOL_VERSION = 1;
export const ACP_V1_NAMESPACE = "agentclientprotocol:v1";

const unsupported = { support: "unsupported" as const };

/** Conservative capabilities of the adapter, before an ACP agent connects. */
export const ACP_V1_CAPABILITIES: HarnessCapabilities = {
  resume: {
    support: "stable",
    description: "Requires the connected ACP agent to advertise session/load.",
    constraints: { requiresAgentCapability: "loadSession" },
  },
  cancel: { support: "stable" },
  interactions: {
    support: "stable",
    recovery: "live-only",
    description: "Pending permission callbacks belong to the live ACP connection unless a future adapter explicitly replays them.",
  },
  tools: {
    support: "stable",
    description: "Normalizes ACP tool lifecycles; tool execution is supplied separately through host-owned MCP servers.",
  },
  images: {
    support: "stable",
    description: "Requires the connected ACP agent to advertise image prompt support.",
    constraints: { requiresAgentCapability: "promptCapabilities.image" },
  },
  thinking: { support: "stable" },
  plans: { support: "stable" },
  usage: {
    support: "experimental",
    description: "ACP v1 usage fields are optional and currently marked unstable by the protocol.",
  },
  subagents: unsupported,
  shell: unsupported,
  filesystem: unsupported,
  network: unsupported,
  steering: {
    support: "stable",
    strategies: ["replacement-turn"],
    preferred: "replacement-turn",
    description: "ACP v1 has no native steer method; the runtime prepares, cancels, drains, retires the transport, and reloads a replacement turn.",
    constraints: { requiresAgentCapability: "loadSession" },
  },
  extensions: {
    [ACP_V1_NAMESPACE]: { support: "stable" },
  },
};

/** Raw bytes flowing from and to a host-owned ACP process or sidecar. */
export interface AcpV1ByteConnection {
  /** NDJSON bytes read from the ACP agent. */
  readable: ReadableStream<Uint8Array>;
  /** NDJSON bytes written to the ACP agent. */
  writable: WritableStream<Uint8Array>;
  /** Must settle both streams and release the process or remote connection. */
  close(): Promise<void> | void;
}

export interface AcpV1ImplementationInfo {
  name: string;
  version: string;
  title?: string;
}

/** Safe projection of the optional behavior negotiated during `initialize`. */
export interface AcpV1NegotiatedAgent {
  protocolVersion: 1;
  agentInfo?: AcpV1ImplementationInfo;
  capabilities: {
    loadSession: boolean;
    imagePrompt: boolean;
    additionalDirectories: boolean;
    mcp: { stdio: true; http: boolean; sse: boolean };
  };
}

export type AcpV1McpServer =
  | {
      type?: "stdio";
      name: string;
      command: string;
      args?: readonly string[];
      env?: Readonly<Record<string, string>>;
    }
  | {
      type: "http" | "sse";
      name: string;
      url: string;
      headers?: Readonly<Record<string, string>>;
    };

export interface AcpV1SessionSetup {
  /** Absolute working directory. It is policy input, not a security boundary. */
  cwd: string;
  additionalDirectories?: readonly string[];
  /** The host owns every server, command, header, environment value, and permission it exposes. */
  mcpServers?: readonly AcpV1McpServer[];
}

export type AcpV1PromptBlock =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: string; data: string; uri?: string }
  | { type: "resource_link"; uri: string; name: string; mediaType?: string };

export interface AcpV1SessionMode {
  id: string;
  name: string;
  description?: string;
}

export interface AcpV1SessionModeState {
  currentModeId: string;
  availableModes: readonly AcpV1SessionMode[];
}

export interface AcpV1SessionConfigValue {
  value: string;
  name: string;
  description?: string;
  group?: { id: string; name: string };
}

export type AcpV1SessionConfigOption =
  | {
      type: "select";
      id: string;
      name: string;
      description?: string;
      category?: string;
      currentValue: string;
      options: readonly AcpV1SessionConfigValue[];
    }
  | {
      type: "boolean";
      id: string;
      name: string;
      description?: string;
      category?: string;
      currentValue: boolean;
    };

/** Safe, SDK-free controls for explicitly mapping model, effort, and provider options. */
export interface AcpV1SessionController {
  readonly sessionId: string;
  readonly modes: AcpV1SessionModeState | null;
  readonly configOptions: readonly AcpV1SessionConfigOption[];
  setMode(modeId: string): Promise<void>;
  setConfigOption(configId: string, value: string | boolean): Promise<void>;
}

export interface AcpV1ConnectRequest {
  session: HarnessSessionKey;
  resumeToken: string | null;
  runId: string;
  turnId: string;
  model?: string;
  effort?: string;
  accountId?: string;
  settings?: HarnessRunSettings;
  configuration?: Readonly<Record<string, unknown>>;
  /** Ends when the adapter session closes, not after the first turn. */
  signal: AbortSignal;
}

export interface AcpV1ToolSnapshot {
  phase: "start" | "update" | "complete";
  toolCallId: string;
  title?: string;
  kind?: string;
  status?: "pending" | "in_progress" | "completed" | "failed";
  /** Sensitive provider values. They are never persisted unless the host returns a presentation. */
  content?: unknown;
  locations?: unknown;
  rawInput?: unknown;
  rawOutput?: unknown;
}

/** Explicitly redacted values that are safe for the Harness event store and UI. */
export interface AcpV1ToolPresentation {
  title?: string;
  toolKind?: string;
  detail?: string;
  command?: string;
  paths?: readonly string[];
  outputAppend?: string;
  error?: string;
  exitCode?: number;
  truncated?: boolean;
  extensions?: Readonly<Record<string, unknown>>;
}

export interface AcpV1PermissionOption {
  id: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}

export interface AcpV1PermissionRequest {
  sessionId: string;
  tool: Omit<AcpV1ToolSnapshot, "phase">;
  options: readonly AcpV1PermissionOption[];
}

export type AcpV1PermissionDecision =
  | { behavior: "select"; optionId: string }
  | { behavior: "cancel" };

export interface AcpV1DeferredPermission {
  behavior: "ask";
  interaction: HarnessInteraction;
  resolve(
    response: HarnessInteractionResponse,
  ): Promise<AcpV1PermissionDecision> | AcpV1PermissionDecision;
}

export type AcpV1PermissionAuthorization = AcpV1PermissionDecision | AcpV1DeferredPermission;

export interface AcpV1PublicError {
  code: string;
  message: string;
  retryable?: boolean;
}

export type AcpV1DiscoverySource<T> =
  | HarnessDiscovery<T>
  | ((request: HarnessDiscoveryRequest) => Promise<HarnessDiscovery<T>> | HarnessDiscovery<T>);

export interface AcpV1AdapterOptions {
  id?: string;
  clientInfo?: AcpV1ImplementationInfo;
  capabilities?: HarnessCapabilities;
  profile?: AcpV1DiscoverySource<HarnessEngineProfile>;
  models?: AcpV1DiscoverySource<HarnessModelCatalog>;
  limits?: AcpV1DiscoverySource<HarnessLimitSnapshot>;
  /** Create one isolated ACP transport when the session's first turn starts. */
  connect(request: AcpV1ConnectRequest): Promise<AcpV1ByteConnection> | AcpV1ByteConnection;
  /** Supply the absolute workspace roots and explicit MCP surface for this session. */
  session(request: HarnessAdapterRunRequest): Promise<AcpV1SessionSetup> | AcpV1SessionSetup;
  /**
   * Render a turn into ACP prompt blocks. The default rejects prepared context,
   * because ACP prompt blocks cannot preserve trusted-instruction semantics.
   */
  mapPrompt?(
    request: HarnessAdapterRunRequest,
  ): Promise<readonly AcpV1PromptBlock[]> | readonly AcpV1PromptBlock[];
  /** Explicitly apply model, effort, Fast/service tier, or other live ACP controls. */
  configureSession?(
    controller: AcpV1SessionController,
    request: HarnessAdapterRunRequest,
  ): Promise<void> | void;
  /** Decide immediately or defer an ACP permission request to the product UI. */
  authorizePermission?(
    request: AcpV1PermissionRequest,
    turn: HarnessAdapterRunRequest,
  ): Promise<AcpV1PermissionAuthorization> | AcpV1PermissionAuthorization;
  /** Opt in to persisting bounded, host-redacted tool presentation fields. */
  presentTool?(
    snapshot: AcpV1ToolSnapshot,
    turn: HarnessAdapterRunRequest,
  ): AcpV1ToolPresentation | undefined;
  /** Map a provider/transport failure only when its result is safe to persist. */
  publicError?(error: unknown): AcpV1PublicError | undefined;
  /** Select the values that must remain fixed for the transport lifetime. */
  connectionKey?(request: HarnessAdapterRunRequest): unknown;
  onLimits?(
    snapshot: HarnessLimitSnapshot,
    request: Pick<AcpV1ConnectRequest, "session" | "accountId" | "runId" | "turnId">,
  ): void;
  onCheckpoint?(
    checkpoint: string,
    request: Pick<AcpV1ConnectRequest, "session" | "accountId" | "runId" | "turnId">,
  ): Promise<void> | void;
  /** Observe a metadata-free projection of the negotiated ACP behavior. */
  onNegotiated?(
    agent: AcpV1NegotiatedAgent,
    request: Pick<AcpV1ConnectRequest, "session" | "accountId" | "runId" | "turnId">,
  ): Promise<void> | void;
  /** Bound an ACP agent that acknowledges cancellation but never ends the prompt. */
  cancelTimeoutMs?: number;
  /** Maximum persisted string length and host-extension JSON byte size from one display field. */
  eventTextLimit?: number;
  /** Maximum assistant and thought text persisted across one turn. */
  turnTextLimit?: number;
  /** Maximum number of entries retained from one provider plan update. */
  planEntryLimit?: number;
}

/**
 * Default prompt mapping for turns without prepared context.
 *
 * Applications with context sources must supply `mapPrompt`, so trusted
 * instructions cannot accidentally become indistinguishable from untrusted
 * user/domain content.
 */
export function defaultAcpV1Prompt(
  input: readonly HarnessInput[],
  context: HarnessPreparedContext<unknown>,
): readonly AcpV1PromptBlock[] {
  if (context.sources.length > 0) {
    throw new Error("ACP_CONTEXT_MAPPING_REQUIRED");
  }
  return input.map((item) => {
    if (item.type === "text") return { type: "text", text: item.text };
    if (item.type === "image") {
      return {
        type: "image",
        mediaType: item.mediaType,
        data: Buffer.from(item.data).toString("base64"),
      };
    }
    return {
      type: "resource_link",
      uri: item.uri,
      name: item.name ?? item.uri,
      ...(item.mediaType ? { mediaType: item.mediaType } : {}),
    };
  });
}

export function defaultAcpV1Profile(id: string): HarnessDiscovery<HarnessEngineProfile> {
  return {
    status: "available",
    value: {
      id,
      label: "ACP v1 Agent",
      description: "A host-managed agent connected through stable ACP v1.",
      permissions: {
        kind: "host-policy",
        selectable: false,
        defaultModeId: "host",
        modes: [{ id: "host", label: "Managed by host", posture: "restricted" }],
        description: "Process, filesystem, terminal, network, and sandbox policy are supplied by the host.",
      },
    },
  };
}
