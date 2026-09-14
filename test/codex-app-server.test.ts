import { describe, expect, test } from "bun:test";
import {
  CODEX_SERVICE_TIER_CONTROL_ID,
  codexModelCatalog,
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
