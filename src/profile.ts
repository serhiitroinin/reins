/**
 * Browser-safe discovery contracts for rendering an adapter without knowing
 * which provider SDK sits behind it.
 *
 * Identifiers are deliberately open strings. An adapter may front one vendor,
 * several vendors (for example OpenCode), or a future engine the core package
 * has never heard of.
 */

export type HarnessDiscovery<T> =
  | { status: "available"; value: T; fetchedAt?: string; expiresAt?: string }
  | { status: "unavailable"; message: string; retryable?: boolean }
  | { status: "unsupported"; message?: string };

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

export interface HarnessModel {
  id: string;
  label: string;
  description?: string;
  /** Useful when one adapter fronts several model providers. */
  group?: { id: string; label: string };
  hidden?: boolean;
  unavailableReason?: string;
  inputModalities?: readonly string[];
  contextWindowTokens?: number;
  effort?: HarnessEffortProfile;
  /** Controls whose values or availability are specific to this model. */
  controls?: readonly HarnessControl[];
  extensions?: Readonly<Record<string, unknown>>;
}

export interface HarnessModelCatalog {
  models: readonly HarnessModel[];
  /** Absent means the adapter or provider chooses its default. */
  defaultModelId?: string;
}

export interface HarnessEngineProfile {
  id: string;
  label: string;
  description?: string;
  permissions: HarnessPermissionProfile;
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

function defaultControlValue(control: HarnessControl): HarnessControlValue | undefined {
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
  if (fallback.consent) throw new Error("the default permission mode cannot require consent");

  let permission = requested.permission;
  let selected = permission ? modes.get(permission.modeId) : fallback;
  if (!selected) {
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
    const valid = value === undefined
      ? false
      : control.kind === "toggle"
        ? typeof value === "boolean"
        : control.kind === "select"
          ? typeof value === "string" && control.options.some((option) => option.id === value && !option.unavailableReason)
          : typeof value === "number"
            && Number.isFinite(value)
            && (control.min === undefined || value >= control.min)
            && (control.max === undefined || value <= control.max);
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
