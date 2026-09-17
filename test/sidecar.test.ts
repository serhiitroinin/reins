import { describe, expect, test } from "bun:test";
import {
  createHarnessSidecar,
  createJsonRpcPeer,
  createMemoryPersistence,
  HARNESS_SIDECAR_HOST_METHODS,
  HARNESS_SIDECAR_METHODS,
  HARNESS_SIDECAR_NOTIFICATIONS,
  type HarnessAdapter,
  type HarnessAdapterRunRequest,
  type HarnessAdapterSession,
  type HarnessCapabilities,
  type HarnessEvent,
  type HarnessSidecar,
  type HarnessSidecarToolCallParams,
  type JsonRpcPeer,
} from "../src/index.ts";

const SESSION = { tenantId: "tenant", actorId: "actor", threadId: "thread" };
const ADAPTER_ID = "example:sidecar";
const unsupported = { support: "unsupported" as const };
const capabilities: HarnessCapabilities = {
  resume: unsupported,
  cancel: { support: "stable" },
  interactions: { support: "stable", recovery: "live-only" },
  tools: { support: "stable" },
  images: { support: "stable" },
  thinking: unsupported,
  plans: unsupported,
  usage: unsupported,
  subagents: { support: "stable", controls: ["stop"] },
  shell: unsupported,
  filesystem: unsupported,
  network: unsupported,
  steering: {
    support: "stable",
    strategies: ["same-turn", "replacement-turn"],
    preferred: "same-turn",
  },
};

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function createAdapter(observed: HarnessAdapterRunRequest[]): HarnessAdapter {
  let gate = deferred();
  let steered = "";
  let interactionText = "";
  const session: HarnessAdapterSession = {
    async *run(request) {
      observed.push(request);
      gate = deferred();
      const first = request.input[0];
      const text = first?.type === "text" ? first.text : "";
      if (text === "hold") {
        yield { kind: "assistant-text", text: "waiting" };
        await gate.promise;
        yield { kind: "assistant-text", text: steered };
        return;
      }
      if (text === "replace") {
        yield { kind: "assistant-text", text: "replacing" };
        await gate.promise;
        return;
      }
      if (text === "interaction") {
        yield {
          kind: "interaction-requested",
          interaction: { id: "approval-1", kind: "question", title: "Continue?", acceptsText: true },
        };
        await gate.promise;
        yield { kind: "assistant-text", text: interactionText };
        return;
      }
      if (text === "subagent") {
        yield {
          kind: "subagent-started",
          taskId: "task-1",
          label: "Research",
        };
        await gate.promise;
        yield { kind: "subagent-completed", taskId: "task-1", status: "cancelled" };
        return;
      }
      if (text === "cancel") {
        yield { kind: "assistant-text", text: "partial" };
        await gate.promise;
        return;
      }
      if (text === "tool") {
        const listed = request.tools.list();
        const result = await request.tools.call("lookup", { query: "status" });
        const value = result.content[0];
        yield {
          kind: "assistant-text",
          text: `${listed[0]?.name ?? "missing"}:${value?.type === "text" ? value.text : "missing"}`,
        };
        return;
      }
      if (text === "context") {
        const contribution = request.context.sources[0]?.value;
        const content = contribution?.content[0];
        yield {
          kind: "assistant-text",
          text: `${contribution?.instructions ?? ""}|${content?.type === "text" ? content.text : ""}`,
        };
        return;
      }
      yield {
        kind: "assistant-text",
        text: `${request.model ?? "none"}:${request.effort ?? "none"}:${String(request.settings?.controls?.speed ?? "none")}:${text}`,
      };
    },
    async steer(request) {
      const first = request.input[0];
      steered = first?.type === "text" ? first.text : "";
      gate.resolve();
    },
    async respond(_interactionId, response) {
      interactionText = response.text ?? "";
      gate.resolve();
    },
    async stopSubagent(request) {
      if (request.taskId !== "task-1") return false;
      gate.resolve();
      return true;
    },
    async cancel() {
      gate.resolve();
    },
  };

  return {
    id: ADAPTER_ID,
    capabilities: () => capabilities,
    profile: () => ({
      status: "available",
      value: {
        id: ADAPTER_ID,
        label: "Sidecar fixture",
        modelSelection: "required",
        permissions: {
          kind: "approval-policy",
          selectable: true,
          defaultModeId: "ask",
          modes: [
            { id: "ask", label: "Ask", posture: "standard" },
            { id: "trusted", label: "Trusted", posture: "elevated" },
          ],
        },
        controls: [{
          id: "speed",
          label: "Speed",
          kind: "select",
          scope: "turn",
          options: [{ id: "normal", label: "Normal" }, { id: "fast", label: "Fast" }],
          defaultValue: "normal",
        }],
        inputPolicy: { modalities: { text: { support: "stable" }, image: { support: "stable" } } },
      },
    }),
    models: () => ({
      status: "available",
      value: {
        selection: "required",
        defaultModelId: "alpha",
        models: [
          {
            id: "alpha",
            label: "Alpha",
            effort: {
              defaultOptionId: "medium",
              options: [{ id: "medium", label: "Medium" }, { id: "high", label: "High" }],
            },
          },
          {
            id: "beta",
            label: "Beta",
            effort: {
              defaultOptionId: "high",
              options: [{ id: "high", label: "High" }],
            },
          },
        ],
      },
    }),
    limits: ({ accountId }) => ({
      status: "available",
      value: { observedAt: "2026-09-17T00:00:00.000Z", accountId, limits: [] },
    }),
    async open() { return session; },
  };
}

interface TestConnection {
  client: JsonRpcPeer;
  server: HarnessSidecar;
  events: HarnessEvent[];
  notifications: Array<{ method: string; params: unknown }>;
  toolCalls: HarnessSidecarToolCallParams[];
}

function connect(
  observed: HarnessAdapterRunRequest[] = [],
  options: { holdToolCall?: boolean } = {},
): TestConnection {
  const events: HarnessEvent[] = [];
  const notifications: Array<{ method: string; params: unknown }> = [];
  const toolCalls: HarnessSidecarToolCallParams[] = [];
  let server!: HarnessSidecar;
  const client = createJsonRpcPeer({
    write: (line) => server.text(line),
    hooks: {
      notification(method, params) {
        notifications.push({ method, params });
        if (method === HARNESS_SIDECAR_NOTIFICATIONS.event) {
          events.push((params as { event: HarnessEvent }).event);
        }
      },
      request(method, params) {
        if (method !== HARNESS_SIDECAR_HOST_METHODS.toolCall) {
          return { error: { code: -32601, message: "unknown host method" } };
        }
        toolCalls.push(params as HarnessSidecarToolCallParams);
        if (options.holdToolCall) return new Promise<never>(() => undefined);
        return {
          result: { content: [{ type: "text", text: "healthy" }] },
        };
      },
    },
  });
  server = createHarnessSidecar({
    adapters: [createAdapter(observed)],
    persistence: createMemoryPersistence(),
    write: (line) => client.text(line),
    server: { name: "test-sidecar", version: "1.0.0" },
  });
  return { client, server, events, notifications, toolCalls };
}

async function initialize(connection: TestConnection): Promise<void> {
  const result = await connection.client.request<{
    protocolVersion: number;
    adapters: string[];
    hostMethods: string[];
  }>(HARNESS_SIDECAR_METHODS.initialize, {
    protocolVersion: 1,
    client: { name: "native-test", version: "1" },
  });
  expect(result).toMatchObject({
    protocolVersion: 1,
    adapters: [ADAPTER_ID],
    hostMethods: [HARNESS_SIDECAR_HOST_METHODS.toolCall],
  });
}

function wireRequest(text: string, patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    session: SESSION,
    adapterId: ADAPTER_ID,
    input: [{ type: "text", text }],
    ...patch,
  };
}

async function waitFor(
  predicate: () => boolean,
  message = "condition",
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(2);
  }
  throw new Error(`timed out waiting for ${message}`);
}

function textEvents(events: readonly HarnessEvent[], runId?: string): string[] {
  return events
    .filter((event) => runId === undefined || event.runId === runId)
    .flatMap((event) => event.payload.kind === "assistant-text" ? [event.payload.text] : []);
}

function runSettled(connection: TestConnection, runId: string): boolean {
  return connection.notifications.some((entry) =>
    entry.method === HARNESS_SIDECAR_NOTIFICATIONS.runSettled
    && (entry.params as { runId: string }).runId === runId);
}

describe("harness sidecar", () => {
  test("negotiates, discovers, streams an admitted turn, and replays history", async () => {
    const observed: HarnessAdapterRunRequest[] = [];
    const connection = connect(observed);
    await expect(connection.client.request(HARNESS_SIDECAR_METHODS.capabilities, { adapterId: ADAPTER_ID }))
      .rejects.toThrow("Initialize the harness sidecar first");
    await initialize(connection);

    const [profile, models, limits] = await Promise.all([
      connection.client.request(HARNESS_SIDECAR_METHODS.profile, {
        schemaVersion: 1,
        adapterId: ADAPTER_ID,
      }),
      connection.client.request(HARNESS_SIDECAR_METHODS.models, {
        schemaVersion: 1,
        adapterId: ADAPTER_ID,
      }),
      connection.client.request(HARNESS_SIDECAR_METHODS.limits, {
        schemaVersion: 1,
        adapterId: ADAPTER_ID,
        accountId: "account-a",
      }),
    ]);
    expect(profile).toMatchObject({ status: "available", value: { id: ADAPTER_ID } });
    expect(models).toMatchObject({ status: "available", value: { defaultModelId: "alpha" } });
    expect(limits).toMatchObject({ status: "available", value: { accountId: "account-a" } });

    const started = await connection.client.request<{ runId: string; turnId: string }>(
      HARNESS_SIDECAR_METHODS.runStart,
      { request: wireRequest("hello"), sessionBinding: "account:a" },
    );
    await waitFor(
      () => connection.notifications.some((entry) =>
        entry.method === HARNESS_SIDECAR_NOTIFICATIONS.runSettled
        && (entry.params as { runId: string }).runId === started.runId),
      "run settlement",
    );
    expect(textEvents(connection.events, started.runId)).toEqual(["alpha:medium:normal:hello"]);
    expect(observed[0]).toMatchObject({
      runId: started.runId,
      turnId: started.turnId,
      model: "alpha",
      effort: "medium",
      settings: { permission: { modeId: "ask" }, controls: { speed: "normal" } },
    });

    const history = await connection.client.request<{ events: HarnessEvent[] }>(
      HARNESS_SIDECAR_METHODS.eventsList,
      { session: SESSION, adapterId: ADAPTER_ID, after: 1 },
    );
    expect(history.events.map((event) => event.sequence)).toEqual([2, 3]);
    expect(history.events).toEqual(connection.events.filter((event) => event.sequence > 1));
    await connection.server.end();
  });

  test("bridges per-turn tools and host-prepared trusted/untrusted context", async () => {
    const connection = connect();
    await initialize(connection);
    const toolRun = await connection.client.request<{ runId: string }>(HARNESS_SIDECAR_METHODS.runStart, {
      request: wireRequest("tool"),
      tools: [{ name: "lookup", description: "Look up status", inputSchema: { type: "object" } }],
    });
    await waitFor(() => textEvents(connection.events, toolRun.runId).length === 1, "tool result");
    expect(textEvents(connection.events, toolRun.runId)).toEqual(["lookup:healthy"]);
    expect(connection.toolCalls).toEqual([expect.objectContaining({
      protocolVersion: 1,
      runId: toolRun.runId,
      name: "lookup",
      input: { query: "status" },
    })]);

    const contextRun = await connection.client.request<{ runId: string }>(HARNESS_SIDECAR_METHODS.runStart, {
      request: wireRequest("context"),
      context: {
        sources: [{
          sourceId: "native:workspace",
          value: {
            instructions: "Use the supplied snapshot.",
            content: [{ type: "text", text: "untrusted domain data" }],
          },
        }],
        unavailable: [],
      },
    });
    await waitFor(() => textEvents(connection.events, contextRun.runId).length === 1, "context result");
    expect(textEvents(connection.events, contextRun.runId)).toEqual([
      "Use the supplied snapshot.|untrusted domain data",
    ]);
    await connection.server.end();
  });

  test("cancels a pending host tool callback with stable call and turn identity", async () => {
    const connection = connect([], { holdToolCall: true });
    await initialize(connection);
    const run = await connection.client.request<{ runId: string; turnId: string }>(
      HARNESS_SIDECAR_METHODS.runStart,
      {
        request: wireRequest("tool"),
        tools: [{ name: "lookup", description: "Look up status", inputSchema: { type: "object" } }],
      },
    );
    await waitFor(() => connection.toolCalls.length === 1, "pending tool call");
    const callId = connection.toolCalls[0]?.callId;
    await connection.client.request(HARNESS_SIDECAR_METHODS.runCancel, { runId: run.runId });
    await waitFor(() => connection.notifications.some((entry) =>
      entry.method === HARNESS_SIDECAR_NOTIFICATIONS.hostToolCancel
      && (entry.params as { callId: string }).callId === callId), "tool cancellation");
    expect(connection.notifications).toContainEqual({
      method: HARNESS_SIDECAR_NOTIFICATIONS.hostToolCancel,
      params: { callId, runId: run.runId, turnId: run.turnId },
    });
    expect(connection.events).toContainEqual(expect.objectContaining({
      runId: run.runId,
      payload: expect.objectContaining({ kind: "turn-completed", status: "interrupted" }),
    }));
    await connection.server.end();
  });

  test("supports same-turn steering, interactions, subagent stop, and cancellation", async () => {
    const connection = connect();
    await initialize(connection);

    const held = await connection.client.request<{ runId: string; turnId: string }>(
      HARNESS_SIDECAR_METHODS.runStart,
      { request: wireRequest("hold") },
    );
    await waitFor(() => textEvents(connection.events, held.runId).includes("waiting"));
    const steered = await connection.client.request<{ strategy: string; runId: string; turnId: string }>(
      HARNESS_SIDECAR_METHODS.runFollowUp,
      {
        runId: held.runId,
        expectedTurnId: held.turnId,
        input: [{ type: "text", text: "steered input" }],
      },
    );
    expect(steered).toEqual({ strategy: "same-turn", runId: held.runId, turnId: held.turnId });
    await waitFor(() => textEvents(connection.events, held.runId).includes("steered input"));
    await waitFor(() => runSettled(connection, held.runId));

    const interaction = await connection.client.request<{ runId: string }>(HARNESS_SIDECAR_METHODS.runStart, {
      request: wireRequest("interaction"),
    });
    await waitFor(() => connection.events.some((event) =>
      event.runId === interaction.runId && event.payload.kind === "interaction-requested"));
    await connection.client.request(HARNESS_SIDECAR_METHODS.runRespond, {
      runId: interaction.runId,
      interactionId: "approval-1",
      response: { text: "approved in words" },
    });
    await waitFor(() => textEvents(connection.events, interaction.runId).includes("approved in words"));
    await waitFor(() => runSettled(connection, interaction.runId));

    const subagent = await connection.client.request<{ runId: string }>(HARNESS_SIDECAR_METHODS.runStart, {
      request: wireRequest("subagent"),
    });
    await waitFor(() => connection.events.some((event) =>
      event.runId === subagent.runId && event.payload.kind === "subagent-started"));
    expect(await connection.client.request(HARNESS_SIDECAR_METHODS.runStopSubagent, {
      runId: subagent.runId,
      taskId: "task-1",
    })).toEqual({ stopped: true });
    await waitFor(() => runSettled(connection, subagent.runId));

    const cancelled = await connection.client.request<{ runId: string }>(HARNESS_SIDECAR_METHODS.runStart, {
      request: wireRequest("cancel"),
    });
    await waitFor(() => textEvents(connection.events, cancelled.runId).includes("partial"));
    await connection.client.request(HARNESS_SIDECAR_METHODS.runCancel, { runId: cancelled.runId });
    await waitFor(() => connection.events.some((event) =>
      event.runId === cancelled.runId
      && event.payload.kind === "turn-completed"
      && event.payload.status === "interrupted"));
    await connection.server.end();
  });

  test("readmits replacement turns when model, effort, permission, and controls change", async () => {
    const observed: HarnessAdapterRunRequest[] = [];
    const connection = connect(observed);
    await initialize(connection);
    const first = await connection.client.request<{ runId: string; turnId: string }>(
      HARNESS_SIDECAR_METHODS.runStart,
      { request: wireRequest("replace", { model: "alpha" }), sessionBinding: "account:a" },
    );
    await waitFor(() => textEvents(connection.events, first.runId).includes("replacing"));

    const replacement = await connection.client.request<{
      strategy: string;
      runId: string;
      turnId: string;
    }>(HARNESS_SIDECAR_METHODS.runFollowUp, {
      runId: first.runId,
      expectedTurnId: first.turnId,
      input: [{ type: "text", text: "after replacement" }],
      replacement: {
        execution: {
          accountId: "account-a",
          model: "beta",
          effort: "high",
          settings: {
            permission: { modeId: "trusted" },
            controls: { speed: "fast" },
          },
        },
      },
    });
    expect(replacement.strategy).toBe("replacement-turn");
    expect(replacement.runId).not.toBe(first.runId);
    await waitFor(() => textEvents(connection.events, replacement.runId).length === 1, "replacement output");
    expect(textEvents(connection.events, replacement.runId)).toEqual(["beta:high:fast:after replacement"]);
    expect(observed[1]).toMatchObject({
      model: "beta",
      effort: "high",
      accountId: "account-a",
      settings: { permission: { modeId: "trusted" }, controls: { speed: "fast" } },
    });
    expect(connection.events).toContainEqual(expect.objectContaining({
      runId: first.runId,
      payload: expect.objectContaining({ kind: "turn-completed", status: "interrupted" }),
    }));
    await connection.server.end();
  });

  test("returns typed protocol and admission failures without leaking raw errors", async () => {
    const connection = connect();
    await expect(connection.client.request(HARNESS_SIDECAR_METHODS.initialize, {
      protocolVersion: 99,
      client: { name: "test" },
    })).rejects.toMatchObject({ code: -32602 });
    await initialize(connection);
    await expect(connection.client.request(HARNESS_SIDECAR_METHODS.runStart, {
      request: wireRequest("hello", { model: "missing" }),
    })).rejects.toMatchObject({
      code: -32010,
      data: { issues: [expect.objectContaining({ code: "unknown-model" })] },
    });
    await expect(connection.client.request(HARNESS_SIDECAR_METHODS.runCancel, {
      runId: "missing",
    })).rejects.toMatchObject({ code: -32004, data: { runId: "missing" } });
    await connection.server.end();
  });
});
