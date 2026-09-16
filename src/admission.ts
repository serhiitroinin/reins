/** Discovery-driven, provider-neutral admission for one harness turn. */

import { validateHarnessInput, type HarnessInputIssueCode } from "./input.js";
import type { HarnessRunRequest } from "./protocol.js";
import {
  harnessInputPolicy,
  resolveHarnessConfiguration,
  resolveHarnessEffort,
  type HarnessConfigurationIssue,
  type HarnessDiscovery,
  type HarnessDiscoveryRequest,
  type HarnessEngineProfile,
  type HarnessModel,
  type HarnessModelCatalog,
} from "./profile.js";
import type { HarnessAdmission } from "./runtime.js";

/** The discovery surface needed to admit a turn. A HarnessRuntime satisfies it. */
export interface HarnessAdmissionDiscoverySource {
  profile(
    adapterId: string,
    request?: HarnessDiscoveryRequest,
  ): Promise<HarnessDiscovery<HarnessEngineProfile>> | HarnessDiscovery<HarnessEngineProfile>;
  models?(
    adapterId: string,
    request?: HarnessDiscoveryRequest,
  ): Promise<HarnessDiscovery<HarnessModelCatalog>> | HarnessDiscovery<HarnessModelCatalog>;
}

export interface HarnessAdmissionDiscovery {
  profile: HarnessDiscovery<HarnessEngineProfile>;
  /** Missing is equivalent to an adapter that does not expose model discovery. */
  models?: HarnessDiscovery<HarnessModelCatalog>;
}

export interface ResolveHarnessAdmissionInput {
  request: HarnessRunRequest;
  discovery: HarnessAdmissionDiscovery;
  /** Opaque, non-secret host fingerprint for session-stable authority. */
  sessionBinding?: string;
}

export interface DiscoverHarnessAdmissionOptions {
  /** Opaque, non-secret host fingerprint for session-stable authority. */
  sessionBinding?: string;
  signal?: AbortSignal;
}

export type HarnessAdmissionIssueCode =
  | "invalid-adapter"
  | "invalid-account"
  | "invalid-session-binding"
  | "discovery-aborted"
  | "profile-unavailable"
  | "profile-unsupported"
  | "profile-mismatch"
  | "invalid-profile"
  | "models-unavailable"
  | "models-unsupported"
  | "invalid-model-catalog"
  | "model-required"
  | "unknown-model"
  | "unavailable-model"
  | "unknown-effort"
  | HarnessConfigurationIssue["code"]
  | HarnessInputIssueCode;

export interface HarnessAdmissionIssue {
  path: string;
  code: HarnessAdmissionIssueCode;
  /** Safe host-facing detail. Never a raw thrown provider error. */
  message: string;
}

interface HarnessAdmissionResultBase {
  profile?: HarnessEngineProfile;
  catalog?: HarnessModelCatalog;
  model?: HarnessModel;
  issues: readonly HarnessAdmissionIssue[];
}

export interface ValidHarnessAdmissionResult extends HarnessAdmissionResultBase {
  valid: true;
  /** Request normalized to the exact defaults frozen by `admission`. */
  request: HarnessRunRequest;
  admission: HarnessAdmission;
  issues: readonly [];
  profile: HarnessEngineProfile;
}

export interface InvalidHarnessAdmissionResult extends HarnessAdmissionResultBase {
  valid: false;
  issues: readonly HarnessAdmissionIssue[];
}

export type HarnessAdmissionResult = ValidHarnessAdmissionResult | InvalidHarnessAdmissionResult;

function issue(
  path: string,
  code: HarnessAdmissionIssueCode,
  message: string,
): HarnessAdmissionIssue {
  return { path, code, message };
}

function invalid(
  issues: readonly HarnessAdmissionIssue[],
  resolved: Pick<HarnessAdmissionResultBase, "profile" | "catalog" | "model"> = {},
): InvalidHarnessAdmissionResult {
  return { valid: false, ...resolved, issues };
}

function availableModel(model: HarnessModel): boolean {
  return model.availability !== "unavailable" && model.unavailableReason === undefined;
}

function admissionEnvelopeIssues(
  request: HarnessRunRequest,
  sessionBinding: string | undefined,
): HarnessAdmissionIssue[] {
  const issues: HarnessAdmissionIssue[] = [];
  if (typeof request.adapterId !== "string" || request.adapterId.trim().length === 0) {
    issues.push(issue("adapterId", "invalid-adapter", "An adapter id is required."));
  }
  if (
    request.accountId !== undefined
    && (typeof request.accountId !== "string" || request.accountId.trim().length === 0)
  ) {
    issues.push(issue("accountId", "invalid-account", "An account id cannot be empty."));
  }
  if (
    sessionBinding !== undefined
    && (typeof sessionBinding !== "string" || sessionBinding.trim().length === 0)
  ) {
    issues.push(issue(
      "sessionBinding",
      "invalid-session-binding",
      "A session binding cannot be empty.",
    ));
  }
  return issues;
}

function selectedModel(
  request: HarnessRunRequest,
  profile: HarnessEngineProfile,
  discovery: HarnessDiscovery<HarnessModelCatalog> | undefined,
): {
  catalog?: HarnessModelCatalog;
  model?: HarnessModel;
  issues: readonly HarnessAdmissionIssue[];
} {
  const requested = request.model ?? null;
  const requiresModel = profile.modelSelection === "required";
  if (discovery === undefined || discovery.status === "unsupported") {
    if (requested !== null || request.effort !== undefined || requiresModel) {
      return {
        issues: [issue(
          "model",
          "models-unsupported",
          "This adapter does not expose the model catalog needed to admit the selected execution.",
        )],
      };
    }
    return { issues: [] };
  }
  if (discovery.status === "unavailable") {
    return {
      issues: [issue(
        "model",
        "models-unavailable",
        discovery.message || "The model catalog is currently unavailable.",
      )],
    };
  }

  const catalog = discovery.value;
  const byId = new Map(catalog.models.map((model) => [model.id, model]));
  const required = requiresModel || catalog.selection === "required";
  let modelId = requested;
  if (modelId === null && catalog.defaultModelId !== undefined) {
    const defaultModel = byId.get(catalog.defaultModelId);
    if (!defaultModel || defaultModel.hidden || defaultModel.legacy) {
      return {
        catalog,
        issues: [issue(
          "discovery.models.defaultModelId",
          "invalid-model-catalog",
          "The model catalog default does not name a selectable non-legacy model.",
        )],
      };
    }
    modelId = catalog.defaultModelId;
  }
  if (modelId === null) {
    return required
      ? { catalog, issues: [issue("model", "model-required", "This adapter requires a model selection.")] }
      : { catalog, issues: [] };
  }

  const model = byId.get(modelId);
  if (!model) {
    return {
      catalog,
      issues: [issue("model", "unknown-model", "The selected model is not in the current adapter catalog.")],
    };
  }
  if (!availableModel(model)) {
    return {
      catalog,
      model,
      issues: [issue("model", "unavailable-model", model.unavailableReason || "The selected model is unavailable.")],
    };
  }
  return { catalog, model, issues: [] };
}

/**
 * Resolve one already-fetched discovery snapshot into an executable request
 * and a complete runtime admission. Any issue makes the result non-runnable.
 */
export function resolveHarnessAdmission(input: ResolveHarnessAdmissionInput): HarnessAdmissionResult {
  const { request, discovery, sessionBinding } = input;
  const envelopeIssues = admissionEnvelopeIssues(request, sessionBinding);
  if (envelopeIssues.length > 0) return invalid(envelopeIssues);

  if (discovery.profile.status === "unsupported") {
    return invalid([issue(
      "discovery.profile",
      "profile-unsupported",
      discovery.profile.message || "This adapter does not expose an engine profile.",
    )]);
  }
  if (discovery.profile.status === "unavailable") {
    return invalid([issue(
      "discovery.profile",
      "profile-unavailable",
      discovery.profile.message || "The engine profile is currently unavailable.",
    )]);
  }

  const profile = discovery.profile.value;
  if (profile.id !== request.adapterId) {
    return invalid([issue(
      "discovery.profile.id",
      "profile-mismatch",
      "The discovered engine profile does not belong to the selected adapter.",
    )], { profile });
  }

  const selected = selectedModel(request, profile, discovery.models);
  if (selected.issues.length > 0) {
    return invalid(selected.issues, {
      profile,
      ...(selected.catalog ? { catalog: selected.catalog } : {}),
      ...(selected.model ? { model: selected.model } : {}),
    });
  }

  const effort = resolveHarnessEffort(selected.model, request.effort);
  const effortIssues = effort.issues.map((entry) => issue("effort", entry.code, entry.message));
  if (effortIssues.length > 0) {
    return invalid(effortIssues, {
      profile,
      ...(selected.catalog ? { catalog: selected.catalog } : {}),
      ...(selected.model ? { model: selected.model } : {}),
    });
  }

  let settings;
  try {
    settings = resolveHarnessConfiguration(profile, request.settings, selected.model);
  } catch {
    return invalid([issue(
      "discovery.profile",
      "invalid-profile",
      "The discovered engine profile cannot produce a safe default configuration.",
    )], {
      profile,
      ...(selected.catalog ? { catalog: selected.catalog } : {}),
      ...(selected.model ? { model: selected.model } : {}),
    });
  }
  const settingIssues = settings.issues.map((entry) => issue(entry.path, entry.code, entry.message));
  if (settingIssues.length > 0) {
    return invalid(settingIssues, {
      profile,
      ...(selected.catalog ? { catalog: selected.catalog } : {}),
      ...(selected.model ? { model: selected.model } : {}),
    });
  }

  const inputPolicy = harnessInputPolicy(profile, selected.model);
  const validatedInput = validateHarnessInput(request.input, inputPolicy, request.inlineContext);
  if (!validatedInput.valid) {
    return invalid(validatedInput.issues.map((entry) => issue(entry.path, entry.code, entry.message)), {
      profile,
      ...(selected.catalog ? { catalog: selected.catalog } : {}),
      ...(selected.model ? { model: selected.model } : {}),
    });
  }

  const normalizedSettings = {
    permission: settings.permission,
    controls: settings.controls,
  };
  const normalizedRequest: HarnessRunRequest = {
    ...request,
    ...(selected.model ? { model: selected.model.id } : {}),
    ...(effort.effort ? { effort: effort.effort } : {}),
    settings: normalizedSettings,
  };
  const admission: HarnessAdmission = {
    adapterId: request.adapterId,
    accountId: request.accountId ?? null,
    model: selected.model?.id ?? null,
    effort: effort.effort ?? null,
    settings: normalizedSettings,
    ...(inputPolicy ? { inputPolicy } : {}),
    ...(sessionBinding !== undefined ? { sessionBinding } : {}),
  };
  return {
    valid: true,
    request: normalizedRequest,
    admission,
    profile,
    ...(selected.catalog ? { catalog: selected.catalog } : {}),
    ...(selected.model ? { model: selected.model } : {}),
    issues: [],
  };
}

async function safeDiscovery<T>(
  read: () => Promise<HarnessDiscovery<T>> | HarnessDiscovery<T>,
  message: string,
): Promise<HarnessDiscovery<T>> {
  try {
    return await read();
  } catch {
    return { status: "unavailable", message };
  }
}

/**
 * Discover and admit one turn in a single host call. Profile and model reads
 * are account-scoped and concurrent; limits intentionally remain independent.
 */
export async function discoverHarnessAdmission(
  source: HarnessAdmissionDiscoverySource,
  request: HarnessRunRequest,
  options: DiscoverHarnessAdmissionOptions = {},
): Promise<HarnessAdmissionResult> {
  const envelopeIssues = admissionEnvelopeIssues(request, options.sessionBinding);
  if (envelopeIssues.length > 0) return invalid(envelopeIssues);
  if (options.signal?.aborted) {
    return invalid([issue("discovery", "discovery-aborted", "Admission discovery was cancelled.")]);
  }
  const discoveryRequest: HarnessDiscoveryRequest = {
    ...(request.accountId !== undefined ? { accountId: request.accountId } : {}),
    ...(request.model !== undefined ? { modelId: request.model } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  };
  const [profile, models] = await Promise.all([
    safeDiscovery(
      () => source.profile(request.adapterId, discoveryRequest),
      "The engine profile could not be discovered.",
    ),
    source.models
      ? safeDiscovery(
        () => source.models!(request.adapterId, discoveryRequest),
        "The model catalog could not be discovered.",
      )
      : Promise.resolve({ status: "unsupported" as const }),
  ]);
  if (options.signal?.aborted) {
    return invalid([issue("discovery", "discovery-aborted", "Admission discovery was cancelled.")]);
  }
  return resolveHarnessAdmission({
    request,
    discovery: { profile, models },
    ...(options.sessionBinding !== undefined ? { sessionBinding: options.sessionBinding } : {}),
  });
}
