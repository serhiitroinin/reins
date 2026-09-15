/** A deterministic ACP peer driving the real stable-v1 adapter. */

import * as acp from "@agentclientprotocol/sdk";
import {
  createAcpV1Adapter,
  type AcpV1Adapter,
} from "../adapters/acp-v1-adapter.js";
import type { AcpV1ByteConnection } from "../adapters/acp-v1.js";
import type { AdapterConformanceFixture, AdapterConformanceScenario } from "./conformance.js";
import { CONFORMANCE } from "./conformance.js";

export interface AcpV1FixtureState {
  connections: number;
  closes: number;
  cancellations: number;
  loadedSessions: string[];
  permissionOutcomes: AcpV1FixturePermissionOutcome[];
}

export interface AcpV1FixturePermissionOutcome {
  outcome: "selected" | "cancelled";
  optionId?: string;
}

class SafeConformanceFailure extends Error {}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function fakeConnection(agent: acp.AgentApp, state: AcpV1FixtureState): AcpV1ByteConnection {
  const clientToAgent = new TransformStream<Uint8Array>();
  const agentToClient = new TransformStream<Uint8Array>();
  const peer = agent.connect(acp.ndJsonStream(agentToClient.writable, clientToAgent.readable));
  let closed = false;
  return {
    readable: agentToClient.readable,
    writable: clientToAgent.writable,
    close() {
      if (closed) return;
      closed = true;
      state.closes += 1;
      peer.close();
    },
  };
}

function conformanceAgent(
  scenario: AdapterConformanceScenario,
  state: AcpV1FixtureState,
): acp.AgentApp {
  const cancelled = deferred<void>();
  return acp.agent({ name: "fold-harness-acp-conformance" })
    .onRequest(acp.methods.agent.initialize, () => ({
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
      agentInfo: { name: "conformance-agent", version: "1" },
    }))
    .onRequest(acp.methods.agent.session.new, () => ({
      sessionId: scenario === "resume-initial" ? CONFORMANCE.resumeToken : "acp-conformance-session",
    }))
    .onRequest(acp.methods.agent.session.load, ({ params }) => {
      state.loadedSessions.push(params.sessionId);
      return {};
    })
    .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
      const emitText = (text: string) => client.notify(acp.methods.client.session.update, {
        sessionId: params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
      });
      if (scenario === "cancel") {
        await emitText(CONFORMANCE.waitingText);
        await cancelled.promise;
        return { stopReason: "cancelled" };
      }
      if (scenario === "interaction") {
        const response = await client.request(acp.methods.client.session.requestPermission, {
          sessionId: params.sessionId,
          toolCall: { toolCallId: "conformance-permission", title: "Conformance permission" },
          options: [{ optionId: "continue", name: "Continue", kind: "allow_once" }],
        });
        state.permissionOutcomes.push(response.outcome.outcome === "selected"
          ? { outcome: "selected", optionId: response.outcome.optionId }
          : { outcome: "cancelled" });
        return { stopReason: "end_turn" };
      }
      const promptText = params.prompt.find((block) => block.type === "text")?.text;
      await emitText(
        scenario === "resume-restored"
          ? CONFORMANCE.resumedText
          : scenario === "tools" || scenario === "context"
            ? promptText ?? "missing"
            : CONFORMANCE.text,
      );
      return { stopReason: "end_turn" };
    })
    .onNotification(acp.methods.agent.session.cancel, () => {
      state.cancellations += 1;
      cancelled.resolve();
    });
}

/** Construct the real ACP adapter against an official-SDK in-process peer. */
export function createAcpV1ConformanceFixture(): AdapterConformanceFixture & {
  adapter: AcpV1Adapter;
  state: AcpV1FixtureState;
} {
  const adapterId = "acp-conformance";
  let scenario: AdapterConformanceScenario = "basic";
  const state: AcpV1FixtureState = {
    connections: 0,
    closes: 0,
    cancellations: 0,
    loadedSessions: [],
    permissionOutcomes: [],
  };
  const discovery = {
    profile: {
      status: "available",
      value: {
        id: adapterId,
        label: "ACP Conformance",
        permissions: {
          kind: "host-policy",
          selectable: false,
          defaultModeId: "host",
          modes: [{ id: "host", label: "Managed by host", posture: "restricted" }],
        },
      },
    },
    models: {
      status: "available",
      value: { models: [{ id: "acp-conformance-model", label: "ACP Conformance Model" }] },
    },
    limits: { status: "unsupported" },
  } satisfies AdapterConformanceFixture["discovery"];

  const adapter = createAcpV1Adapter({
    id: adapterId,
    profile: discovery.profile,
    models: discovery.models,
    limits: discovery.limits,
    session: () => ({ cwd: "/acp-conformance" }),
    connect() {
      if (scenario === "unsafe-error") throw new Error(CONFORMANCE.unsafeSecret);
      if (scenario === "safe-error") throw new SafeConformanceFailure();
      state.connections += 1;
      return fakeConnection(conformanceAgent(scenario, state), state);
    },
    async mapPrompt(request) {
      if (scenario === "tools") {
        const result = await request.tools.call(CONFORMANCE.toolName, { value: CONFORMANCE.toolInput });
        const content = result.content.find((entry) => entry.type === "text");
        return [{ type: "text", text: content?.type === "text" ? content.text : "missing" }];
      }
      if (scenario === "context") {
        const source = request.context.sources.find((entry) => entry.sourceId === CONFORMANCE.contextSourceId);
        const content = source?.value.content.find((entry) => entry.type === "text");
        return [{ type: "text", text: content?.type === "text" ? content.text : "missing" }];
      }
      return [{ type: "text", text: "Run the ACP conformance scenario." }];
    },
    authorizePermission() {
      return {
        behavior: "ask",
        interaction: CONFORMANCE.interaction,
        resolve: (response) => response.choiceId === "continue"
          ? { behavior: "select", optionId: "continue" }
          : { behavior: "cancel" },
      };
    },
    publicError(error) {
      return error instanceof SafeConformanceFailure
        ? {
            code: CONFORMANCE.safeError.code,
            message: CONFORMANCE.safeError.message,
            retryable: true,
          }
        : undefined;
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
