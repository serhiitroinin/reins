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
  steering: { support: "stable", strategies: ["same-turn"], preferred: "same-turn" },
  extensions: { "conformance:fixture": { support: "stable" } },
};

export function createConformanceFixture(options: {
  basicText?: string;
  hangScenario?: AdapterConformanceScenario;
  onCancel?: () => void;
  onClose?: () => void;
} = {}): AdapterConformanceFixture {
  const adapterId = "conformance";
  let scenario: AdapterConformanceScenario = "basic";

  const discovery = {
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
    } satisfies AdapterConformanceFixture["discovery"];
  const adapter: HarnessAdapter = {
        id: adapterId,
        capabilities: () => conformanceCapabilities,
        profile: () => discovery.profile,
        models: () => discovery.models,
        limits: () => discovery.limits,
        async open({ resumeToken }) {
          const current = scenario;
          let release: (() => void) | undefined;
          let interactionResponse: HarnessInteractionResponse | undefined;
          let followUpText: string | undefined;
          const blocked = new Promise<void>((resolve) => { release = resolve; });
          const session: HarnessAdapterSession = {
            async *run(request) {
              if (current === options.hangScenario) {
                await blocked;
                return;
              }
              if (current === "unsafe-error") throw new Error(CONFORMANCE.unsafeSecret);
              if (current === "safe-error") throw conformanceSafeError();
              if (current === "cancel") {
                yield { kind: "assistant-text", text: CONFORMANCE.waitingText };
                await blocked;
                return;
              }
              if (current === "steering") {
                yield { kind: "assistant-text", text: CONFORMANCE.waitingText };
                await blocked;
                yield { kind: "assistant-text", text: followUpText ?? "follow-up-missing" };
                return;
              }
              if (current === "interaction") {
                yield { kind: "interaction-requested", interaction: CONFORMANCE.interaction };
                await blocked;
                yield {
                  kind: "interaction-resolved",
                  interactionId: CONFORMANCE.interaction.id,
                  response: interactionResponse ?? {},
                };
                return;
              }
              if (current === "resume-restored") {
                if (resumeToken !== CONFORMANCE.resumeToken) throw new Error(CONFORMANCE.unsafeSecret);
                yield { kind: "assistant-text", text: CONFORMANCE.resumedText };
                return;
              }
              if (current === "tools") {
                const result = await request.tools.call(CONFORMANCE.toolName, { value: CONFORMANCE.toolInput });
                const text = result.content[0]?.type === "text" ? result.content[0].text : "";
                yield { kind: "assistant-text", text };
                return;
              }
              if (current === "context") {
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
            steer(request) {
              const input = request.input.find((entry) => entry.type === "text");
              followUpText = input?.type === "text" ? input.text : undefined;
              release?.();
              return Promise.resolve();
            },
            cancel() {
              options.onCancel?.();
              release?.();
              return Promise.resolve();
            },
            checkpoint: () => current === "resume-initial" ? CONFORMANCE.resumeToken : resumeToken,
            close() {
              options.onClose?.();
              return Promise.resolve();
            },
          };
          return session;
        },
      };

  return {
    adapterId,
    adapter,
    discovery,
    useScenario(value) {
      scenario = value;
    },
  };
}
