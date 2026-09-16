/**
 * Provider-neutral values exchanged between a harness runtime and its host.
 *
 * The protocol describes what a product can render and answer. Provider SDK
 * objects stay behind adapters so an SDK upgrade cannot silently change this
 * package's public contract.
 */

import type { HarnessRunSettings } from "./profile.js";

export type HarnessId = string;

export interface HarnessSessionKey {
  tenantId: HarnessId;
  actorId: HarnessId;
  threadId: HarnessId;
}

export type CapabilitySupport = "stable" | "experimental" | "unsupported";

export interface HarnessCapability {
  support: CapabilitySupport;
  description?: string;
  constraints?: Readonly<Record<string, unknown>>;
}

/**
 * Whether an interaction callback can be reconstructed after the host process
 * exits. A provider resume token does not imply that its pending callbacks can
 * be answered after restart.
 */
export type HarnessInteractionRecovery = "live-only" | "provider-replay";

export interface HarnessInteractionCapability extends HarnessCapability {
  /**
   * Absent protocol-v1 documents are interpreted as `live-only`. This keeps
   * old capability snapshots conservative while newer adapters state it.
   */
  recovery?: HarnessInteractionRecovery;
}

/** Conservative recovery mode for old capability documents. */
export function harnessInteractionRecovery(
  capability: HarnessInteractionCapability,
): HarnessInteractionRecovery {
  return capability.recovery ?? "live-only";
}

/**
 * How a provider can accept input while a turn is active.
 *
 * Waiting for the current turn is host queue policy, not a provider strategy.
 */
export type HarnessSteeringStrategy = "same-turn" | "replacement-turn";

export interface HarnessSteeringCapability extends HarnessCapability {
  /** Empty means the adapter cannot accept an active-turn follow-up. */
  strategies: readonly HarnessSteeringStrategy[];
  /** The strategy a generic host should choose when it does not override it. */
  preferred?: HarnessSteeringStrategy;
}

export type HarnessSubagentControl = "stop";

export interface HarnessSubagentCapability extends HarnessCapability {
  /** Absent in older v1 documents and interpreted as no controllable actions. */
  controls?: readonly HarnessSubagentControl[];
}

/** Conservative active controls for old or unsupported capability documents. */
export function harnessSubagentControls(
  capability: HarnessSubagentCapability,
): readonly HarnessSubagentControl[] {
  return capability.support === "unsupported" ? [] : capability.controls ?? [];
}

export interface HarnessCapabilities {
  resume: HarnessCapability;
  cancel: HarnessCapability;
  interactions: HarnessInteractionCapability;
  tools: HarnessCapability;
  images: HarnessCapability;
  thinking: HarnessCapability;
  plans: HarnessCapability;
  usage: HarnessCapability;
  subagents: HarnessSubagentCapability;
  shell: HarnessCapability;
  filesystem: HarnessCapability;
  network: HarnessCapability;
  /** Optional because protocol-v1 capability documents are additive. */
  steering?: HarnessSteeringCapability;
  /** Adapter-specific capabilities use namespaced keys such as `acme:review`. */
  extensions?: Readonly<Record<string, HarnessCapability>>;
}

/** A JSON value carried by a typed context record. Binary data is excluded. */
export type HarnessContextValue =
  | null
  | boolean
  | number
  | string
  | readonly HarnessContextValue[]
  | { readonly [key: string]: HarnessContextValue };

export type HarnessContextKind = string & {};

/**
 * Binds a context record to the ordinary provider input that carries its data.
 * The referenced input owns image bytes or a resource URI; the record does not.
 */
export interface HarnessContextBinding {
  type: "attachment" | "resource";
  inputId: string;
  name?: string;
  mediaType?: string;
  sizeBytes?: number;
}

export interface HarnessContextRecord {
  version: 1;
  id: string;
  /** Open host-owned kind such as `issue`, `mail`, or `acme:incident`. */
  kind: HarnessContextKind;
  label: string;
  /** Bounded JSON-only untrusted provider content. Never place host secrets here. */
  payload: HarnessContextValue;
  binding?: HarnessContextBinding;
}

/** Durable record table referenced by ordered `context-reference` inputs. */
export interface HarnessInlineContext {
  version: 1;
  records: readonly HarnessContextRecord[];
}

export type HarnessInput =
  | { type: "text"; text: string }
  | { type: "image"; id?: string; mediaType: string; data: Uint8Array; name?: string }
  | { type: "resource"; id?: string; uri: string; mediaType?: string; name?: string }
  | {
      type: "context-reference";
      contextId: string;
      /** Optional stable identity for this occurrence of a reusable record. */
      referenceId?: string;
    };

export type HarnessToolStatus = "completed" | "failed" | "declined" | "cancelled";
export type HarnessTurnStatus = "completed" | "error" | "interrupted";

export interface HarnessUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  durationMs?: number;
  provider?: Readonly<Record<string, unknown>>;
}

export interface HarnessInteractionChoice {
  id: string;
  label: string;
  description?: string;
  allow?: boolean;
}

export interface HarnessInteraction {
  id: string;
  kind: "permission" | "question" | "confirmation" | (string & {});
  title: string;
  detail?: string;
  choices?: readonly HarnessInteractionChoice[];
  acceptsText?: boolean;
  expiresAt?: string;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface HarnessInteractionResponse {
  choiceId?: string;
  text?: string;
  labels?: readonly string[];
}

/** Why an unanswered interaction can no longer be sent to its provider. */
export type HarnessInteractionInvalidationReason =
  | "turn-ended"
  | "runtime-restarted"
  | "provider-lost-request"
  | "expired"
  | (string & {});

export type HarnessEventPayload =
  | { kind: "turn-started"; model?: string; accountId?: string }
  | { kind: "assistant-text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "plan-updated"; steps: readonly { text: string; status: string }[] }
  | {
      kind: "tool-started";
      toolId: string;
      toolKind: string;
      title: string;
      detail?: string;
      command?: string;
      paths?: readonly string[];
      extensions?: Readonly<Record<string, unknown>>;
    }
  | {
      kind: "tool-updated";
      toolId: string;
      /** Repeated so a bounded replay can begin after `tool-started`. */
      toolKind: string;
      /** Repeated so a bounded replay can begin after `tool-started`. */
      title: string;
      outputAppend?: string;
      detail?: string;
      truncated?: boolean;
      extensions?: Readonly<Record<string, unknown>>;
    }
  | {
      kind: "tool-completed";
      toolId: string;
      status: HarnessToolStatus;
      /** Repeated so a bounded replay can begin after `tool-started`. */
      toolKind: string;
      /** Repeated so a bounded replay can begin after `tool-started`. */
      title: string;
      outputAppend?: string;
      error?: string;
      exitCode?: number;
      truncated?: boolean;
      extensions?: Readonly<Record<string, unknown>>;
    }
  | { kind: "interaction-requested"; interaction: HarnessInteraction }
  | { kind: "interaction-resolved"; interactionId: string; response: HarnessInteractionResponse }
  | {
      kind: "interaction-invalidated";
      interactionId: string;
      reason: HarnessInteractionInvalidationReason;
      /** Safe host-facing guidance. Never a raw provider error. */
      message?: string;
    }
  | { kind: "usage"; usage: HarnessUsage }
  | { kind: "error"; code: string; message: string; retryable?: boolean }
  | { kind: "turn-completed"; status: HarnessTurnStatus; usage?: HarnessUsage }
  | {
      kind: "extension";
      namespace: string;
      name: string;
      payload: unknown;
    };

export interface HarnessEvent {
  schemaVersion: 1;
  eventId: string;
  sequence: number;
  timestamp: string;
  session: HarnessSessionKey;
  runId: string;
  turnId: string;
  adapterId: string;
  payload: HarnessEventPayload;
}

export type HarnessEventInput = Omit<HarnessEvent, "eventId" | "sequence" | "timestamp">;

export interface HarnessRunRequest {
  session: HarnessSessionKey;
  adapterId: string;
  input: readonly HarnessInput[];
  /** Typed records referenced from `input`; input order is the inline order. */
  inlineContext?: HarnessInlineContext;
  model?: string;
  /** Open option id from the selected model effort profile. */
  effort?: string;
  accountId?: string;
  /** Adapter-declared, provider-neutral settings selected by the host. */
  settings?: HarnessRunSettings;
  /** Escape hatch for adapter configuration that has no portable UI contract. */
  configuration?: Readonly<Record<string, unknown>>;
  metadata?: Readonly<Record<string, unknown>>;
}

export function harnessSessionKey(value: HarnessSessionKey, adapterId: string): string {
  return JSON.stringify([value.tenantId, value.actorId, value.threadId, adapterId]);
}

/** A deliberately shallow envelope check for data read from an external store. */
export function isHarnessEvent(value: unknown): value is HarnessEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const event = value as Partial<HarnessEvent>;
  if (event.schemaVersion !== 1 || typeof event.eventId !== "string") return false;
  if (!Number.isSafeInteger(event.sequence) || (event.sequence ?? 0) < 1) return false;
  if (typeof event.timestamp !== "string" || typeof event.runId !== "string") return false;
  if (typeof event.turnId !== "string" || typeof event.adapterId !== "string") return false;
  if (typeof event.session !== "object" || event.session === null) return false;
  if (typeof event.session.tenantId !== "string" || typeof event.session.actorId !== "string") return false;
  if (typeof event.session.threadId !== "string") return false;
  return typeof event.payload === "object"
    && event.payload !== null
    && typeof event.payload.kind === "string";
}
