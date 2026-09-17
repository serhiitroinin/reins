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
import { CONFORMANCE, conformanceSafeError } from "./conformance.js";
import type { AdapterReliabilityFixture, AdapterReliabilityScenario } from "./reliability.js";
import { RELIABILITY } from "./reliability.js";

export interface ClaudeAgentSdkFixtureState {
  connects: number;
  sends: ClaudeAgentSdkTurnInput[];
  resumeTokens: Array<string | null>;
  interruptions: number;
  closes: number;
  toolDecisions: Array<{ behavior: string }>;
  subagentStops: string[];
}

const capabilities: HarnessCapabilities = {
  ...CLAUDE_AGENT_SDK_CAPABILITIES,
  shell: { support: "unsupported" },
  filesystem: { support: "unsupported" },
  network: { support: "unsupported" },
};

/** Construct the real adapter against deterministic provider messages. */
export function createClaudeAgentSdkConformanceFixture(): AdapterConformanceFixture & AdapterReliabilityFixture & {
  state: ClaudeAgentSdkFixtureState;
} {
  const adapterId = "claude-conformance";
  let scenario: AdapterConformanceScenario | AdapterReliabilityScenario = "basic";
  const state: ClaudeAgentSdkFixtureState = {
    connects: 0,
    sends: [],
    resumeTokens: [],
    interruptions: 0,
    closes: 0,
    toolDecisions: [],
    subagentStops: [],
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
        inputPolicy: {
          modalities: {
            text: { support: "stable" },
            "context-reference": { support: "stable" },
          },
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
      if (current === "resume-rejected" && request.resumeToken !== null) {
        throw new Error(RELIABILITY.unsafeSecret);
      }
      state.connects += 1;
      state.resumeTokens.push(request.resumeToken);
      const messages = createPushableAsyncIterable<unknown>();
      let streamFailure: unknown;
      let closed = false;
      let sends = 0;
      const stream: AsyncIterable<unknown> = {
        async *[Symbol.asyncIterator]() {
          for await (const message of messages) yield message;
          if (streamFailure !== undefined) throw streamFailure;
        },
      };
      const fail = (error: unknown): void => {
        streamFailure = error;
        messages.close();
      };
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
        messages: stream,
        send(input) {
          sends += 1;
          state.sends.push(input);
          if (current === "provider-death") {
            messages.push({
              type: "assistant",
              message: { content: [
                { type: "text", text: RELIABILITY.partialText },
                { type: "tool_use", id: "reliability-open-tool", name: "Read", input: {} },
              ] },
            });
            fail(new Error(RELIABILITY.unsafeSecret));
            return;
          }
          if (current === "malformed-traffic") {
            messages.push({ type: "unknown", private: RELIABILITY.unsafeSecret });
            messages.push({ type: "result", subtype: "", is_error: false, error: RELIABILITY.unsafeSecret });
            messages.push({ type: "result", subtype: "success", is_error: "false", error: RELIABILITY.unsafeSecret });
            assistant(RELIABILITY.recoveredText);
            complete();
            return;
          }
          if (current === "cancel-after-partial") {
            messages.push({
              type: "assistant",
              message: { content: [
                { type: "text", text: RELIABILITY.partialText },
                { type: "tool_use", id: "reliability-cancelled-tool", name: "Read", input: {} },
              ] },
            });
            return;
          }
          if (current === "resume-rejected") {
            assistant(RELIABILITY.recoveredText);
            complete();
            return;
          }
          if (current === "safe-error") {
            messages.push({ type: "result", subtype: "conformance-safe", is_error: true });
            return;
          }
          if (current === "cancel") {
            assistant(CONFORMANCE.waitingText);
            return;
          }
          if (current.startsWith("subagent-stop")) {
            assistant(CONFORMANCE.waitingText);
            return;
          }
          if (current === "steering") {
            if (sends === 1) {
              assistant(CONFORMANCE.waitingText);
              return;
            }
            const followUp = input.input.find((entry) => entry.type === "text");
            assistant(followUp?.type === "text" ? followUp.text : "follow-up-missing");
            complete();
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
          if (current === "typed-context") {
            const inputMatches = JSON.stringify(input.input) === JSON.stringify(CONFORMANCE.typedContextInput);
            const contextMatches = JSON.stringify(input.inlineContext) === JSON.stringify(CONFORMANCE.typedInlineContext);
            assistant(inputMatches && contextMatches ? CONFORMANCE.typedContextText : "typed-context-mismatch");
            complete();
            return;
          }
          assistant(CONFORMANCE.text);
          complete();
        },
        interrupt() {
          state.interruptions += 1;
          messages.push({ type: "result", subtype: "interrupted", is_error: true });
          if (current === "cancel-after-partial") {
            assistant(RELIABILITY.unsafeSecret);
          }
        },
        stopSubagent(taskId) {
          state.subagentStops.push(taskId);
          if (current === "subagent-stop-false") return false;
          if (current === "subagent-stop-safe-error") throw conformanceSafeError();
          if (current === "subagent-stop-race") return new Promise(() => undefined);
          complete();
          return true;
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
    providerOpens: () => state.connects,
    providerCloses: () => state.closes,
    subagentControls: () => state.subagentStops.length,
    useScenario(value) {
      scenario = value;
    },
    useReliabilityScenario(value) {
      scenario = value;
    },
  };
}
