import { describe, expect, test } from "bun:test";
import {
  discoverHarnessAdmission,
  resolveHarnessAdmission,
  type HarnessAdmissionDiscoverySource,
} from "../src/admission.ts";
import { createClaudeAgentSdkAdapter } from "../src/adapters/claude-agent-sdk-adapter.ts";
import { createCodexAppServerAdapter } from "../src/adapters/codex-app-server-adapter.ts";
import type { HarnessRunRequest } from "../src/protocol.ts";
import type {
  HarnessEngineProfile,
  HarnessModelCatalog,
} from "../src/profile.ts";
import { createHarness } from "../src/runtime.ts";
import { createMemoryPersistence } from "../src/stores.ts";

const CODEX_ID = "openai:codex";
const CLAUDE_ID = "anthropic:claude-code";

const codexProfile: HarnessEngineProfile = {
  id: CODEX_ID,
  label: "Codex",
  modelSelection: "optional",
  permissions: {
    kind: "sandbox",
    selectable: true,
    defaultModeId: "read-only",
    modes: [
      { id: "read-only", label: "Read only", posture: "restricted" },
      {
        id: "workspace-write",
        label: "Workspace write",
        posture: "elevated",
        consent: {
          version: "codex-shell-2",
          title: "Open the sandbox",
          description: "This mode exposes a shell.",
        },
      },
    ],
  },
  inputPolicy: {
    maxItems: 4,
    modalities: {
      text: { support: "stable", maxTextCharacters: 1_000 },
      image: { support: "stable", maxCount: 2 },
    },
  },
};

const codexModels: HarnessModelCatalog = {
  selection: "optional",
  defaultModelId: "gpt-main",
  models: [
    {
      id: "gpt-main",
      label: "GPT Main",
      effort: {
        defaultOptionId: "medium",
        options: [
          { id: "low", label: "Low" },
          { id: "medium", label: "Medium" },
        ],
      },
      controls: [{
        id: "openai:service-tier",
        label: "Speed",
        kind: "select",
        scope: "turn",
        options: [
          { id: "default", label: "Standard" },
          { id: "priority", label: "Fast" },
        ],
        defaultValue: "default",
      }],
      inputPolicy: {
        modalities: { image: { support: "stable", maxItemBytes: 2_000_000 } },
      },
    },
    { id: "gpt-hidden", label: "Old GPT", hidden: true },
    { id: "gpt-legacy", label: "Legacy GPT", legacy: true },
    { id: "gpt-disabled", label: "Disabled GPT", availability: "unavailable" },
  ],
};

const claudeProfile: HarnessEngineProfile = {
  id: CLAUDE_ID,
  label: "Claude Code",
  modelSelection: "optional",
  permissions: {
    kind: "approval-policy",
    selectable: true,
    defaultModeId: "default",
    modes: [
      { id: "default", label: "Ask", posture: "standard" },
      { id: "auto", label: "Automatic", posture: "elevated" },
    ],
  },
  inputPolicy: { modalities: { text: { support: "stable" } } },
};

function request(
  adapterId = CODEX_ID,
  patch: Partial<HarnessRunRequest> = {},
): HarnessRunRequest {
  return {
    session: { tenantId: "tenant", actorId: "actor", threadId: "thread" },
    adapterId,
    input: [{ type: "text", text: "Help" }],
    ...patch,
  };
}

describe("discovery-driven admission", () => {
  test("normalizes Codex defaults and Fast into an exact runtime admission", () => {
    const result = resolveHarnessAdmission({
      request: request(CODEX_ID, {
        accountId: "account-a",
        settings: { controls: { "openai:service-tier": "priority" } },
      }),
      discovery: {
        profile: { status: "available", value: codexProfile },
        models: { status: "available", value: codexModels },
      },
      sessionBinding: "account:a|policy:2",
    });

    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.request).toMatchObject({
      adapterId: CODEX_ID,
      accountId: "account-a",
      model: "gpt-main",
      effort: "medium",
      settings: {
        permission: { modeId: "read-only" },
        controls: { "openai:service-tier": "priority" },
      },
    });
    expect(result.admission).toEqual({
      adapterId: CODEX_ID,
      accountId: "account-a",
      model: "gpt-main",
      effort: "medium",
      settings: {
        permission: { modeId: "read-only" },
        controls: { "openai:service-tier": "priority" },
      },
      inputPolicy: {
        maxItems: 4,
        modalities: {
          text: { support: "stable", maxTextCharacters: 1_000 },
          image: { support: "stable", maxCount: 2, maxItemBytes: 2_000_000 },
        },
      },
      sessionBinding: "account:a|policy:2",
    });
  });

  test("uses the same path for Claude without inventing provider-specific controls", () => {
    const result = resolveHarnessAdmission({
      request: request(CLAUDE_ID, { settings: { permission: { modeId: "auto" } } }),
      discovery: {
        profile: { status: "available", value: claudeProfile },
        models: { status: "available", value: { selection: "optional", models: [] } },
      },
    });

    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.request.settings).toEqual({ permission: { modeId: "auto" }, controls: {} });
    expect(result.admission).toMatchObject({
      adapterId: CLAUDE_ID,
      accountId: null,
      model: null,
      effort: null,
      settings: { permission: { modeId: "auto" }, controls: {} },
    });
  });

  test("accepts explicit hidden and legacy models but never chooses either as a default", () => {
    const explicit = resolveHarnessAdmission({
      request: request(CODEX_ID, { model: "gpt-hidden" }),
      discovery: {
        profile: { status: "available", value: codexProfile },
        models: { status: "available", value: codexModels },
      },
    });
    expect(explicit.valid).toBe(true);
    if (explicit.valid) expect(explicit.admission.model).toBe("gpt-hidden");

    const hiddenDefault = resolveHarnessAdmission({
      request: request(),
      discovery: {
        profile: { status: "available", value: codexProfile },
        models: {
          status: "available",
          value: { ...codexModels, defaultModelId: "gpt-hidden" },
        },
      },
    });
    expect(hiddenDefault).toMatchObject({
      valid: false,
      issues: [{ code: "invalid-model-catalog", path: "discovery.models.defaultModelId" }],
    });

    const explicitLegacy = resolveHarnessAdmission({
      request: request(CODEX_ID, { model: "gpt-legacy" }),
      discovery: {
        profile: { status: "available", value: codexProfile },
        models: { status: "available", value: codexModels },
      },
    });
    expect(explicitLegacy.valid).toBe(true);
    if (explicitLegacy.valid) expect(explicitLegacy.admission.model).toBe("gpt-legacy");

    const legacyDefault = resolveHarnessAdmission({
      request: request(),
      discovery: {
        profile: { status: "available", value: codexProfile },
        models: {
          status: "available",
          value: { ...codexModels, defaultModelId: "gpt-legacy" },
        },
      },
    });
    expect(legacyDefault).toMatchObject({
      valid: false,
      issues: [{ code: "invalid-model-catalog", path: "discovery.models.defaultModelId" }],
    });
  });

  test("refuses missing, unknown, and unavailable required models", () => {
    const requiredProfile = { ...codexProfile, modelSelection: "required" as const };
    const catalog = { ...codexModels, defaultModelId: undefined, selection: "required" as const };
    expect(resolveHarnessAdmission({
      request: request(),
      discovery: {
        profile: { status: "available", value: requiredProfile },
        models: { status: "available", value: catalog },
      },
    })).toMatchObject({ valid: false, issues: [{ code: "model-required" }] });
    expect(resolveHarnessAdmission({
      request: request(CODEX_ID, { model: "missing" }),
      discovery: {
        profile: { status: "available", value: codexProfile },
        models: { status: "available", value: codexModels },
      },
    })).toMatchObject({ valid: false, issues: [{ code: "unknown-model" }] });
    expect(resolveHarnessAdmission({
      request: request(CODEX_ID, { model: "gpt-disabled" }),
      discovery: {
        profile: { status: "available", value: codexProfile },
        models: { status: "available", value: codexModels },
      },
    })).toMatchObject({ valid: false, issues: [{ code: "unavailable-model" }] });
  });

  test("fails closed on stale effort, consent, controls, and input", () => {
    const staleEffort = resolveHarnessAdmission({
      request: request(CODEX_ID, { model: "gpt-main", effort: "ultra" }),
      discovery: {
        profile: { status: "available", value: codexProfile },
        models: { status: "available", value: codexModels },
      },
    });
    expect(staleEffort).toMatchObject({ valid: false, issues: [{ code: "unknown-effort" }] });

    const staleConsent = resolveHarnessAdmission({
      request: request(CODEX_ID, {
        model: "gpt-main",
        settings: { permission: { modeId: "workspace-write", consentVersion: "codex-shell-1" } },
      }),
      discovery: {
        profile: { status: "available", value: codexProfile },
        models: { status: "available", value: codexModels },
      },
    });
    expect(staleConsent).toMatchObject({ valid: false, issues: [{ code: "stale-consent" }] });

    const staleControl = resolveHarnessAdmission({
      request: request(CODEX_ID, {
        model: "gpt-main",
        settings: { controls: { "openai:service-tier": "turbo" } },
      }),
      discovery: {
        profile: { status: "available", value: codexProfile },
        models: { status: "available", value: codexModels },
      },
    });
    expect(staleControl).toMatchObject({ valid: false, issues: [{ code: "invalid-value" }] });

    const oversized = resolveHarnessAdmission({
      request: request(CODEX_ID, { input: [{ type: "text", text: "x".repeat(1_001) }] }),
      discovery: {
        profile: { status: "available", value: codexProfile },
        models: { status: "available", value: codexModels },
      },
    });
    expect(oversized).toMatchObject({ valid: false, issues: [{ code: "text-length-exceeded" }] });
  });

  test("allows an optional provider default when model discovery is unsupported", () => {
    const result = resolveHarnessAdmission({
      request: request(CLAUDE_ID),
      discovery: {
        profile: { status: "available", value: claudeProfile },
        models: { status: "unsupported" },
      },
    });
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.admission.model).toBeNull();
  });

  test("scopes concurrent discovery to account and model, then returns one runnable pair", async () => {
    const calls: Array<{ kind: string; request: unknown }> = [];
    const source: HarnessAdmissionDiscoverySource = {
      async profile(_adapterId, discoveryRequest) {
        calls.push({ kind: "profile", request: discoveryRequest });
        return { status: "available", value: codexProfile };
      },
      async models(_adapterId, discoveryRequest) {
        calls.push({ kind: "models", request: discoveryRequest });
        return { status: "available", value: codexModels };
      },
    };
    const result = await discoverHarnessAdmission(source, request(CODEX_ID, {
      accountId: "account-a",
      model: "gpt-main",
      effort: "low",
      settings: { controls: { "openai:service-tier": "priority" } },
    }), { sessionBinding: "binding-a" });

    expect(calls).toEqual([
      { kind: "profile", request: { accountId: "account-a", modelId: "gpt-main" } },
      { kind: "models", request: { accountId: "account-a", modelId: "gpt-main" } },
    ]);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.admission.sessionBinding).toBe("binding-a");
  });

  test("turns thrown discovery failures into safe issues and never leaks the error", async () => {
    const result = await discoverHarnessAdmission({
      profile() { throw new Error("raw-secret-provider-message"); },
      models() { throw new Error("another-raw-secret"); },
    }, request());
    expect(result).toMatchObject({ valid: false, issues: [{ code: "profile-unavailable" }] });
    expect(JSON.stringify(result)).not.toContain("raw-secret");
  });

  test("admits the native Codex and Claude adapters without opening provider connections", async () => {
    let connections = 0;
    const codex = createCodexAppServerAdapter({
      id: CODEX_ID,
      clientInfo: { name: "admission-test", version: "1" },
      profile: { status: "available", value: codexProfile },
      models: { status: "available", value: codexModels },
      thread: () => ({ cwd: "/work", sandbox: "read-only", approvalPolicy: "never" }),
      connect: () => {
        connections += 1;
        throw new Error("discovery must not connect");
      },
    });
    const claude = createClaudeAgentSdkAdapter({
      id: CLAUDE_ID,
      profile: { status: "available", value: claudeProfile },
      models: { status: "available", value: { selection: "optional", models: [] } },
      connect: () => {
        connections += 1;
        throw new Error("discovery must not connect");
      },
    });
    const runtime = createHarness({
      adapters: [codex, claude],
      persistence: createMemoryPersistence(),
    });

    const [codexAdmission, claudeAdmission] = await Promise.all([
      discoverHarnessAdmission(runtime, request(CODEX_ID, {
        accountId: "codex-account",
        settings: { controls: { "openai:service-tier": "priority" } },
      })),
      discoverHarnessAdmission(runtime, request(CLAUDE_ID, {
        accountId: "claude-account",
        settings: { permission: { modeId: "auto" } },
      })),
    ]);

    expect(codexAdmission).toMatchObject({
      valid: true,
      admission: {
        adapterId: CODEX_ID,
        accountId: "codex-account",
        model: "gpt-main",
        settings: { controls: { "openai:service-tier": "priority" } },
      },
    });
    expect(claudeAdmission).toMatchObject({
      valid: true,
      admission: {
        adapterId: CLAUDE_ID,
        accountId: "claude-account",
        model: null,
        settings: { permission: { modeId: "auto" } },
      },
    });
    expect(connections).toBe(0);
    await runtime.close();
  });

  test("rejects malformed envelope values before discovery can authorize them", async () => {
    expect(resolveHarnessAdmission({
      request: request(" ", { accountId: "" }),
      discovery: { profile: { status: "available", value: codexProfile } },
      sessionBinding: " ",
    })).toMatchObject({
      valid: false,
      issues: [
        { code: "invalid-adapter" },
        { code: "invalid-account" },
        { code: "invalid-session-binding" },
      ],
    });

    let discoveryCalls = 0;
    const discovered = await discoverHarnessAdmission({
      profile() {
        discoveryCalls += 1;
        return { status: "available", value: codexProfile };
      },
      models() {
        discoveryCalls += 1;
        return { status: "available", value: codexModels };
      },
    }, request(" ", { accountId: "" }), { sessionBinding: " " });
    expect(discovered).toMatchObject({
      valid: false,
      issues: [
        { code: "invalid-adapter" },
        { code: "invalid-account" },
        { code: "invalid-session-binding" },
      ],
    });
    expect(discoveryCalls).toBe(0);
  });
});
