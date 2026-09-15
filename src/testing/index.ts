/** Deterministic adapter fixtures for host applications and conformance tests. */

import type { HarnessCapabilities, HarnessInteractionResponse } from "../protocol.js";
import type {
  HarnessAdapter,
  HarnessAdapterEvent,
  HarnessAdapterRunRequest,
  HarnessAdapterSession,
} from "../runtime.js";

export * from "./conformance.js";
export * from "./conformance-fixture.js";
export * from "./codex-app-server-fixture.js";
export * from "./claude-agent-sdk-fixture.js";
export * from "./acp-v1-fixture.js";

const unsupported = { support: "unsupported" as const };

export const scriptedCapabilities: HarnessCapabilities = {
  resume: { support: "stable" },
  cancel: { support: "stable" },
  interactions: { support: "stable", recovery: "live-only" },
  tools: { support: "stable" },
  images: unsupported,
  thinking: { support: "stable" },
  plans: { support: "stable" },
  usage: { support: "stable" },
  subagents: unsupported,
  shell: unsupported,
  filesystem: unsupported,
  network: unsupported,
};

export interface ScriptedAdapterState {
  openedWith: Array<string | null>;
  runs: HarnessAdapterRunRequest[];
  responses: Array<{ interactionId: string; response: HarnessInteractionResponse }>;
  cancellations: number;
  closes: number;
}

export interface ScriptedAdapterOptions {
  id?: string;
  capabilities?: HarnessCapabilities;
  resumeToken?: string | null;
  script(request: HarnessAdapterRunRequest): AsyncIterable<HarnessAdapterEvent>;
}

export function createScriptedAdapter(options: ScriptedAdapterOptions): {
  adapter: HarnessAdapter;
  state: ScriptedAdapterState;
} {
  const state: ScriptedAdapterState = {
    openedWith: [],
    runs: [],
    responses: [],
    cancellations: 0,
    closes: 0,
  };
  const adapter: HarnessAdapter = {
    id: options.id ?? "scripted",
    capabilities: () => options.capabilities ?? scriptedCapabilities,
    async open({ resumeToken }) {
      state.openedWith.push(resumeToken);
      const session: HarnessAdapterSession = {
        run(request) {
          state.runs.push(request);
          return options.script(request);
        },
        async respond(interactionId, response) {
          state.responses.push({ interactionId, response });
        },
        async cancel() {
          state.cancellations += 1;
        },
        checkpoint: () => options.resumeToken ?? null,
        async close() {
          state.closes += 1;
        },
      };
      return session;
    },
  };
  return { adapter, state };
}
