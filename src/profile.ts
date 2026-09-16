/**
 * Browser-safe discovery contracts for rendering an adapter without knowing
 * which provider SDK sits behind it.
 *
 * Identifiers are deliberately open strings. An adapter may front one vendor,
 * several vendors (for example OpenCode), or a future engine the core package
 * has never heard of.
 */

import type { CapabilitySupport } from "./protocol.js";

export type HarnessDiscovery<T> =
  | { status: "available"; value: T; fetchedAt?: string; expiresAt?: string }
  | { status: "unavailable"; message: string; code?: string; retryable?: boolean }
  | { status: "unsupported"; message?: string };

export type HarnessDiscoveryFreshness = "fresh" | "stale" | "unknown";

/**
 * Classify a successful discovery result without coupling hosts to a cache
 * implementation. Missing or malformed timestamps are intentionally unknown.
 */
export function harnessDiscoveryFreshness(
  discovery: HarnessDiscovery<unknown>,
  now: Date | string = new Date(),
): HarnessDiscoveryFreshness {
  if (discovery.status !== "available" || !discovery.expiresAt) return "unknown";
  const expiresAt = Date.parse(discovery.expiresAt);
  const nowMs = typeof now === "string" ? Date.parse(now) : now.getTime();
  if (!Number.isFinite(expiresAt) || !Number.isFinite(nowMs)) return "unknown";
  return nowMs < expiresAt ? "fresh" : "stale";
}

export interface HarnessDiscoveryRequest {
  accountId?: string;
  modelId?: string;
  signal?: AbortSignal;
}

export interface HarnessOption {
  id: string;
  label: string;
  description?: string;
  unavailableReason?: string;
  extensions?: Readonly<Record<string, unknown>>;
}

export interface HarnessControlBase {
  /** Open, adapter-owned identifier. Namespaced identifiers are recommended. */
  id: string;
  label: string;
  description?: string;
  scope: "turn" | "session" | "account" | (string & {});
  unavailableReason?: string;
  extensions?: Readonly<Record<string, unknown>>;
}

export interface HarnessToggleControl extends HarnessControlBase {
  kind: "toggle";
  defaultValue: boolean;
}

export interface HarnessSelectControl extends HarnessControlBase {
  kind: "select";
  options: readonly HarnessOption[];
  defaultValue?: string;
}

export interface HarnessNumberControl extends HarnessControlBase {
  kind: "number";
  min?: number;
  max?: number;
  step?: number;
  defaultValue?: number;
}

export type HarnessControl = HarnessToggleControl | HarnessSelectControl | HarnessNumberControl;
export type HarnessControlValue = string | number | boolean;

export interface HarnessConsent {
  /** Change this value whenever the meaning or risk of a grant changes. */
  version: string;
  title: string;
  description: string;
}

export interface HarnessPermissionMode extends HarnessOption {
  posture: "restricted" | "standard" | "elevated" | "unrestricted" | (string & {});
  consent?: HarnessConsent;
}

export interface HarnessPermissionProfile {
  /** Describes what the choice controls, such as `sandbox` or `approval-policy`. */
  kind: string;
  modes: readonly HarnessPermissionMode[];
  defaultModeId: string;
  /** A fixed profile is informative and should not be drawn as a picker. */
  selectable: boolean;
  description?: string;
}

export interface HarnessPermissionSelection {
  modeId: string;
  consentVersion?: string;
}

export interface HarnessEffortProfile {
  options: readonly HarnessOption[];
  defaultOptionId?: string;
}

export interface HarnessEffortIssue {
  code: "unknown-effort";
  message: string;
}

export interface ResolvedHarnessEffort {
  effort?: string;
  issues: readonly HarnessEffortIssue[];
}

/** Resolve an open provider effort id against a model's advertised options. */
export function resolveHarnessEffort(
  model: HarnessModel | undefined,
  requested?: string | null,
): ResolvedHarnessEffort {
  const profile = model?.effort;
  if (!profile) {
    return requested === undefined || requested === null
      ? { issues: [] }
      : { issues: [{ code: "unknown-effort", message: "The selected model does not advertise effort options." }] };
  }
  const options = new Map(profile.options.map((option) => [option.id, option]));
  const fallback = profile.defaultOptionId && options.get(profile.defaultOptionId)?.unavailableReason === undefined
    ? profile.defaultOptionId
    : undefined;
  if (requested !== undefined && requested !== null) {
    const selected = options.get(requested);
    if (selected && selected.unavailableReason === undefined) return { effort: requested, issues: [] };
    return {
      ...(fallback ? { effort: fallback } : {}),
      issues: [{ code: "unknown-effort", message: "The selected effort is not available for this model." }],
    };
  }
  return { ...(fallback ? { effort: fallback } : {}), issues: [] };
}

/** Open modality identifiers let future adapters add inputs without a core release. */
export type HarnessInputModality =
  | "text"
  | "image"
  | "resource"
  | "context-reference"
  | (string & {});

export interface HarnessInputConstraint {
  support: CapabilitySupport;
  /** Maximum number of parts of this modality in one turn. */
  maxCount?: number;
  /** Maximum measurable encoded/provider payload bytes for one part. */
  maxItemBytes?: number;
  /** Maximum measurable encoded/provider payload bytes across this modality. */
  maxTotalBytes?: number;
  /** Maximum characters for a textual part. */
  maxTextCharacters?: number;
  /** Exact accepted media types. Absent means the adapter did not declare a list. */
  mediaTypes?: readonly string[];
  description?: string;
  extensions?: Readonly<Record<string, unknown>>;
}

export interface HarnessInputPolicy {
  /** Maximum number of all input parts in one turn. */
  maxItems?: number;
  /** Maximum measurable bytes across all input parts in one turn. */
  maxTotalBytes?: number;
  modalities?: Readonly<Record<string, HarnessInputConstraint>>;
  extensions?: Readonly<Record<string, unknown>>;
}

export interface HarnessModel {
  id: string;
  label: string;
  description?: string;
  /** Useful when one adapter fronts several model providers. */
  group?: { id: string; label: string };
  hidden?: boolean;
  /** Whether the provider currently permits selecting this model. */
  availability?: "available" | "unavailable";
  /** Marks a provider-retained model that should not be selected by default. */
  legacy?: boolean;
  unavailableReason?: string;
  inputModalities?: readonly string[];
  contextWindowTokens?: number;
  /** Precise input support and limits; absent fields mean unknown. */
  inputPolicy?: HarnessInputPolicy;
  effort?: HarnessEffortProfile;
  /** Controls whose values or availability are specific to this model. */
  controls?: readonly HarnessControl[];
  extensions?: Readonly<Record<string, unknown>>;
}

export interface HarnessModelCatalog {
  models: readonly HarnessModel[];
  /** Whether a host may leave the model unset and let the adapter/provider choose. */
  selection?: "optional" | "required";
  /** Absent means the adapter or provider chooses its default. */
  defaultModelId?: string;
}

export interface HarnessEngineProfile {
  id: string;
  label: string;
  description?: string;
  /** Whether this engine can choose a provider/account default when no model is named. */
  modelSelection?: "optional" | "required";
  permissions: HarnessPermissionProfile;
  /** Engine defaults. A selected model overrides only the fields it declares. */
  inputPolicy?: HarnessInputPolicy;
  /** Engine-wide controls. Model controls are merged on top by identifier. */
  controls?: readonly HarnessControl[];
  extensions?: Readonly<Record<string, unknown>>;
}

export interface HarnessLimit {
  id: string;
  label: string;
  kind: "rate" | "credits" | "spend" | "context" | (string & {});
  scope: "account" | "model" | "turn" | (string & {});
  unit: string;
  used?: number;
  remaining?: number;
  limit?: number;
  usedPercent?: number;
  resetsAt?: string;
  windowDurationMs?: number;
  modelIds?: readonly string[];
  extensions?: Readonly<Record<string, unknown>>;
}

export interface HarnessLimitSnapshot {
  planLabel?: string;
  limits: readonly HarnessLimit[];
  extensions?: Readonly<Record<string, unknown>>;
}

export interface HarnessRunSettings {
  permission?: HarnessPermissionSelection;
  controls?: Readonly<Record<string, HarnessControlValue>>;
}

export interface HarnessConfigurationIssue {
  path: string;
  code: "unknown-control" | "invalid-value" | "unknown-permission" | "stale-consent";
  message: string;
}

export interface ResolvedHarnessConfiguration {
  permission: HarnessPermissionSelection;
  controls: Readonly<Record<string, HarnessControlValue>>;
  issues: readonly HarnessConfigurationIssue[];
}

function validControlValue(control: HarnessControl, value: HarnessControlValue): boolean {
  return control.kind === "toggle"
    ? typeof value === "boolean"
    : control.kind === "select"
      ? typeof value === "string"
        && control.options.some((option) => option.id === value && option.unavailableReason === undefined)
      : typeof value === "number"
        && Number.isFinite(value)
        && (control.min === undefined || value >= control.min)
        && (control.max === undefined || value <= control.max);
}

function defaultControlValue(control: HarnessControl): HarnessControlValue | undefined {
  if (control.unavailableReason !== undefined || control.defaultValue === undefined) return undefined;
  if (!validControlValue(control, control.defaultValue)) {
    throw new Error(`control ${control.id} defaultValue must name an available value`);
  }
  return control.defaultValue;
}

/** Merge engine and model controls, with the model definition winning by id. */
export function harnessControls(
  profile: HarnessEngineProfile,
  model?: HarnessModel,
): readonly HarnessControl[] {
  const controls = new Map<string, HarnessControl>();
  for (const control of profile.controls ?? []) controls.set(control.id, control);
  for (const control of model?.controls ?? []) controls.set(control.id, control);
  return [...controls.values()];
}

/** Merge engine and model input policy without inventing absent limits. */
export function harnessInputPolicy(
  profile: HarnessEngineProfile,
  model?: HarnessModel,
): HarnessInputPolicy | undefined {
  const engine = profile.inputPolicy;
  const selected = model?.inputPolicy;
  if (!engine && !selected) return undefined;

  const modalities: Record<string, HarnessInputConstraint> = {};
  for (const [id, constraint] of Object.entries(engine?.modalities ?? {})) {
    modalities[id] = { ...constraint };
  }
  for (const [id, constraint] of Object.entries(selected?.modalities ?? {})) {
    const inherited = modalities[id];
    modalities[id] = {
      ...inherited,
      ...constraint,
      ...(inherited?.extensions || constraint.extensions ? {
        extensions: { ...inherited?.extensions, ...constraint.extensions },
      } : {}),
    };
  }

  return {
    ...engine,
    ...selected,
    ...(Object.keys(modalities).length > 0 ? { modalities } : {}),
    ...(engine?.extensions || selected?.extensions ? {
      extensions: { ...engine?.extensions, ...selected?.extensions },
    } : {}),
  };
}

/**
 * Resolve stored or submitted settings against the adapter's current profile.
 * Invalid values fall back safely and are reported; callers decide whether to
 * show the reset or reject a submitted turn.
 */
export function resolveHarnessConfiguration(
  profile: HarnessEngineProfile,
  requested: HarnessRunSettings = {},
  model?: HarnessModel,
): ResolvedHarnessConfiguration {
  const issues: HarnessConfigurationIssue[] = [];
  const modes = new Map(profile.permissions.modes.map((mode) => [mode.id, mode]));
  const fallback = modes.get(profile.permissions.defaultModeId);
  if (!fallback) throw new Error("permission profile defaultModeId must name a mode");
  if (fallback.unavailableReason) throw new Error("permission profile defaultModeId must name an available mode");
  if (fallback.consent) throw new Error("the default permission mode cannot require consent");

  let permission = requested.permission;
  let selected = permission ? modes.get(permission.modeId) : fallback;
  if (!selected || selected.unavailableReason !== undefined) {
    issues.push({
      path: "permission.modeId",
      code: "unknown-permission",
      message: "The selected permission mode is no longer available.",
    });
    selected = fallback;
    permission = undefined;
  }
  if (selected.consent && permission?.consentVersion !== selected.consent.version) {
    issues.push({
      path: "permission.consentVersion",
      code: "stale-consent",
      message: "The selected permission mode requires renewed consent.",
    });
    selected = fallback;
    permission = undefined;
  }
  const resolvedPermission: HarnessPermissionSelection = selected.consent
    ? { modeId: selected.id, consentVersion: selected.consent.version }
    : { modeId: selected.id };

  const definitions = harnessControls(profile, model);
  const known = new Map(definitions.map((control) => [control.id, control]));
  const values: Record<string, HarnessControlValue> = {};
  for (const control of definitions) {
    const value = requested.controls?.[control.id];
    const valid = value !== undefined
      && control.unavailableReason === undefined
      && validControlValue(control, value);
    if (valid) values[control.id] = value as HarnessControlValue;
    else {
      const fallbackValue = defaultControlValue(control);
      if (fallbackValue !== undefined) values[control.id] = fallbackValue;
      if (value !== undefined) {
        issues.push({
          path: `controls.${control.id}`,
          code: "invalid-value",
          message: `The value for ${control.label} is no longer available.`,
        });
      }
    }
  }
  for (const id of Object.keys(requested.controls ?? {})) {
    if (!known.has(id)) {
      issues.push({
        path: `controls.${id}`,
        code: "unknown-control",
        message: "The submitted engine control is not available.",
      });
    }
  }
  return { permission: resolvedPermission, controls: values, issues };
}
