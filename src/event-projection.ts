/** Bounded, deny-by-default projection of adapter-owned event extensions. */

import type { HarnessContextValue, HarnessEventPayload } from "./protocol.js";

export const HARNESS_EXTENSION_NAMESPACE_MAX_CHARACTERS = 128;
export const HARNESS_EXTENSION_NAME_MAX_CHARACTERS = 128;
export const HARNESS_EXTENSION_PAYLOAD_MAX_BYTES = 32 * 1024;
export const HARNESS_EXTENSION_VALUE_MAX_DEPTH = 12;
export const HARNESS_EXTENSION_COLLECTION_MAX_ENTRIES = 256;
export const HARNESS_EXTENSION_TOTAL_MAX_ENTRIES = 2_048;
export const HARNESS_EXTENSION_STRING_MAX_CHARACTERS = 32 * 1024;
export const HARNESS_EXTENSION_KEY_MAX_CHARACTERS = 256;

export type HarnessExtensionEvent = Extract<HarnessEventPayload, { kind: "extension" }>;
export type HarnessToolExtensionEvent = Extract<
  HarnessEventPayload,
  { kind: "tool-started" | "tool-updated" | "tool-completed" }
>;

export interface HarnessAdapterPersistenceProjection {
  /**
   * Explicitly select a safe extension payload for durable storage. Returning
   * `undefined` refuses it. The runtime applies its JSON and size bounds after
   * this callback, so returning the original payload is still bounded.
   */
  projectExtension?(event: HarnessExtensionEvent): unknown | undefined;
  /**
   * Explicitly select the safe open metadata map on a tool event. Returning
   * `undefined` removes it and marks the tool presentation truncated.
   */
  projectToolExtensions?(event: HarnessToolExtensionEvent): unknown | undefined;
}

export type HarnessEventProjectionIssueCode =
  | "EXTENSION_ENVELOPE_INVALID"
  | "EXTENSION_NOT_APPROVED"
  | "EXTENSION_PROJECTION_FAILED"
  | "EXTENSION_VALUE_INVALID"
  | "EXTENSION_VALUE_LIMIT_EXCEEDED";

export interface HarnessEventProjectionIssue {
  code: HarnessEventProjectionIssueCode;
  message: string;
}

export interface HarnessEventPersistenceProjection {
  /** `null` means the optional extension event has an invalid envelope. */
  payload: HarnessEventPayload | null;
  issue?: HarnessEventProjectionIssue;
}

export type HarnessExtensionRedactionReason =
  | "not-approved"
  | "projection-failed"
  | "invalid-value"
  | "limit-exceeded";

export interface HarnessRedactedExtensionPayload {
  readonly [key: string]: HarnessContextValue;
  "reins:redacted": true;
  reason: HarnessExtensionRedactionReason;
}

const encoder = new TextEncoder();

function redacted(reason: HarnessExtensionRedactionReason): HarnessRedactedExtensionPayload {
  return { "reins:redacted": true, reason };
}

function plainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

type JsonProjection =
  | { valid: true; value: HarnessContextValue }
  | { valid: false; reason: "invalid-value" | "limit-exceeded" };

function boundedJsonValue(value: unknown): JsonProjection {
  const ancestors = new Set<object>();
  let entries = 0;

  const visit = (candidate: unknown, depth: number): JsonProjection => {
    if (depth > HARNESS_EXTENSION_VALUE_MAX_DEPTH) {
      return { valid: false, reason: "limit-exceeded" };
    }
    if (candidate === null || typeof candidate === "boolean") {
      return { valid: true, value: candidate };
    }
    if (typeof candidate === "string") {
      return candidate.length <= HARNESS_EXTENSION_STRING_MAX_CHARACTERS
        ? { valid: true, value: candidate }
        : { valid: false, reason: "limit-exceeded" };
    }
    if (typeof candidate === "number") {
      return Number.isFinite(candidate) && !Object.is(candidate, -0)
        ? { valid: true, value: candidate }
        : { valid: false, reason: "invalid-value" };
    }
    if (typeof candidate !== "object") return { valid: false, reason: "invalid-value" };
    if (ancestors.has(candidate)) return { valid: false, reason: "invalid-value" };

    ancestors.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        if (candidate.length > HARNESS_EXTENSION_COLLECTION_MAX_ENTRIES) {
          return { valid: false, reason: "limit-exceeded" };
        }
        const keys = Reflect.ownKeys(candidate);
        if (keys.length !== candidate.length + 1) {
          return { valid: false, reason: "invalid-value" };
        }
        entries += candidate.length;
        if (entries > HARNESS_EXTENSION_TOTAL_MAX_ENTRIES) {
          return { valid: false, reason: "limit-exceeded" };
        }
        const output: HarnessContextValue[] = [];
        for (let index = 0; index < candidate.length; index += 1) {
          if (!Object.hasOwn(candidate, index)) return { valid: false, reason: "invalid-value" };
          const descriptor = Object.getOwnPropertyDescriptor(candidate, String(index));
          if (!descriptor?.enumerable || !("value" in descriptor)) {
            return { valid: false, reason: "invalid-value" };
          }
          const projected = visit(descriptor.value, depth + 1);
          if (!projected.valid) return projected;
          output.push(projected.value);
        }
        return { valid: true, value: output };
      }

      if (!plainObject(candidate)) return { valid: false, reason: "invalid-value" };
      const keys = Reflect.ownKeys(candidate);
      if (keys.length > HARNESS_EXTENSION_COLLECTION_MAX_ENTRIES) {
        return { valid: false, reason: "limit-exceeded" };
      }
      entries += keys.length;
      if (entries > HARNESS_EXTENSION_TOTAL_MAX_ENTRIES) {
        return { valid: false, reason: "limit-exceeded" };
      }
      const output: Record<string, HarnessContextValue> = Object.create(null) as Record<string, HarnessContextValue>;
      for (const key of keys) {
        if (typeof key !== "string") return { valid: false, reason: "invalid-value" };
        if (key.length > HARNESS_EXTENSION_KEY_MAX_CHARACTERS) {
          return { valid: false, reason: "limit-exceeded" };
        }
        const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
        if (!descriptor?.enumerable || !("value" in descriptor)) {
          return { valid: false, reason: "invalid-value" };
        }
        const projected = visit(descriptor.value, depth + 1);
        if (!projected.valid) return projected;
        output[key] = projected.value;
      }
      return { valid: true, value: output };
    } finally {
      ancestors.delete(candidate);
    }
  };

  const projected = visit(value, 0);
  if (!projected.valid) return projected;
  const encoded = JSON.stringify(projected.value);
  if (encoded === undefined || encoder.encode(encoded).byteLength > HARNESS_EXTENSION_PAYLOAD_MAX_BYTES) {
    return { valid: false, reason: "limit-exceeded" };
  }
  // Parsing the bounded encoding detaches adapter-owned references and gives
  // every stored object an ordinary JSON prototype without invoking getters.
  return { valid: true, value: JSON.parse(encoded) as HarnessContextValue };
}

function validEnvelopePart(value: unknown, maximum: number): value is string {
  return typeof value === "string"
    && value.trim() === value
    && value.length > 0
    && value.length <= maximum
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function issue(
  code: HarnessEventProjectionIssueCode,
  message: string,
): HarnessEventProjectionIssue {
  return { code, message };
}

function safeProjection(
  value: unknown,
): { value: HarnessContextValue; issue?: HarnessEventProjectionIssue } {
  let projected: JsonProjection;
  try {
    projected = boundedJsonValue(value);
  } catch {
    projected = { valid: false, reason: "invalid-value" };
  }
  if (projected.valid) return { value: projected.value };
  if (projected.reason === "limit-exceeded") {
    return {
      value: redacted("limit-exceeded"),
      issue: issue(
        "EXTENSION_VALUE_LIMIT_EXCEEDED",
        "An adapter event extension exceeded the durable projection limit and was redacted.",
      ),
    };
  }
  return {
    value: redacted("invalid-value"),
    issue: issue(
      "EXTENSION_VALUE_INVALID",
      "An adapter event extension was not a safe JSON value and was redacted.",
    ),
  };
}

function extensionEnvelope(
  payload: HarnessExtensionEvent,
  projectedPayload: HarnessContextValue,
): HarnessExtensionEvent {
  return {
    kind: "extension",
    namespace: payload.namespace,
    name: payload.name,
    payload: projectedPayload,
  };
}

function toolEnvelope(
  payload: HarnessToolExtensionEvent,
  extensions?: Readonly<Record<string, unknown>>,
): HarnessToolExtensionEvent {
  if (payload.kind === "tool-started") {
    return {
      kind: "tool-started",
      toolId: payload.toolId,
      toolKind: payload.toolKind,
      title: payload.title,
      ...(payload.detail !== undefined ? { detail: payload.detail } : {}),
      ...(payload.command !== undefined ? { command: payload.command } : {}),
      ...(payload.paths !== undefined ? { paths: payload.paths } : {}),
      ...(extensions !== undefined ? { extensions } : {}),
    };
  }
  if (payload.kind === "tool-updated") {
    return {
      kind: "tool-updated",
      toolId: payload.toolId,
      toolKind: payload.toolKind,
      title: payload.title,
      ...(payload.outputAppend !== undefined ? { outputAppend: payload.outputAppend } : {}),
      ...(payload.detail !== undefined ? { detail: payload.detail } : {}),
      ...(payload.truncated !== undefined ? { truncated: payload.truncated } : {}),
      ...(extensions !== undefined ? { extensions } : {}),
    };
  }
  return {
    kind: "tool-completed",
    toolId: payload.toolId,
    status: payload.status,
    toolKind: payload.toolKind,
    title: payload.title,
    ...(payload.outputAppend !== undefined ? { outputAppend: payload.outputAppend } : {}),
    ...(payload.error !== undefined ? { error: payload.error } : {}),
    ...(payload.exitCode !== undefined ? { exitCode: payload.exitCode } : {}),
    ...(payload.truncated !== undefined ? { truncated: payload.truncated } : {}),
    ...(extensions !== undefined ? { extensions } : {}),
  };
}

function withoutToolExtensions(payload: HarnessToolExtensionEvent): HarnessToolExtensionEvent {
  const projected = toolEnvelope(payload);
  return projected.kind === "tool-started"
    ? projected
    : { ...projected, truncated: true };
}

/**
 * Project one adapter event into the exact representation the runtime may
 * append and stream. Core payloads are unchanged except for their open tool
 * extension map; top-level extension payloads require adapter opt-in.
 */
export function projectHarnessEventPayloadForPersistence(
  payload: HarnessEventPayload,
  projection: HarnessAdapterPersistenceProjection | undefined,
): HarnessEventPersistenceProjection {
  if (payload.kind === "extension") {
    if (
      !validEnvelopePart(payload.namespace, HARNESS_EXTENSION_NAMESPACE_MAX_CHARACTERS)
      || !validEnvelopePart(payload.name, HARNESS_EXTENSION_NAME_MAX_CHARACTERS)
    ) {
      return {
        payload: null,
        issue: issue(
          "EXTENSION_ENVELOPE_INVALID",
          "An adapter event extension had an invalid envelope and was ignored.",
        ),
      };
    }
    if (!projection?.projectExtension) {
      return {
        payload: extensionEnvelope(payload, redacted("not-approved")),
        issue: issue(
          "EXTENSION_NOT_APPROVED",
          "An adapter event extension was not approved for durable storage and was redacted.",
        ),
      };
    }
    let selected: unknown;
    try {
      selected = projection.projectExtension(payload);
    } catch {
      return {
        payload: extensionEnvelope(payload, redacted("projection-failed")),
        issue: issue(
          "EXTENSION_PROJECTION_FAILED",
          "An adapter event extension projector failed and its payload was redacted.",
        ),
      };
    }
    if (selected === undefined) {
      return {
        payload: extensionEnvelope(payload, redacted("not-approved")),
        issue: issue(
          "EXTENSION_NOT_APPROVED",
          "An adapter event extension was not approved for durable storage and was redacted.",
        ),
      };
    }
    const selectedProjection = safeProjection(selected);
    return {
      payload: extensionEnvelope(payload, selectedProjection.value),
      ...(selectedProjection.issue ? { issue: selectedProjection.issue } : {}),
    };
  }

  if (payload.kind === "tool-started" || payload.kind === "tool-updated" || payload.kind === "tool-completed") {
    if (payload.extensions === undefined) {
      return { payload: toolEnvelope(payload) };
    }
    let selected: unknown;
    try {
      selected = projection?.projectToolExtensions?.(payload);
    } catch {
      return {
        payload: withoutToolExtensions(payload),
        issue: issue(
          "EXTENSION_PROJECTION_FAILED",
          "An adapter tool-extension projector failed and its metadata was removed.",
        ),
      };
    }
    if (selected === undefined) {
      return {
        payload: withoutToolExtensions(payload),
        issue: issue(
          "EXTENSION_NOT_APPROVED",
          "Adapter tool-extension metadata was not approved for durable storage and was removed.",
        ),
      };
    }
    const selectedProjection = safeProjection(selected);
    if (
      selectedProjection.issue
      || typeof selectedProjection.value !== "object"
      || selectedProjection.value === null
      || Array.isArray(selectedProjection.value)
    ) {
      return {
        payload: withoutToolExtensions(payload),
        issue: selectedProjection.issue ?? issue(
          "EXTENSION_VALUE_INVALID",
          "Adapter tool-extension metadata was not a JSON object and was removed.",
        ),
      };
    }
    return {
      payload: toolEnvelope(
        payload,
        selectedProjection.value as Readonly<Record<string, unknown>>,
      ),
    };
  }

  return { payload };
}

export function isHarnessRedactedExtensionPayload(
  value: unknown,
): value is HarnessRedactedExtensionPayload {
  const reason = (value as Partial<HarnessRedactedExtensionPayload> | null)?.reason;
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && (value as Partial<HarnessRedactedExtensionPayload>)["reins:redacted"] === true
    && (reason === "not-approved"
      || reason === "projection-failed"
      || reason === "invalid-value"
      || reason === "limit-exceeded");
}
