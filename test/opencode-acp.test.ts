import { describe, expect, test } from "bun:test";
import {
  OPENCODE_ACP_ADAPTER_ID,
  configureOpenCodeAcpSession,
  createOpenCodeAcpAdapter,
} from "../src/adapters/opencode-acp.ts";
import type {
  AcpV1SessionConfigOption,
  AcpV1SessionController,
} from "../src/adapters/acp-v1.ts";
import { HarnessAdapterError, type HarnessAdapterRunRequest } from "../src/runtime.ts";

function request(model?: string, effort?: string): HarnessAdapterRunRequest {
  return {
    session: { tenantId: "tenant", actorId: "actor", threadId: "thread" },
    adapterId: OPENCODE_ACP_ADAPTER_ID,
    input: [{ type: "text", text: "hello" }],
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    runId: "run",
    turnId: "turn",
    signal: new AbortController().signal,
    tools: {
      list: () => [],
      call: async () => ({ content: [{ type: "text", text: "not found" }], isError: true }),
    },
    context: { sources: [], unavailable: [] },
  };
}

function controller(
  options: readonly AcpV1SessionConfigOption[],
  applied: Array<{ id: string; value: string | boolean }>,
  modes: AcpV1SessionController["modes"] = null,
): AcpV1SessionController {
  return {
    sessionId: "session",
    modes,
    configOptions: options,
    setMode: async () => undefined,
    setConfigOption: async (id, value) => { applied.push({ id, value }); },
  };
}

const MODELS: AcpV1SessionConfigOption = {
  type: "select",
  id: "model",
  name: "Model",
  category: "model",
  currentValue: "anthropic/claude-sonnet-4",
  options: [
    { value: "anthropic/claude-sonnet-4", name: "Claude Sonnet 4" },
    { value: "openai/gpt-5.4", name: "GPT-5.4" },
  ],
};

const EFFORTS: AcpV1SessionConfigOption = {
  type: "select",
  id: "effort",
  name: "Effort",
  category: "thought_level",
  currentValue: "medium",
  options: [
    { value: "medium", name: "Medium" },
    { value: "high", name: "High" },
  ],
};

const MODES: AcpV1SessionConfigOption = {
  type: "select",
  id: "mode",
  name: "Session mode",
  category: "mode",
  currentValue: "build",
  options: [
    { value: "build", name: "Build" },
    { value: "fold", name: "Fold" },
  ],
};

const HOST_PROFILE = {
  status: "available" as const,
  value: {
    id: OPENCODE_ACP_ADAPTER_ID,
    label: "OpenCode in Acme",
    permissions: {
      kind: "host-policy",
      selectable: false,
      defaultModeId: "host",
      modes: [{ id: "host", label: "Managed by Acme", posture: "restricted" }],
    },
  },
};

describe("OpenCode ACP composition", () => {
  test("requires the host's policy profile and delegates lifecycle to generic ACP", async () => {
    const adapter = createOpenCodeAcpAdapter({
      modeId: "fold",
      profile: HOST_PROFILE,
      session: () => ({ cwd: "/tmp/opencode-acp" }),
      connect: () => { throw new Error("not opened by discovery"); },
    });
    expect(adapter.id).toBe("opencode:acp");
    expect(await adapter.profile?.({})).toEqual(HOST_PROFILE);
    expect(await adapter.capabilities()).toMatchObject({
      resume: { support: "stable" },
      steering: { support: "stable", strategies: ["replacement-turn"] },
      shell: { support: "unsupported" },
    });
  });

  test("applies exact model, effort, and fixed mode selections in order", async () => {
    const applied: Array<{ id: string; value: string | boolean }> = [];
    await configureOpenCodeAcpSession(
      controller([MODELS, EFFORTS, MODES], applied),
      request("openai/gpt-5.4", "high"),
      { modeId: "fold" },
    );
    expect(applied).toEqual([
      { id: "model", value: "openai/gpt-5.4" },
      { id: "effort", value: "high" },
      { id: "mode", value: "fold" },
    ]);

    const unchanged: Array<{ id: string; value: string | boolean }> = [];
    await configureOpenCodeAcpSession(
      controller([{ ...MODELS }, { ...EFFORTS }, { ...MODES, currentValue: "fold" }], unchanged),
      request("anthropic/claude-sonnet-4", "medium"),
      { modeId: "fold" },
    );
    expect(unchanged).toEqual([]);
  });

  test("fails closed when a selected control or value is unavailable", async () => {
    for (const [options, selected, code] of [
      [[MODELS, EFFORTS, MODES], request("vendor/missing"), "OPENCODE_MODEL_UNAVAILABLE"],
      [[MODES], request("openai/gpt-5.4"), "OPENCODE_MODEL_CONTROL_UNAVAILABLE"],
      [[MODELS, MODES], request(undefined, "high"), "OPENCODE_EFFORT_CONTROL_UNAVAILABLE"],
      [[MODELS, EFFORTS, MODES], request(undefined, "maximum"), "OPENCODE_EFFORT_UNAVAILABLE"],
      [[MODELS, EFFORTS], request(), "OPENCODE_MODE_CONTROL_UNAVAILABLE"],
    ] as const) {
      try {
        await configureOpenCodeAcpSession(controller(options, []), selected, { modeId: "fold" });
        throw new Error("expected selection to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(HarnessAdapterError);
        expect((error as HarnessAdapterError).code).toBe(code);
      }
    }
  });

  test("uses the ACP mode method for OpenCode versions that expose legacy modes", async () => {
    const selected: string[] = [];
    const value: AcpV1SessionController = {
      ...controller([], [], {
        currentModeId: "build",
        availableModes: [{ id: "build", name: "Build" }, { id: "fold", name: "Fold" }],
      }),
      setMode: async (id) => { selected.push(id); },
    };
    await configureOpenCodeAcpSession(value, request(), { modeId: "fold" });
    expect(selected).toEqual(["fold"]);
  });
});
