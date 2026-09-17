/** Explicit Node host-module contract consumed by the stdio executable. */

import type {
  HarnessAdapter,
  HarnessDiagnostic,
  HarnessRuntimeOptions,
} from "./runtime.js";
import type { HarnessSidecarServerInfo } from "./sidecar-protocol.js";

export interface HarnessSidecarHostDefinition {
  adapters: readonly HarnessAdapter[];
  server?: HarnessSidecarServerInfo;
  contextSources?: HarnessRuntimeOptions["contextSources"];
  onContextError?: HarnessRuntimeOptions["onContextError"];
  onDiagnostic?(diagnostic: HarnessDiagnostic): void | Promise<void>;
}

export type HarnessSidecarHostFactory = (
  options: { signal: AbortSignal },
) => Promise<HarnessSidecarHostDefinition> | HarnessSidecarHostDefinition;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Validate an explicitly loaded host module without accepting persistence or IO overrides. */
export async function resolveHarnessSidecarHost(
  module: unknown,
  signal: AbortSignal,
): Promise<HarnessSidecarHostDefinition> {
  const exports = record(module);
  if (!exports) throw new Error("the sidecar host module has no exports");
  const candidate = exports.createHarnessSidecarHost ?? exports.default;
  const value = typeof candidate === "function"
    ? await (candidate as HarnessSidecarHostFactory)({ signal })
    : candidate;
  const host = record(value);
  if (!host || !Array.isArray(host.adapters) || host.adapters.length === 0) {
    throw new Error("the sidecar host module must provide at least one adapter");
  }
  const ids = new Set<string>();
  for (const candidateAdapter of host.adapters) {
    const adapter = record(candidateAdapter);
    if (
      !adapter
      || typeof adapter.id !== "string"
      || adapter.id.trim() === ""
      || typeof adapter.capabilities !== "function"
      || typeof adapter.open !== "function"
      || ids.has(adapter.id)
    ) {
      throw new Error("the sidecar host module contains an invalid or duplicate adapter");
    }
    ids.add(adapter.id);
  }
  if (host.server !== undefined) {
    const server = record(host.server);
    if (!server || typeof server.name !== "string" || server.name.trim() === "") {
      throw new Error("the sidecar host module server identity is invalid");
    }
    if (server.version !== undefined && typeof server.version !== "string") {
      throw new Error("the sidecar host module server version is invalid");
    }
  }
  if (host.contextSources !== undefined && !Array.isArray(host.contextSources)) {
    throw new Error("the sidecar host module contextSources must be an array");
  }
  if (host.onContextError !== undefined && typeof host.onContextError !== "function") {
    throw new Error("the sidecar host module onContextError must be a function");
  }
  if (host.onDiagnostic !== undefined && typeof host.onDiagnostic !== "function") {
    throw new Error("the sidecar host module onDiagnostic must be a function");
  }
  return value as HarnessSidecarHostDefinition;
}
