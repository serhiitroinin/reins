/** Pure validation and resolution for portable harness input. */

import type {
  HarnessContextRecord,
  HarnessContextValue,
  HarnessInlineContext,
  HarnessInput,
} from "./protocol.js";
import type {
  HarnessInputConstraint,
  HarnessInputModality,
  HarnessInputPolicy,
} from "./profile.js";

export const HARNESS_CONTEXT_ID_MAX_LENGTH = 128;
export const HARNESS_CONTEXT_KIND_MAX_LENGTH = 64;
export const HARNESS_CONTEXT_LABEL_MAX_LENGTH = 200;
export const HARNESS_CONTEXT_MAX_RECORDS = 200;
export const HARNESS_CONTEXT_MAX_PAYLOAD_CHARACTERS = 64_000;
export const HARNESS_CONTEXT_MAX_SERIALIZED_CHARACTERS = 16_000_000;

export type HarnessInputIssueCode =
  | "invalid-context-version"
  | "invalid-context-record"
  | "invalid-context-reference"
  | "invalid-context-payload"
  | "context-payload-too-large"
  | "context-too-many-records"
  | "context-too-large"
  | "duplicate-context-id"
  | "duplicate-input-id"
  | "duplicate-reference-id"
  | "stale-context-reference"
  | "stale-context-binding"
  | "mismatched-context-binding"
  | "unsupported-modality"
  | "input-count-exceeded"
  | "input-bytes-exceeded"
  | "input-item-bytes-exceeded"
  | "text-length-exceeded"
  | "media-type-unsupported"
  | "invalid-input-policy";

export interface HarnessInputIssue {
  path: string;
  code: HarnessInputIssueCode;
  message: string;
  contextId?: string;
  modality?: HarnessInputModality;
}

export interface ResolvedHarnessContextReference {
  inputIndex: number;
  referenceId?: string;
  record: HarnessContextRecord;
}

export interface HarnessInlineContextValidation {
  valid: boolean;
  references: readonly ResolvedHarnessContextReference[];
  issues: readonly HarnessInputIssue[];
}

export type HarnessInputValidation = HarnessInlineContextValidation;

function object(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null
    ? value as Record<string, unknown>
    : null;
}

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function inspectJson(
  value: unknown,
  path: string,
  issues: HarnessInputIssue[],
  ancestors: Set<object>,
  budget: { characters: number; tooLarge: boolean },
  depth = 0,
): value is HarnessContextValue {
  const charge = (characters: number): boolean => {
    budget.characters += characters;
    if (budget.characters <= HARNESS_CONTEXT_MAX_PAYLOAD_CHARACTERS) return true;
    if (!budget.tooLarge) {
      budget.tooLarge = true;
      issues.push({
        path,
        code: "context-payload-too-large",
        message: `One context payload cannot exceed ${HARNESS_CONTEXT_MAX_PAYLOAD_CHARACTERS} serialized characters.`,
      });
    }
    return false;
  };

  if (value === null) return charge(4);
  if (typeof value === "string") {
    if (value.length > HARNESS_CONTEXT_MAX_PAYLOAD_CHARACTERS) {
      return charge(HARNESS_CONTEXT_MAX_PAYLOAD_CHARACTERS + 1);
    }
    return charge(JSON.stringify(value).length);
  }
  if (typeof value === "boolean") return charge(value ? 4 : 5);
  if (typeof value === "number") {
    if (Number.isFinite(value) && !Object.is(value, -0)) return charge(String(value).length);
    issues.push({ path, code: "invalid-context-payload", message: "Context payload numbers must be finite JSON numbers." });
    return false;
  }
  if (typeof value !== "object") {
    issues.push({ path, code: "invalid-context-payload", message: "Context payloads must contain only JSON values." });
    return false;
  }
  if (depth > 64) {
    issues.push({ path, code: "invalid-context-payload", message: "Context payload nesting exceeds the supported depth." });
    return false;
  }
  if (ancestors.has(value)) {
    issues.push({ path, code: "invalid-context-payload", message: "Context payloads must not contain cycles." });
    return false;
  }

  ancestors.add(value);
  let valid = true;
  try {
    if (Array.isArray(value)) {
      if (!charge(2)) return false;
      if (Reflect.ownKeys(value).length !== value.length + 1) {
        issues.push({ path, code: "invalid-context-payload", message: "Context payload arrays must not contain holes or extra properties." });
        valid = false;
      }
      for (let index = 0; index < value.length; index += 1) {
        if (index > 0 && !charge(1)) return false;
        if (!Object.hasOwn(value, index)) {
          valid = false;
          continue;
        }
        valid = inspectJson(value[index], `${path}[${index}]`, issues, ancestors, budget, depth + 1) && valid;
        if (budget.tooLarge) return false;
      }
      return valid;
    }

    if (object(value) === null) {
      issues.push({ path, code: "invalid-context-payload", message: "Context payloads must contain only plain JSON objects." });
      return false;
    }
    if (!charge(2)) return false;
    let index = 0;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") {
        issues.push({ path, code: "invalid-context-payload", message: "Context payloads must not contain symbol keys." });
        valid = false;
        continue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        issues.push({ path: `${path}.${key}`, code: "invalid-context-payload", message: "Context payload fields must be enumerable data properties." });
        valid = false;
        continue;
      }
      if (!charge((index > 0 ? 1 : 0) + JSON.stringify(key).length + 1)) return false;
      index += 1;
      valid = inspectJson(descriptor.value, `${path}.${key}`, issues, ancestors, budget, depth + 1) && valid;
      if (budget.tooLarge) return false;
    }
    return valid;
  } finally {
    ancestors.delete(value);
  }
}

function inputIds(input: readonly HarnessInput[], issues: HarnessInputIssue[]): Map<string, "attachment" | "resource"> {
  const ids = new Map<string, "attachment" | "resource">();
  for (let index = 0; index < input.length; index += 1) {
    const part = input[index]!;
    if ((part.type !== "image" && part.type !== "resource") || part.id === undefined) continue;
    if (!boundedString(part.id, HARNESS_CONTEXT_ID_MAX_LENGTH)) {
      issues.push({
        path: `input[${index}].id`,
        code: "invalid-context-record",
        message: `Input ids must contain 1-${HARNESS_CONTEXT_ID_MAX_LENGTH} characters.`,
      });
      continue;
    }
    if (ids.has(part.id)) {
      issues.push({
        path: `input[${index}].id`,
        code: "duplicate-input-id",
        message: `Input id ${part.id} is duplicated.`,
      });
      continue;
    }
    ids.set(part.id, part.type === "image" ? "attachment" : "resource");
  }
  return ids;
}

/** Validate records and resolve their ordered input occurrences without throwing. */
export function validateHarnessInlineContext(
  context: unknown,
  input: readonly HarnessInput[],
): HarnessInlineContextValidation {
  const issues: HarnessInputIssue[] = [];
  const references: ResolvedHarnessContextReference[] = [];
  const inputsById = inputIds(input, issues);
  const envelope = context === undefined ? undefined : object(context);
  const records = new Map<string, HarnessContextRecord>();

  if (context !== undefined) {
    if (!envelope || envelope.version !== 1 || !Array.isArray(envelope.records)) {
      issues.push({
        path: "inlineContext",
        code: envelope && envelope.version !== 1 ? "invalid-context-version" : "invalid-context-record",
        message: "Inline context must be a version 1 record collection.",
      });
    } else {
      if (envelope.records.length > HARNESS_CONTEXT_MAX_RECORDS) {
        issues.push({
          path: "inlineContext.records",
          code: "context-too-many-records",
          message: `Inline context cannot contain more than ${HARNESS_CONTEXT_MAX_RECORDS} records.`,
        });
      }
      let totalCharacters = 0;
      const retainedLength = Math.min(envelope.records.length, HARNESS_CONTEXT_MAX_RECORDS);
      for (let index = 0; index < retainedLength; index += 1) {
        const path = `inlineContext.records[${index}]`;
        const candidate = object(envelope.records[index]);
        if (
          !candidate
          || candidate.version !== 1
          || !boundedString(candidate.id, HARNESS_CONTEXT_ID_MAX_LENGTH)
          || !boundedString(candidate.kind, HARNESS_CONTEXT_KIND_MAX_LENGTH)
          || !boundedString(candidate.label, HARNESS_CONTEXT_LABEL_MAX_LENGTH)
          || !Object.hasOwn(candidate, "payload")
        ) {
          issues.push({ path, code: "invalid-context-record", message: "Context record envelope is malformed." });
          continue;
        }

        const contextId = candidate.id;
        const payloadIssues = issues.length;
        const budget = { characters: 0, tooLarge: false };
        const payloadValid = inspectJson(candidate.payload, `${path}.payload`, issues, new Set(), budget);
        totalCharacters += budget.characters;

        let bindingValid = true;
        if (candidate.binding !== undefined) {
          const binding = object(candidate.binding);
          if (
            !binding
            || (binding.type !== "attachment" && binding.type !== "resource")
            || !boundedString(binding.inputId, HARNESS_CONTEXT_ID_MAX_LENGTH)
            || (binding.name !== undefined && typeof binding.name !== "string")
            || (binding.mediaType !== undefined && typeof binding.mediaType !== "string")
            || (binding.sizeBytes !== undefined
              && (!Number.isSafeInteger(binding.sizeBytes) || (binding.sizeBytes as number) < 0))
          ) {
            issues.push({ path: `${path}.binding`, code: "invalid-context-record", message: "Context binding is malformed.", contextId });
            bindingValid = false;
          } else {
            const actual = inputsById.get(binding.inputId);
            if (!actual) {
              issues.push({
                path: `${path}.binding.inputId`,
                code: "stale-context-binding",
                message: `Context binding ${binding.inputId} does not name an input in this turn.`,
                contextId,
              });
              bindingValid = false;
            } else if (actual !== binding.type) {
              issues.push({
                path: `${path}.binding.type`,
                code: "mismatched-context-binding",
                message: `Context binding ${binding.inputId} has the wrong input type.`,
                contextId,
              });
              bindingValid = false;
            }
          }
        }

        if (records.has(contextId)) {
          issues.push({ path: `${path}.id`, code: "duplicate-context-id", message: `Context id ${contextId} is duplicated.`, contextId });
          continue;
        }
        if (payloadValid && issues.length === payloadIssues && bindingValid) {
          records.set(contextId, candidate as unknown as HarnessContextRecord);
        }
      }
      if (totalCharacters > HARNESS_CONTEXT_MAX_SERIALIZED_CHARACTERS) {
        issues.push({
          path: "inlineContext.records",
          code: "context-too-large",
          message: `Inline context cannot exceed ${HARNESS_CONTEXT_MAX_SERIALIZED_CHARACTERS} serialized payload characters.`,
        });
      }
    }
  }

  const referenceIds = new Set<string>();
  for (let inputIndex = 0; inputIndex < input.length; inputIndex += 1) {
    const part = input[inputIndex]!;
    if (part.type !== "context-reference") continue;
    const path = `input[${inputIndex}]`;
    if (
      !boundedString(part.contextId, HARNESS_CONTEXT_ID_MAX_LENGTH)
      || (part.referenceId !== undefined && !boundedString(part.referenceId, HARNESS_CONTEXT_ID_MAX_LENGTH))
    ) {
      issues.push({ path, code: "invalid-context-reference", message: "Context reference is malformed." });
      continue;
    }
    if (part.referenceId !== undefined) {
      if (referenceIds.has(part.referenceId)) {
        issues.push({
          path: `${path}.referenceId`,
          code: "duplicate-reference-id",
          message: `Context reference id ${part.referenceId} is duplicated.`,
          contextId: part.contextId,
        });
        continue;
      }
      referenceIds.add(part.referenceId);
    }
    const record = records.get(part.contextId);
    if (!record) {
      issues.push({
        path: `${path}.contextId`,
        code: "stale-context-reference",
        message: `Context reference ${part.contextId} has no valid record.`,
        contextId: part.contextId,
      });
      continue;
    }
    references.push({ inputIndex, ...(part.referenceId ? { referenceId: part.referenceId } : {}), record });
  }

  return { valid: issues.length === 0, references, issues };
}

export function resolveHarnessContextReferences(
  context: HarnessInlineContext | undefined,
  input: readonly HarnessInput[],
): HarnessInlineContextValidation {
  return validateHarnessInlineContext(context, input);
}

/** Generic provider-safe text fallback for an already validated reference. */
export function harnessContextReferenceText(
  reference: Extract<HarnessInput, { type: "context-reference" }>,
  context: HarnessInlineContext | undefined,
): string | null {
  const record = context?.records.find(({ id }) => id === reference.contextId);
  if (!record) return null;
  const heading = `[${record.kind}: ${record.label}]`;
  if (record.payload === null) return heading;
  const body = typeof record.payload === "string"
    ? record.payload
    : JSON.stringify(record.payload);
  return body.length > 0 ? `${heading}\n${body}` : heading;
}

function measurableInput(
  part: HarnessInput,
  record: HarnessContextRecord | undefined,
): { bytes?: number; characters?: number; mediaType?: string } {
  if (part.type === "text") {
    return { bytes: new TextEncoder().encode(part.text).byteLength, characters: part.text.length };
  }
  if (part.type === "image") return { bytes: part.data.byteLength, mediaType: part.mediaType };
  if (part.type === "resource") return { ...(part.mediaType ? { mediaType: part.mediaType } : {}) };
  if (!record) return {};
  const text = harnessContextReferenceText(part, { version: 1, records: [record] }) ?? "";
  return { bytes: new TextEncoder().encode(text).byteLength, characters: text.length };
}

function validLimit(value: number | undefined): boolean {
  return value === undefined || (Number.isSafeInteger(value) && value >= 0);
}

function validateConstraint(
  modality: string,
  constraint: HarnessInputConstraint,
  issues: HarnessInputIssue[],
): boolean {
  const validSupport = constraint.support === "stable"
    || constraint.support === "experimental"
    || constraint.support === "unsupported";
  const valid = validSupport
    && validLimit(constraint.maxCount)
    && validLimit(constraint.maxItemBytes)
    && validLimit(constraint.maxTotalBytes)
    && validLimit(constraint.maxTextCharacters)
    && (constraint.mediaTypes === undefined
      || (constraint.mediaTypes.every((entry) => typeof entry === "string" && entry.length > 0)
        && new Set(constraint.mediaTypes).size === constraint.mediaTypes.length));
  if (!valid) {
    issues.push({
      path: `inputPolicy.modalities.${modality}`,
      code: "invalid-input-policy",
      message: `Input policy for ${modality} is malformed.`,
      modality,
    });
  }
  return valid;
}

/** Validate one prepared turn against an engine/model input policy. */
export function validateHarnessInput(
  input: readonly HarnessInput[],
  policy: HarnessInputPolicy | undefined,
  inlineContext?: HarnessInlineContext,
): HarnessInputValidation {
  const context = validateHarnessInlineContext(inlineContext, input);
  const issues = [...context.issues];
  if (!policy) return { valid: issues.length === 0, references: context.references, issues };

  if (!validLimit(policy.maxItems) || !validLimit(policy.maxTotalBytes)) {
    issues.push({ path: "inputPolicy", code: "invalid-input-policy", message: "Input policy limits must be non-negative safe integers." });
  }
  if (policy.maxItems !== undefined && input.length > policy.maxItems) {
    issues.push({ path: "input", code: "input-count-exceeded", message: `Input contains more than ${policy.maxItems} parts.` });
  }

  const records = new Map(context.references.map(({ record }) => [record.id, record]));
  const validConstraints = new Set<string>();
  for (const [modality, constraint] of Object.entries(policy.modalities ?? {})) {
    if (validateConstraint(modality, constraint, issues)) validConstraints.add(modality);
  }
  const counts = new Map<string, number>();
  const totals = new Map<string, number>();
  let totalBytes = 0;
  for (let index = 0; index < input.length; index += 1) {
    const part = input[index]!;
    const modality = part.type;
    const constraint = policy.modalities?.[modality];
    const measurable = measurableInput(
      part,
      part.type === "context-reference" ? records.get(part.contextId) : undefined,
    );
    counts.set(modality, (counts.get(modality) ?? 0) + 1);
    if (measurable.bytes !== undefined) {
      totals.set(modality, (totals.get(modality) ?? 0) + measurable.bytes);
      totalBytes += measurable.bytes;
    }
    if (!constraint || !validConstraints.has(modality)) continue;
    if (constraint.support === "unsupported") {
      issues.push({
        path: `input[${index}]`,
        code: "unsupported-modality",
        message: `The selected engine or model does not support ${modality} input.`,
        modality,
      });
    }
    if (constraint.maxItemBytes !== undefined
      && measurable.bytes !== undefined
      && measurable.bytes > constraint.maxItemBytes) {
      issues.push({
        path: `input[${index}]`,
        code: "input-item-bytes-exceeded",
        message: `${modality} input exceeds the ${constraint.maxItemBytes}-byte item limit.`,
        modality,
      });
    }
    if (constraint.maxTextCharacters !== undefined
      && measurable.characters !== undefined
      && measurable.characters > constraint.maxTextCharacters) {
      issues.push({
        path: `input[${index}]`,
        code: "text-length-exceeded",
        message: `${modality} input exceeds the ${constraint.maxTextCharacters}-character limit.`,
        modality,
      });
    }
    if (constraint.mediaTypes && measurable.mediaType
      && !constraint.mediaTypes.includes(measurable.mediaType)) {
      issues.push({
        path: `input[${index}].mediaType`,
        code: "media-type-unsupported",
        message: `${measurable.mediaType} is not accepted for ${modality} input.`,
        modality,
      });
    }
  }

  for (const [modality, constraint] of Object.entries(policy.modalities ?? {})) {
    if (!validConstraints.has(modality)) continue;
    const count = counts.get(modality) ?? 0;
    const bytes = totals.get(modality) ?? 0;
    if (constraint.maxCount !== undefined && count > constraint.maxCount) {
      issues.push({
        path: "input",
        code: "input-count-exceeded",
        message: `Input contains more than ${constraint.maxCount} ${modality} parts.`,
        modality,
      });
    }
    if (constraint.maxTotalBytes !== undefined && bytes > constraint.maxTotalBytes) {
      issues.push({
        path: "input",
        code: "input-bytes-exceeded",
        message: `${modality} input exceeds the ${constraint.maxTotalBytes}-byte total limit.`,
        modality,
      });
    }
  }
  if (policy.maxTotalBytes !== undefined && totalBytes > policy.maxTotalBytes) {
    issues.push({ path: "input", code: "input-bytes-exceeded", message: `Input exceeds the ${policy.maxTotalBytes}-byte total limit.` });
  }
  return { valid: issues.length === 0, references: context.references, issues };
}
