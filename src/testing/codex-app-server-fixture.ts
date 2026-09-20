/** A deterministic fake App Server driving the real Codex adapter. */

import type { HarnessCapabilities } from "../protocol.js";
import { harnessContextReferenceText } from "../input.js";
import { createPushableAsyncIterable } from "../transports/async-iterable.js";
import { createNdjsonReader } from "../transports/ndjson.js";
import {
  CODEX_APP_SERVER_CAPABILITIES,
  createCodexAppServerAdapter,
  type CodexAppServerConnection,
} from "../adapters/codex-app-server-adapter.js";
import { CODEX_SERVICE_TIER_CONTROL_ID } from "../adapters/codex-app-server.js";
import type { AdapterConformanceFixture, AdapterConformanceScenario } from "./conformance.js";
import { CONFORMANCE } from "./conformance.js";
import type { AdapterReliabilityFixture, AdapterReliabilityScenario } from "./reliability.js";
import { RELIABILITY } from "./reliability.js";

interface RpcMessage {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: unknown;
}

export interface CodexAppServerFixtureRequest {
  method: string;
  params: Record<string, unknown>;
}

export interface CodexAppServerFixtureState {
  connections: number;
  requests: CodexAppServerFixtureRequest[];
  interruptions: number;
  toolResponses: Record<string, unknown>[];
  closes: number;
}

const capabilities: HarnessCapabilities = {
  ...CODEX_APP_SERVER_CAPABILITIES,
  interactions: { support: "unsupported", recovery: "live-only" },
};

type CodexFixtureScenario = AdapterConformanceScenario | AdapterReliabilityScenario;

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function fakeConnection(
  scenario: CodexFixtureScenario,
  state: CodexAppServerFixtureState,
): CodexAppServerConnection {
  const output = createPushableAsyncIterable<Uint8Array | string>();
  const encoder = new TextEncoder();
  let outputFailure: unknown;
  let nextServerId = 100;
  const waiting = new Map<number, (message: RpcMessage) => void>();
  let threadId = "codex-conformance-thread";

  const send = (message: unknown): void => {
    const bytes = encoder.encode(`${JSON.stringify(message)}\n`);
    const cut = Math.min(7, bytes.length);
    output.push(bytes.slice(0, cut));
    output.push(bytes.slice(cut));
  };
  const failOutput = (error: unknown): void => {
    outputFailure = error;
    output.close();
  };
  const answer = (id: string | number, result: unknown): void => {
    send({ jsonrpc: "2.0", id, result });
  };
  const notify = (method: string, params: unknown): void => {
    send({ jsonrpc: "2.0", method, params });
  };
  const assistant = (text: string): void => {
    notify("item/started", { item: { type: "agentMessage", id: "message-1", text: "" } });
    notify("item/agentMessage/delta", { itemId: "message-1", delta: text });
    notify("item/completed", { item: { type: "agentMessage", id: "message-1", text } });
  };
  const complete = (status = "completed", error?: unknown): void => {
    notify("turn/completed", { turn: { status, ...(error === undefined ? {} : { error }) } });
  };
  const startOpenTool = (): void => {
    notify("item/started", {
      item: {
        type: "dynamicToolCall",
        id: "reliability-tool",
        namespace: null,
        tool: "reliability_tool",
        arguments: {},
        status: "inProgress",
      },
    });
  };
  const callTool = (name: string, input: unknown): void => {
    const id = ++nextServerId;
    send({
      jsonrpc: "2.0",
      id,
      method: "item/tool/call",
      params: { threadId, turnId: "codex-turn", callId: "tool-call", tool: name, arguments: input },
    });
    waiting.set(id, (message) => {
      const result = object(message.result);
      state.toolResponses.push(result);
      const rows = Array.isArray(result.contentItems) ? result.contentItems : [];
      const text = rows.map((row) => string(object(row).text)).filter(Boolean).join("\n");
      notify("item/completed", {
        item: {
          type: "dynamicToolCall",
          id: "tool-call",
          namespace: null,
          tool: name,
          arguments: input,
          status: result.success === false ? "failed" : "completed",
          success: result.success !== false,
          contentItems: rows,
        },
      });
      assistant(text);
      complete();
    });
  };

  const afterTurnStarts = (params: Record<string, unknown>): void => {
    if (scenario === "provider-death") {
      assistant(RELIABILITY.partialText);
      startOpenTool();
      failOutput(new Error(RELIABILITY.unsafeSecret));
      return;
    }
    if (scenario === "malformed-traffic") {
      output.push(`{"jsonrpc":"2.0","secret":"${RELIABILITY.unsafeSecret}"\n`);
      const id = ++nextServerId;
      waiting.set(id, (message) => {
        const error = object(message.error);
        if (
          error.code !== -32601
          || error.message !== "this adapter answers only dynamic tool calls"
        ) {
          failOutput(new Error("the adapter did not refuse an unsupported provider request"));
          return;
        }
        assistant(RELIABILITY.recoveredText);
        complete();
      });
      send({
        jsonrpc: "2.0",
        id,
        method: "reliability/unsupported",
        params: { secret: RELIABILITY.unsafeSecret },
      });
      return;
    }
    if (scenario === "cancel-after-partial") {
      assistant(RELIABILITY.partialText);
      startOpenTool();
      return;
    }
    if (scenario === "resume-rejected") {
      assistant(RELIABILITY.recoveredText);
      complete();
      return;
    }
    if (scenario === "safe-error") {
      complete("failed", {
        code: CONFORMANCE.safeError.code,
        message: CONFORMANCE.safeError.message,
      });
      return;
    }
    if (scenario === "cancel" || scenario === "steering") {
      assistant(CONFORMANCE.waitingText);
      return;
    }
    if (scenario === "tools") {
      notify("item/started", {
        item: {
          type: "dynamicToolCall",
          id: "tool-call",
          namespace: null,
          tool: CONFORMANCE.toolName,
          arguments: { value: CONFORMANCE.toolInput },
          status: "inProgress",
        },
      });
      callTool(CONFORMANCE.toolName, { value: CONFORMANCE.toolInput });
      return;
    }
    if (scenario === "context") {
      const context = object(params.additionalContext);
      const untrusted = Object.values(context)
        .map(object)
        .find((entry) => entry.kind === "untrusted" && entry.value === CONFORMANCE.contextText);
      assistant(untrusted ? CONFORMANCE.contextText : "context-missing");
      complete();
      return;
    }
    if (scenario === "typed-context") {
      const expected = CONFORMANCE.typedContextInput.map((input) => ({
        type: "text",
        text: input.type === "context-reference"
          ? harnessContextReferenceText(input, CONFORMANCE.typedInlineContext)
          : input.text,
        text_elements: [],
      }));
      const mapped = Array.isArray(params.input) ? params.input : [];
      assistant(JSON.stringify(mapped) === JSON.stringify(expected)
        ? CONFORMANCE.typedContextText
        : "typed-context-mismatch");
      complete();
      return;
    }
    assistant(scenario === "resume-restored" ? CONFORMANCE.resumedText : CONFORMANCE.text);
    complete();
  };

  const handle = (message: RpcMessage): void => {
    if (message.method === undefined && typeof message.id === "number") {
      const resolve = waiting.get(message.id);
      if (resolve) {
        waiting.delete(message.id);
        resolve(message);
      }
      return;
    }
    if (message.method === undefined || message.id === undefined) return;
    const params = object(message.params);
    state.requests.push({ method: message.method, params });
    if (message.method === "initialize") {
      answer(message.id, {});
      return;
    }
    if (message.method === "thread/start") {
      threadId = scenario === "resume-initial" ? CONFORMANCE.resumeToken : "codex-conformance-thread";
      answer(message.id, { thread: { id: threadId } });
      return;
    }
    if (message.method === "thread/resume") {
      if (scenario === "resume-rejected") {
        send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32000, message: RELIABILITY.unsafeSecret },
        });
        return;
      }
      threadId = string(params.threadId);
      answer(message.id, { thread: { id: threadId } });
      return;
    }
    if (message.method === "turn/start") {
      answer(message.id, { turn: { id: "codex-turn" } });
      queueMicrotask(() => afterTurnStarts(params));
      return;
    }
    if (message.method === "turn/steer" && scenario === "steering") {
      answer(message.id, {});
      const input = Array.isArray(params.input) ? params.input : [];
      const followUp = input.map(object).find((entry) => entry.type === "text");
      queueMicrotask(() => {
        assistant(string(followUp?.text) || "follow-up-missing");
        complete();
      });
      return;
    }
    if (message.method === "turn/interrupt") {
      state.interruptions += 1;
      answer(message.id, {});
      queueMicrotask(() => {
        complete("interrupted");
        if (scenario === "cancel-after-partial") {
          notify("item/agentMessage/delta", {
            itemId: "post-terminal-secret",
            delta: RELIABILITY.unsafeSecret,
          });
        }
      });
      return;
    }
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unsupported fake method" } });
  };

  const reader = createNdjsonReader((message) => handle(message as RpcMessage));
  const providerOutput: AsyncIterable<Uint8Array | string> = {
    async *[Symbol.asyncIterator]() {
      for await (const chunk of output) yield chunk;
      if (outputFailure !== undefined) throw outputFailure;
    },
  };
  let closed = false;
  return {
    write(line) {
      reader.text(line);
    },
    output: providerOutput,
    close() {
      if (closed) return;
      closed = true;
      state.closes += 1;
      reader.end();
      output.close();
    },
  };
}

/** Construct the real adapter against deterministic JSON-RPC provider traffic. */
export function createCodexAppServerConformanceFixture(): AdapterConformanceFixture & AdapterReliabilityFixture & {
  state: CodexAppServerFixtureState;
} {
  const adapterId = "codex-conformance";
  let scenario: CodexFixtureScenario = "basic";
  const state: CodexAppServerFixtureState = {
    connections: 0,
    requests: [],
    interruptions: 0,
    toolResponses: [],
    closes: 0,
  };
  const discovery = {
    profile: {
      status: "available",
      value: {
        id: adapterId,
        label: "Codex Conformance",
        permissions: {
          kind: "sandbox",
          selectable: true,
          defaultModeId: "read-only",
          modes: [{ id: "read-only", label: "Read-only", posture: "restricted" }],
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
      value: { models: [{ id: "codex-conformance-model", label: "Codex Conformance Model" }] },
    },
    limits: { status: "unsupported" },
  } satisfies AdapterConformanceFixture["discovery"];

  const adapter = createCodexAppServerAdapter({
    id: adapterId,
    clientInfo: { name: "reins-conformance", version: "1" },
    capabilities,
    profile: discovery.profile,
    models: discovery.models,
    limits: discovery.limits,
    thread: (request) => ({
      cwd: "/conformance",
      sandbox: request.settings?.permission?.modeId ?? "read-only",
      approvalPolicy: "never",
      ...(request.model ? { model: request.model } : {}),
    }),
    connect() {
      if (scenario === "unsafe-error") throw new Error(CONFORMANCE.unsafeSecret);
      state.connections += 1;
      return fakeConnection(scenario, state);
    },
    events: {
      publicError(error) {
        if (error.code === CONFORMANCE.safeError.code) {
          return {
            code: CONFORMANCE.safeError.code,
            message: CONFORMANCE.safeError.message,
            retryable: true,
          };
        }
        return { code: "CODEX_PROVIDER_ERROR", message: "Codex could not complete the turn." };
      },
    },
  });

  return {
    adapterId,
    adapter,
    discovery,
    state,
    providerOpens: () => state.connections,
    providerCloses: () => state.closes,
    subagentControls: () => 0,
    useScenario(value) {
      scenario = value;
    },
    useReliabilityScenario(value) {
      scenario = value;
    },
  };
}

export interface CodexAppServerDiscoveryFixture {
  state: CodexAppServerFixtureState;
  /** Responses are read on each probe, so a test may replace them. */
  responses: { modelPages: readonly Record<string, unknown>[]; rateLimits: unknown };
  /** "missing" throws at connect. "silent" accepts requests and never answers. */
  behavior: "answer" | "missing" | "silent";
  connect(): CodexAppServerConnection;
}

/** A fake App Server that answers only the discovery requests. */
export function createCodexAppServerDiscoveryFixture(): CodexAppServerDiscoveryFixture {
  const fixture: CodexAppServerDiscoveryFixture = {
    state: { connections: 0, requests: [], interruptions: 0, toolResponses: [], closes: 0 },
    behavior: "answer",
    responses: {
      modelPages: [
        {
          data: [{
            id: "gpt-test",
            displayName: "GPT Test",
            isDefault: true,
            defaultReasoningEffort: "medium",
            supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }],
          }],
          nextCursor: "page-2",
        },
        { data: [{ id: "gpt-test-mini", displayName: "GPT Test Mini" }] },
      ],
      rateLimits: {
        rateLimits: {
          limitId: "codex",
          planType: "pro",
          primary: { usedPercent: 70, windowDurationMins: 10_080, resetsAt: 1_789_820_312 },
        },
        rateLimitsByLimitId: {
          codex: {
            limitId: "codex",
            planType: "pro",
            primary: { usedPercent: 70, windowDurationMins: 10_080, resetsAt: 1_789_820_312 },
            secondary: { usedPercent: 5, windowDurationMins: 300 },
          },
        },
      },
    },
    connect() {
      if (fixture.behavior === "missing") throw new Error(CONFORMANCE.unsafeSecret);
      fixture.state.connections += 1;
      const output = createPushableAsyncIterable<Uint8Array | string>();
      const answer = (id: string | number, result: unknown): void => {
        output.push(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
      };
      const reader = createNdjsonReader((value) => {
        const message = value as RpcMessage;
        if (message.method === undefined || message.id === undefined) return;
        const params = object(message.params);
        fixture.state.requests.push({ method: message.method, params });
        if (fixture.behavior === "silent") return;
        if (message.method === "initialize") return answer(message.id, {});
        if (message.method === "model/list") {
          const pages = fixture.responses.modelPages;
          const at = pages.findIndex((page, index) => index > 0 && pages[index - 1]?.nextCursor === params.cursor);
          return answer(message.id, pages[params.cursor === undefined ? 0 : at] ?? { data: [] });
        }
        if (message.method === "account/rateLimits/read" && fixture.responses.rateLimits !== undefined) {
          return answer(message.id, fixture.responses.rateLimits);
        }
        output.push(`${JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: "unsupported fake method" },
        })}\n`);
      });
      let closed = false;
      return {
        write: (line) => reader.text(line),
        output,
        close() {
          if (closed) return;
          closed = true;
          fixture.state.closes += 1;
          reader.end();
          output.close();
        },
      };
    },
  };
  return fixture;
}

export { CODEX_SERVICE_TIER_CONTROL_ID };
