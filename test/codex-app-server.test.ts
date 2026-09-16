import { describe, expect, test } from "bun:test";
import {
  CODEX_SERVICE_TIER_CONTROL_ID,
  codexInitializeParams,
  codexDynamicTools,
  codexModelCatalog,
  codexThreadResumeParams,
  codexThreadStartParams,
  codexTurnStartParams,
  codexTurnSteerParams,
  codexTurnSettingOverrides,
  createCodexAppServerClient,
  openCodexTurn,
} from "../src/adapters/codex-app-server.ts";
import { JsonRpcError } from "../src/transports/json-rpc.ts";

function fixture() {
  const lines: string[] = [];
  const notifications: Array<[string, Record<string, unknown>]> = [];
  const client = createCodexAppServerClient({
    write: (line) => lines.push(line),
    hooks: { notification: (method, params) => notifications.push([method, params]) },
  });
  const message = (at: number) => JSON.parse(lines[at]!) as {
    id?: number;
    method?: string;
    params?: Record<string, unknown>;
    error?: { message: string };
  };
  const answer = (at: number, result: unknown) => {
    client.text(`${JSON.stringify({ jsonrpc: "2.0", id: message(at).id, result })}\n`);
  };
  return { lines, notifications, client, message, answer };
}

describe("Codex App Server client", () => {
  test("serializes explicit host decisions into initialize and thread requests", () => {
    const clientInfo = { name: "test-host", title: "Test Host", version: "1" };
    expect(codexInitializeParams({ clientInfo })).toEqual({
      clientInfo,
      capabilities: {
        experimentalApi: false,
        requestAttestation: false,
        optOutNotificationMethods: null,
      },
    });
    expect(codexThreadStartParams({
      cwd: "/tmp/work",
      sandbox: "read-only",
      approvalPolicy: "never",
      dynamicTools: [],
    })).toEqual({
      cwd: "/tmp/work",
      sandbox: "read-only",
      approvalPolicy: "never",
    });
    expect(codexThreadStartParams({
      cwd: "/tmp/work",
      sandbox: "read-only",
      approvalPolicy: "never",
      model: "gpt-test",
      dynamicTools: [{
        type: "function",
        name: "lookup",
        description: "Look up a record.",
        inputSchema: { type: "object" },
        deferLoading: false,
      }],
    })).toEqual({
      cwd: "/tmp/work",
      sandbox: "read-only",
      approvalPolicy: "never",
      model: "gpt-test",
      dynamicTools: [{
        type: "function",
        name: "lookup",
        description: "Look up a record.",
        inputSchema: { type: "object" },
        deferLoading: false,
      }],
    });
    expect(codexThreadResumeParams({
      threadId: "thread-1",
      excludeTurns: true,
      cwd: "/tmp/work",
      sandbox: "workspace-write",
      approvalPolicy: "on-request",
      dynamicTools: [{
        type: "function",
        name: "must-not-be-sent-on-resume",
        description: "Already persisted on the Codex thread.",
        inputSchema: {},
        deferLoading: false,
      }],
    })).toEqual({
      threadId: "thread-1",
      excludeTurns: true,
      cwd: "/tmp/work",
      sandbox: "workspace-write",
      approvalPolicy: "on-request",
    });
    expect(codexDynamicTools([{
      name: "lookup",
      description: "Look up a record.",
      inputSchema: { type: "object" },
    }])).toEqual([{
      type: "function",
      name: "lookup",
      description: "Look up a record.",
      inputSchema: { type: "object" },
      deferLoading: false,
    }]);
  });

  test("translates generic model controls only while building the Codex turn", () => {
    expect(codexTurnStartParams({
      threadId: "thread-1",
      prompt: "hello",
      effort: "high",
      imageFiles: ["/tmp/reference.png"],
      settings: { controls: { [CODEX_SERVICE_TIER_CONTROL_ID]: "priority" } },
    })).toEqual({
      threadId: "thread-1",
      input: [
        { type: "text", text: "hello", text_elements: [] },
        { type: "localImage", path: "/tmp/reference.png" },
      ],
      effort: "high",
      serviceTierForTurn: "priority",
    });
    expect(codexTurnStartParams({ threadId: "thread-2", prompt: "standard" })).toEqual({
      threadId: "thread-2",
      input: [{ type: "text", text: "standard", text_elements: [] }],
    });
    expect(codexTurnSteerParams({
      threadId: "thread-2",
      expectedTurnId: "turn-2",
      input: [{ type: "text", text: "follow up", text_elements: [] }],
      clientUserMessageId: "message-2",
    })).toEqual({
      threadId: "thread-2",
      expectedTurnId: "turn-2",
      input: [{ type: "text", text: "follow up", text_elements: [] }],
      clientUserMessageId: "message-2",
    });
  });

  test("maps model-specific effort and Fast into generic controls", () => {
    expect(codexModelCatalog({
      data: [{
        id: "gpt-5.4",
        displayName: "GPT-5.4",
        description: "General purpose",
        isDefault: true,
        hidden: false,
        inputModalities: ["text", "image"],
        supportedReasoningEfforts: [
          { reasoningEffort: "medium", description: "Balanced" },
          { reasoningEffort: "xhigh", description: "Deep reasoning" },
        ],
        defaultReasoningEffort: "medium",
        serviceTiers: [{ id: "fast", name: "Fast", description: "Faster responses" }],
        defaultServiceTier: null,
      }],
    })).toEqual({
      defaultModelId: "gpt-5.4",
      models: [{
        id: "gpt-5.4",
        label: "GPT-5.4",
        description: "General purpose",
        inputModalities: ["text", "image"],
        inputPolicy: {
          modalities: {
            text: { support: "stable" },
            image: { support: "stable" },
          },
        },
        effort: {
          options: [
            { id: "medium", label: "Medium", description: "Balanced" },
            { id: "xhigh", label: "Xhigh", description: "Deep reasoning" },
          ],
          defaultOptionId: "medium",
        },
        controls: [{
          id: CODEX_SERVICE_TIER_CONTROL_ID,
          label: "Speed",
          description: "Choose the service tier for this turn.",
          kind: "select",
          scope: "turn",
          options: [
            { id: "default", label: "Standard" },
            { id: "fast", label: "Fast", description: "Faster responses" },
          ],
          defaultValue: "default",
        }],
      }],
    });
    expect(codexTurnSettingOverrides({
      controls: { [CODEX_SERVICE_TIER_CONTROL_ID]: "fast" },
    })).toEqual({ serviceTierForTurn: "fast" });
  });

  test("maps the Codex account cache without leaking its wire shape", () => {
    const catalog = codexModelCatalog({ default_model_id: "gpt-5.6-sol", models: [{
      slug: "gpt-5.6-sol",
      display_name: "GPT-5.6-Sol",
      visibility: "list",
      priority: 1,
      input_modalities: ["text", "image"],
      context_window_tokens: 256000,
      is_legacy: true,
      availability: "unavailable",
      unavailable_reason: "retired",
      supported_reasoning_levels: [{ effort: "high", description: "More reasoning" }],
      default_reasoning_level: "high",
      service_tiers: [{ id: "priority", name: "Fast", description: "2x speed, increased usage" }],
    }] });
    expect(catalog.defaultModelId).toBe("gpt-5.6-sol");
    expect(catalog.models[0]).toMatchObject({
      id: "gpt-5.6-sol",
      label: "GPT-5.6-Sol",
      contextWindowTokens: 256000,
      legacy: true,
      availability: "unavailable",
      unavailableReason: "retired",
      effort: { defaultOptionId: "high", options: [{ id: "high" }] },
      controls: [{
        id: CODEX_SERVICE_TIER_CONTROL_ID,
        options: [{ id: "default", label: "Standard" }, { id: "priority", label: "Fast" }],
      }],
    });
  });

  test("drops context windows that cannot satisfy the public integer schema", () => {
    const catalog = codexModelCatalog({ models: [
      { slug: "fractional", context_window_tokens: 1.5 },
      { slug: "unsafe", context_window_tokens: Number.MAX_SAFE_INTEGER + 1 },
      { slug: "valid", context_window_tokens: 256000 },
    ] });
    expect(catalog.models).toEqual([
      { id: "fractional", label: "fractional" },
      { id: "unsafe", label: "unsafe" },
      { id: "valid", label: "valid", contextWindowTokens: 256000 },
    ]);
  });

  test("opens a new thread and starts its turn in protocol order", async () => {
    const fx = fixture();
    const opening = openCodexTurn({
      client: fx.client,
      initialize: { clientInfo: { name: "test" } },
      thread: { mode: "start", params: { cwd: "/work" } },
      turn: (threadId) => ({ threadId, input: [{ type: "text", text: "hello" }] }),
    });
    await Bun.sleep(0);
    expect(fx.message(0).method).toBe("initialize");
    fx.answer(0, {});
    await Bun.sleep(0);
    expect(fx.message(1).method).toBe("initialized");
    expect(fx.message(2).method).toBe("thread/start");
    fx.answer(2, { thread: { id: "thread-1" } });
    await Bun.sleep(0);
    expect(fx.message(3)).toMatchObject({
      method: "turn/start",
      params: { threadId: "thread-1" },
    });
    fx.answer(3, { turn: { id: "turn-1" } });
    expect(await opening).toBe("thread-1");
  });

  test("sends Codex steering through the explicit turn/steer method", async () => {
    const fx = fixture();
    const steering = fx.client.steerTurn(codexTurnSteerParams({
      threadId: "thread-1",
      expectedTurnId: "turn-1",
      input: [{ type: "text", text: "more", text_elements: [] }],
    }));
    expect(fx.message(0)).toMatchObject({
      method: "turn/steer",
      params: { threadId: "thread-1", expectedTurnId: "turn-1" },
    });
    fx.answer(0, {});
    await steering;
  });

  test("refuses unhandled server requests instead of hanging", async () => {
    const fx = fixture();
    fx.client.text(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "item/commandExecution/requestApproval",
      params: { command: "dangerous" },
    })}\n`);
    await Bun.sleep(0);
    expect(fx.message(0)).toMatchObject({ id: 7, error: { message: "this client answers no request" } });
  });

  test("keeps the method on an app-server failure", async () => {
    const fx = fixture();
    const answer = fx.client.resumeThread({ threadId: "missing" });
    fx.client.text(`${JSON.stringify({
      jsonrpc: "2.0",
      id: fx.message(0).id,
      error: { code: -32000, message: "no rollout" },
    })}\n`);
    await expect(answer).rejects.toThrow(JsonRpcError);
    await expect(answer).rejects.toThrow("thread/resume: no rollout");
  });
});
