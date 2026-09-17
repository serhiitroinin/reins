/** Versioned JSON-RPC command surface for operating the harness from any stack. */

import type { HarnessPreparedContext } from "./context.js";
import type {
  HarnessCapabilities,
  HarnessEvent,
  HarnessInteractionResponse,
  HarnessSessionKey,
  HarnessSteeringStrategy,
  HarnessTurnStatus,
} from "./protocol.js";
import type {
  HarnessDiscovery,
  HarnessEngineProfile,
  HarnessLimitSnapshot,
  HarnessModelCatalog,
} from "./profile.js";
import type { HarnessDiagnostic } from "./runtime.js";
import type { HarnessToolDescriptor, HarnessToolResult } from "./tools.js";
import type {
  HarnessJsonObject,
  HarnessJsonValue,
  HarnessWireDiscoveryRequest,
  HarnessWireInput,
  HarnessWireRunRequest,
  HarnessWireRunSettings,
} from "./wire.js";

export const HARNESS_SIDECAR_PROTOCOL_VERSION = 1 as const;

export const HARNESS_SIDECAR_ERROR_CODES = {
  methodNotFound: -32601,
  invalidParams: -32602,
  notInitialized: -32001,
  alreadyInitialized: -32002,
  runNotFound: -32004,
  admissionFailed: -32010,
  runtimeFailed: -32020,
  closed: -32030,
} as const;

export const HARNESS_SIDECAR_METHODS = {
  initialize: "harness/initialize",
  capabilities: "harness/capabilities",
  profile: "harness/profile",
  models: "harness/models",
  limits: "harness/limits",
  runStart: "harness/run/start",
  runFollowUp: "harness/run/follow-up",
  runCancel: "harness/run/cancel",
  runRespond: "harness/run/respond",
  runStopSubagent: "harness/run/stop-subagent",
  eventsList: "harness/events/list",
  sessionReset: "harness/session/reset",
  shutdown: "harness/shutdown",
} as const;

export const HARNESS_SIDECAR_HOST_METHODS = {
  toolCall: "host/tool/call",
} as const;

export const HARNESS_SIDECAR_NOTIFICATIONS = {
  event: "harness/event",
  runSettled: "harness/run/settled",
  diagnostic: "harness/diagnostic",
  hostToolCancel: "host/tool/cancel",
} as const;

export type HarnessSidecarMethod = typeof HARNESS_SIDECAR_METHODS[keyof typeof HARNESS_SIDECAR_METHODS];
export type HarnessSidecarHostMethod = typeof HARNESS_SIDECAR_HOST_METHODS[keyof typeof HARNESS_SIDECAR_HOST_METHODS];
export type HarnessSidecarNotification = typeof HARNESS_SIDECAR_NOTIFICATIONS[keyof typeof HARNESS_SIDECAR_NOTIFICATIONS];

export interface HarnessSidecarClientInfo {
  name: string;
  version?: string;
}

export interface HarnessSidecarServerInfo {
  name: string;
  version?: string;
}

export interface HarnessSidecarInitializeParams {
  protocolVersion: typeof HARNESS_SIDECAR_PROTOCOL_VERSION;
  client: HarnessSidecarClientInfo;
  /** Used for runs that do not provide their own catalog. */
  tools?: readonly HarnessToolDescriptor[];
}

export interface HarnessSidecarInitializeResult {
  protocolVersion: typeof HARNESS_SIDECAR_PROTOCOL_VERSION;
  server: HarnessSidecarServerInfo;
  adapters: readonly string[];
  methods: readonly HarnessSidecarMethod[];
  hostMethods: readonly HarnessSidecarHostMethod[];
  notifications: readonly HarnessSidecarNotification[];
}

export interface HarnessSidecarAdapterParams {
  adapterId: string;
}

export interface HarnessSidecarDiscoveryParams extends HarnessWireDiscoveryRequest {}

/** JSON-safe host-prepared context. Application-only state remains in the host. */
export type HarnessSidecarPreparedContext = HarnessPreparedContext<{
  instructions?: string;
  content: readonly HarnessWireInput[];
}>;

export interface HarnessSidecarRunStartParams {
  request: HarnessWireRunRequest;
  runId?: string;
  turnId?: string;
  /** Opaque non-secret identity fingerprint that must remain stable on resume. */
  sessionBinding?: string;
  /** Overrides the initialize-time catalog for this run. */
  tools?: readonly HarnessToolDescriptor[];
  /** When supplied, in-process context sources are bypassed for this turn. */
  context?: HarnessSidecarPreparedContext;
}

export interface HarnessSidecarRunIdentity {
  runId: string;
  turnId: string;
}

/** A complete replacement snapshot. Omitted fields are intentionally cleared. */
export interface HarnessSidecarReplacementExecution {
  accountId?: string;
  model?: string;
  effort?: string;
  settings?: HarnessWireRunSettings;
  configuration?: HarnessJsonObject;
}

export interface HarnessSidecarReplacementOptions {
  runId?: string;
  turnId?: string;
  execution?: HarnessSidecarReplacementExecution;
  sessionBinding?: string;
  tools?: readonly HarnessToolDescriptor[];
  context?: HarnessSidecarPreparedContext;
}

export interface HarnessSidecarFollowUpParams {
  runId: string;
  expectedTurnId: string;
  input: readonly HarnessWireInput[];
  inlineContext?: HarnessWireRunRequest["inlineContext"];
  metadata?: HarnessJsonObject;
  strategy?: HarnessSteeringStrategy;
  /** Presence requests a replacement turn; execution changes are readmitted. */
  replacement?: HarnessSidecarReplacementOptions;
}

export interface HarnessSidecarFollowUpResult extends HarnessSidecarRunIdentity {
  strategy: HarnessSteeringStrategy;
}

export interface HarnessSidecarRunParams {
  runId: string;
}

export interface HarnessSidecarRespondParams extends HarnessSidecarRunParams {
  interactionId: string;
  response: HarnessInteractionResponse;
}

export interface HarnessSidecarStopSubagentParams extends HarnessSidecarRunParams {
  taskId: string;
}

export interface HarnessSidecarStopSubagentResult {
  stopped: boolean;
}

export interface HarnessSidecarEventsListParams {
  session: HarnessSessionKey;
  adapterId: string;
  after?: number;
}

export interface HarnessSidecarEventsListResult {
  events: readonly HarnessEvent[];
}

export interface HarnessSidecarSessionResetParams {
  session: HarnessSessionKey;
  adapterId: string;
}

export interface HarnessSidecarEventNotification {
  event: HarnessEvent;
}

export interface HarnessSidecarRunSettledNotification extends HarnessSidecarRunIdentity {
  status: HarnessTurnStatus;
}

export interface HarnessSidecarDiagnosticNotification {
  diagnostic: HarnessDiagnostic;
}

export interface HarnessSidecarToolCallParams extends HarnessSidecarRunIdentity {
  protocolVersion: typeof HARNESS_SIDECAR_PROTOCOL_VERSION;
  callId: string;
  session: HarnessSessionKey;
  adapterId: string;
  name: string;
  input: HarnessJsonValue;
}

export type HarnessSidecarToolCallResult = HarnessToolResult;

export interface HarnessSidecarToolCancelNotification {
  callId: string;
  runId: string;
  turnId: string;
}

export type HarnessSidecarCapabilitiesResult = HarnessCapabilities;
export type HarnessSidecarProfileResult = HarnessDiscovery<HarnessEngineProfile>;
export type HarnessSidecarModelsResult = HarnessDiscovery<HarnessModelCatalog>;
export type HarnessSidecarLimitsResult = HarnessDiscovery<HarnessLimitSnapshot>;
