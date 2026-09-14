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

export interface HarnessCapabilities {
  resume: HarnessCapability;
  cancel: HarnessCapability;
  interactions: HarnessCapability;
  tools: HarnessCapability;
  images: HarnessCapability;
  thinking: HarnessCapability;
  plans: HarnessCapability;
  usage: HarnessCapability;
  subagents: HarnessCapability;
  shell: HarnessCapability;
  filesystem: HarnessCapability;
  network: HarnessCapability;
  /** Adapter-specific capabilities use namespaced keys such as `acme:review`. */
  extensions?: Readonly<Record<string, HarnessCapability>>;
}

export type HarnessInput =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: string; data: Uint8Array; name?: string }
  | { type: "resource"; uri: string; mediaType?: string; name?: string };

export type HarnessToolStatus = "completed" | "failed" | "cancelled";
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

export type HarnessEventPayload =
  | { kind: "turn-started"; model?: string; accountId?: string }
  | { kind: "assistant-text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "plan-updated"; steps: readonly { text: string; status: string }[] }
  | { kind: "tool-started"; toolId: string; toolKind: string; title: string; detail?: string }
  | { kind: "tool-updated"; toolId: string; outputAppend?: string; detail?: string }
  | {
      kind: "tool-completed";
      toolId: string;
      status: HarnessToolStatus;
      outputAppend?: string;
      error?: string;
    }
  | { kind: "interaction-requested"; interaction: HarnessInteraction }
  | { kind: "interaction-resolved"; interactionId: string; response: HarnessInteractionResponse }
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
  model?: string;
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
