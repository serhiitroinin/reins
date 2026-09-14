/** A deterministic fake provider driving the real Claude Agent SDK adapter. */

import type { HarnessCapabilities } from "../protocol.js";
import {
  CLAUDE_AGENT_SDK_CAPABILITIES,
  createClaudeAgentSdkAdapter,
  type ClaudeAgentSdkConnection,
  type ClaudeAgentSdkTurnInput,
} from "../adapters/claude-agent-sdk-adapter.js";
import { createPushableAsyncIterable } from "../transports/async-iterable.js";
import type { AdapterConformanceFixture, AdapterConformanceScenario } from "./conformance.js";
import { CONFORMANCE } from "./conformance.js";

export interface ClaudeAgentSdkFixtureState {
  connects: number;
  sends: ClaudeAgentSdkTurnInput[];
  resumeTokens: Array<string | null>;
  interruptions: number;
  closes: number;
  toolDecisions: Array<{ behavior: string }>;
}

const capabilities: HarnessCapabilities = {
  ...CLAUDE_AGENT_SDK_CAPABILITIES,
  shell: { support: "unsupported" },
  filesystem: { support: "unsupported" },
  network: { support: "unsupported" },
};

/** Construct the real adapter against deterministic provider messages. */
export function createClaudeAgentSdkConformanceFixture(): AdapterConformanceFixture & {
  state: ClaudeAgentSdkFixtureState;
} {
  const adapterId = "claude-conformance";
  let scenario: AdapterConformanceScenario = "basic";
  const state: ClaudeAgentSdkFixtureState = {
    connects: 0,
    sends: [],
    resumeTokens: [],
    interruptions: 0,
    closes: 0,
    toolDecisions: [],
  };
  const discovery = {
    profile: {
      status: "available",
      value: {
        id: adapterId,
        label: "Claude Conformance",
        permissions: {
          kind: "approval-policy",
          selectable: true,
          defaultModeId: "default",
          modes: [{ id: "default", label: "Ask", posture: "standard" }],
        },
      },
    },
    models: {
      status: "available",
      value: { models: [{ id: "claude-conformance-model", label: "Claude Conformance Model" }] },
    },
    limits: { status: "unsupported" },
  } satisfies AdapterConformanceFixture["discovery"];

  const adapter = createClaudeAgentSdkAdapter({
    id: adapterId,
    capabilities,
    profile: discovery.profile,
    models: discovery.models,
    limits: discovery.limits,
    connect(request) {
      const current = scenario;
      if (current === "unsafe-error") throw new Error(CONFORMANCE.unsafeSecret);
      state.connects += 1;
      state.resumeTokens.push(request.resumeToken);
      const messages = createPushableAsyncIterable<unknown>();
      let closed = false;
      const complete = (): void => {
        messages.push({ type: "result", subtype: "success", is_error: false });
      };
      const assistant = (text: string): void => {
        messages.push({
          type: "assistant",
          message: { content: [{ type: "text", text }] },
        });
      };
      const connection: ClaudeAgentSdkConnection = {
        messages,
        send(input) {
          state.sends.push(input);
          if (current === "safe-error") {
            messages.push({ type: "result", subtype: "conformance-safe", is_error: true });
            return;
          }
          if (current === "cancel") {
            assistant(CONFORMANCE.waitingText);
            return;
          }
          if (current === "interaction") {
            void request.canUseTool({
              toolName: "AskUserQuestion",
              input: {},
              toolUseId: "interaction-tool",
            }).then((decision) => {
              state.toolDecisions.push(decision);
              complete();
            });
            return;
          }
          if (current === "resume-initial") {
            messages.push({ type: "system", subtype: "init", session_id: CONFORMANCE.resumeToken });
            assistant(CONFORMANCE.text);
            complete();
            return;
          }
          if (current === "resume-restored") {
            assistant(request.resumeToken === CONFORMANCE.resumeToken
              ? CONFORMANCE.resumedText
              : "resume-missing");
            complete();
            return;
          }
          if (current === "tools") {
            void request.tools.call(CONFORMANCE.toolName, { value: CONFORMANCE.toolInput }).then((result) => {
              const content = result.content[0];
              assistant(content?.type === "text" ? content.text : "");
              complete();
            });
            return;
          }
          if (current === "context") {
            const source = input.context.sources.find((entry) => entry.sourceId === CONFORMANCE.contextSourceId);
            const content = source?.value.content[0];
            assistant(content?.type === "text" ? content.text : "context-missing");
            complete();
            return;
          }
          assistant(CONFORMANCE.text);
          complete();
        },
        interrupt() {
          state.interruptions += 1;
        },
        close() {
          if (closed) return;
          closed = true;
          state.closes += 1;
          messages.close();
        },
      };
      return connection;
    },
    authorizeTool() {
      return {
        behavior: "ask",
        interaction: CONFORMANCE.interaction,
        resolve: () => ({ behavior: "allow" }),
      };
    },
    events: {
      eventContentChunkChars: CONFORMANCE.waitingText.length,
      publicError(error) {
        if (error.subtype === "conformance-safe") {
          return {
            code: CONFORMANCE.safeError.code,
            message: CONFORMANCE.safeError.message,
            retryable: true,
          };
        }
        return { code: "CLAUDE_PROVIDER_ERROR", message: "Claude could not complete the turn." };
      },
    },
  });

  return {
    adapterId,
    adapter,
    discovery,
    state,
    useScenario(value) {
      scenario = value;
    },
  };
}
