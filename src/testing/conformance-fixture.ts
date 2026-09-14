/** Reference adapter fixture for the public conformance runner. */

import type { HarnessAdapter, HarnessAdapterSession } from "../runtime.js";
import type { HarnessCapabilities, HarnessInteractionResponse } from "../protocol.js";
import type { AdapterConformanceFixture, AdapterConformanceScenario } from "./conformance.js";
import { CONFORMANCE, conformanceSafeError } from "./conformance.js";

const unsupported = { support: "unsupported" as const };

export const conformanceCapabilities: HarnessCapabilities = {
  resume: { support: "stable" },
  cancel: { support: "stable" },
  interactions: { support: "stable" },
  tools: { support: "stable" },
  images: unsupported,
  thinking: unsupported,
  plans: unsupported,
  usage: unsupported,
  subagents: unsupported,
  shell: unsupported,
  filesystem: unsupported,
  network: unsupported,
  extensions: { "conformance:fixture": { support: "stable" } },
};

export function createConformanceFixture(options: { basicText?: string } = {}): AdapterConformanceFixture {
  const adapterId = "conformance";

  return {
    adapterId,
    discovery: {
      profile: {
        status: "available",
        value: {
          id: adapterId,
          label: "Conformance Adapter",
          permissions: {
            kind: "host-policy",
            selectable: false,
            defaultModeId: "host",
            modes: [{ id: "host", label: "Managed by host", posture: "standard" }],
          },
        },
      },
      models: {
        status: "available",
        value: { models: [{ id: "conformance-model", label: "Conformance Model" }] },
      },
      limits: { status: "unsupported" },
    },
    createAdapter(scenario: AdapterConformanceScenario): HarnessAdapter {
      return {
        id: adapterId,
        capabilities: () => conformanceCapabilities,
        profile: () => this.discovery.profile,
        models: () => this.discovery.models,
        limits: () => this.discovery.limits,
        async open({ resumeToken }) {
          let release: (() => void) | undefined;
          let interactionResponse: HarnessInteractionResponse | undefined;
          const blocked = new Promise<void>((resolve) => { release = resolve; });
          const session: HarnessAdapterSession = {
            async *run(request) {
              if (scenario === "unsafe-error") throw new Error(CONFORMANCE.unsafeSecret);
              if (scenario === "safe-error") throw conformanceSafeError();
              if (scenario === "cancel") {
                yield { kind: "assistant-text", text: CONFORMANCE.waitingText };
                await blocked;
                return;
              }
              if (scenario === "interaction") {
                yield { kind: "interaction-requested", interaction: CONFORMANCE.interaction };
                await blocked;
                yield {
                  kind: "interaction-resolved",
                  interactionId: CONFORMANCE.interaction.id,
                  response: interactionResponse ?? {},
                };
                return;
              }
              if (scenario === "resume-restored") {
                if (resumeToken !== CONFORMANCE.resumeToken) throw new Error(CONFORMANCE.unsafeSecret);
                yield { kind: "assistant-text", text: CONFORMANCE.resumedText };
                return;
              }
              if (scenario === "tools") {
                const result = await request.tools.call(CONFORMANCE.toolName, { value: CONFORMANCE.toolInput });
                const text = result.content[0]?.type === "text" ? result.content[0].text : "";
                yield { kind: "assistant-text", text };
                return;
              }
              if (scenario === "context") {
                const source = request.context.sources.find((entry) => entry.sourceId === CONFORMANCE.contextSourceId);
                const content = source?.value.content[0];
                yield { kind: "assistant-text", text: content?.type === "text" ? content.text : "" };
                return;
              }
              yield { kind: "assistant-text", text: options.basicText ?? CONFORMANCE.text };
            },
            respond(interactionId, response) {
              if (interactionId !== CONFORMANCE.interaction.id) throw new Error("unexpected interaction id");
              interactionResponse = response;
              release?.();
              return Promise.resolve();
            },
            cancel() {
              release?.();
              return Promise.resolve();
            },
            checkpoint: () => scenario === "resume-initial" ? CONFORMANCE.resumeToken : resumeToken,
          };
          return session;
        },
      };
    },
  };
}
