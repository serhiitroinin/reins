/** OpenCode's measured session-control recipe layered over generic ACP v1. */

import { HarnessAdapterError, type HarnessAdapterRunRequest } from "../runtime.js";
import {
  type AcpV1AdapterOptions,
  type AcpV1SessionConfigOption,
  type AcpV1SessionController,
} from "./acp-v1.js";
import { createAcpV1Adapter, type AcpV1Adapter } from "./acp-v1-adapter.js";

export const OPENCODE_ACP_ADAPTER_ID = "opencode:acp";

function modelOption(options: readonly AcpV1SessionConfigOption[]): Extract<AcpV1SessionConfigOption, { type: "select" }> | undefined {
  return options.find((option): option is Extract<AcpV1SessionConfigOption, { type: "select" }> => (
    option.type === "select" && (option.category === "model" || option.id === "model")
  ));
}

function effortOption(options: readonly AcpV1SessionConfigOption[]): Extract<AcpV1SessionConfigOption, { type: "select" }> | undefined {
  return options.find((option): option is Extract<AcpV1SessionConfigOption, { type: "select" }> => (
    option.type === "select" && (option.category === "thought_level" || option.id === "effort")
  ));
}

function modeOption(options: readonly AcpV1SessionConfigOption[]): Extract<AcpV1SessionConfigOption, { type: "select" }> | undefined {
  return options.find((option): option is Extract<AcpV1SessionConfigOption, { type: "select" }> => (
    option.type === "select" && (option.category === "mode" || option.id === "mode")
  ));
}

export interface OpenCodeAcpSessionSelection {
  /** Exact host-defined OpenCode agent/mode. It is behavior, not a permission grant. */
  modeId: string;
}

/** Apply an explicit Harness model selection to OpenCode's negotiated ACP control. */
export async function configureOpenCodeAcpSession(
  controller: AcpV1SessionController,
  request: HarnessAdapterRunRequest,
  selection: OpenCodeAcpSessionSelection,
): Promise<void> {
  if (request.model) {
    const option = modelOption(controller.configOptions);
    if (!option) {
      throw new HarnessAdapterError(
        "OPENCODE_MODEL_CONTROL_UNAVAILABLE",
        "The connected OpenCode session does not expose a model control.",
      );
    }
    if (!option.options.some((candidate) => candidate.value === request.model)) {
      throw new HarnessAdapterError(
        "OPENCODE_MODEL_UNAVAILABLE",
        "The selected model is not available in this OpenCode session.",
      );
    }
    if (option.currentValue !== request.model) {
      await controller.setConfigOption(option.id, request.model);
    }
  }

  if (request.effort) {
    const option = effortOption(controller.configOptions);
    if (!option) {
      throw new HarnessAdapterError(
        "OPENCODE_EFFORT_CONTROL_UNAVAILABLE",
        "The selected model does not expose an OpenCode effort control.",
      );
    }
    if (!option.options.some((candidate) => candidate.value === request.effort)) {
      throw new HarnessAdapterError(
        "OPENCODE_EFFORT_UNAVAILABLE",
        "The selected effort is not available in this OpenCode session.",
      );
    }
    if (option.currentValue !== request.effort) {
      await controller.setConfigOption(option.id, request.effort);
    }
  }

  const configMode = modeOption(controller.configOptions);
  if (configMode) {
    if (!configMode.options.some((candidate) => candidate.value === selection.modeId)) {
      throw new HarnessAdapterError(
        "OPENCODE_MODE_UNAVAILABLE",
        "The host-managed OpenCode mode is not available in this session.",
      );
    }
    if (configMode.currentValue !== selection.modeId) {
      await controller.setConfigOption(configMode.id, selection.modeId);
    }
    return;
  }

  const modes = controller.modes;
  if (!modes?.availableModes.some((mode) => mode.id === selection.modeId)) {
    throw new HarnessAdapterError(
      "OPENCODE_MODE_CONTROL_UNAVAILABLE",
      "The connected OpenCode session does not expose the host-managed mode.",
    );
  }
  if (modes.currentModeId !== selection.modeId) await controller.setMode(selection.modeId);
}

export interface OpenCodeAcpAdapterOptions extends Omit<
  AcpV1AdapterOptions,
  "id" | "configureSession"
> {
  id?: string;
  /** Exact mode defined by the host's private OpenCode configuration. */
  modeId: string;
  /** Required: only the host can truthfully describe the process policy it enforces. */
  profile: NonNullable<AcpV1AdapterOptions["profile"]>;
  /** Runs after the package has applied model, effort, and the fixed host mode. */
  configureSession?: AcpV1AdapterOptions["configureSession"];
}

/** Compose OpenCode-specific discovery and model mapping over generic ACP v1. */
export function createOpenCodeAcpAdapter(options: OpenCodeAcpAdapterOptions): AcpV1Adapter {
  const id = options.id ?? OPENCODE_ACP_ADAPTER_ID;
  const {
    modeId,
    configureSession,
    ...generic
  } = options;
  return createAcpV1Adapter({
    ...generic,
    id,
    async configureSession(controller, request) {
      await configureOpenCodeAcpSession(controller, request, { modeId });
      await configureSession?.(controller, request);
    },
  });
}
