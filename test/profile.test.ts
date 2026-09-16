import { describe, expect, test } from "bun:test";
import {
  harnessControls,
  harnessDiscoveryFreshness,
  harnessInputPolicy,
  resolveHarnessEffort,
  resolveHarnessConfiguration,
  type HarnessEngineProfile,
  type HarnessModel,
} from "../src/profile.ts";

const profile: HarnessEngineProfile = {
  id: "openai:codex",
  label: "Codex",
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
          version: "shell-grant-2",
          title: "Open the workspace",
          description: "This mode exposes a shell and workspace writes.",
        },
      },
    ],
  },
  controls: [{
    id: "openai:verbosity",
    label: "Verbosity",
    kind: "select",
    scope: "session",
    options: [{ id: "low", label: "Low" }, { id: "high", label: "High" }],
    defaultValue: "low",
  }],
};

const model: HarnessModel = {
  id: "gpt-5.4",
  label: "GPT-5.4",
  controls: [{
    id: "openai:service-tier",
    label: "Speed",
    kind: "select",
    scope: "turn",
    options: [
      { id: "default", label: "Standard" },
      { id: "fast", label: "Fast", description: "Use the model's faster service tier." },
    ],
    defaultValue: "default",
  }],
};

describe("engine profiles", () => {
  test("classifies discovery freshness from an expiry timestamp", () => {
    const available = { status: "available" as const, value: {}, fetchedAt: "2026-01-01T00:00:00Z", expiresAt: "2026-01-02T00:00:00Z" };
    expect(harnessDiscoveryFreshness(available, "2026-01-01T12:00:00Z")).toBe("fresh");
    expect(harnessDiscoveryFreshness(available, "2026-01-02T00:00:00Z")).toBe("stale");
    expect(harnessDiscoveryFreshness({ status: "available", value: {} })).toBe("unknown");
    expect(harnessDiscoveryFreshness({ status: "unavailable", message: "offline" })).toBe("unknown");
  });

  test("resolves open effort ids without inventing provider values", () => {
    const withEffort: HarnessModel = {
      id: "model", label: "Model", effort: {
        defaultOptionId: "medium",
        options: [{ id: "low", label: "Low" }, { id: "medium", label: "Medium" }, { id: "high", label: "High", unavailableReason: "not enabled" }],
      },
    };
    expect(resolveHarnessEffort(withEffort)).toEqual({ effort: "medium", issues: [] });
    expect(resolveHarnessEffort(withEffort, "low")).toEqual({ effort: "low", issues: [] });
    expect(resolveHarnessEffort(withEffort, "x-provider-effort")).toEqual({
      effort: "medium",
      issues: [{ code: "unknown-effort", message: "The selected effort is not available for this model." }],
    });
    expect(resolveHarnessEffort(undefined, "x-provider-effort").issues).toHaveLength(1);
  });

  test("merges engine and model-specific controls", () => {
    expect(harnessControls(profile, model).map(({ id }) => id)).toEqual([
      "openai:verbosity",
      "openai:service-tier",
    ]);
  });

  test("merges model input limits over engine defaults without inventing support", () => {
    expect(harnessInputPolicy({
      ...profile,
      inputPolicy: {
        maxItems: 8,
        modalities: {
          text: { support: "stable", maxTextCharacters: 10_000 },
          image: { support: "experimental", maxCount: 4, mediaTypes: ["image/png"] },
        },
      },
    }, {
      ...model,
      inputPolicy: {
        modalities: {
          image: { support: "stable", maxItemBytes: 2_000_000 },
        },
      },
    })).toEqual({
      maxItems: 8,
      modalities: {
        text: { support: "stable", maxTextCharacters: 10_000 },
        image: {
          support: "stable",
          maxCount: 4,
          maxItemBytes: 2_000_000,
          mediaTypes: ["image/png"],
        },
      },
    });
    expect(harnessInputPolicy(profile, model)).toBeUndefined();
  });

  test("keeps an acknowledged elevated permission and arbitrary adapter controls", () => {
    expect(resolveHarnessConfiguration(profile, {
      permission: { modeId: "workspace-write", consentVersion: "shell-grant-2" },
      controls: { "openai:verbosity": "high", "openai:service-tier": "fast" },
    }, model)).toEqual({
      permission: { modeId: "workspace-write", consentVersion: "shell-grant-2" },
      controls: { "openai:verbosity": "high", "openai:service-tier": "fast" },
      issues: [],
    });
  });

  test("falls back after a permission grant changes", () => {
    expect(resolveHarnessConfiguration(profile, {
      permission: { modeId: "workspace-write", consentVersion: "shell-grant-1" },
    }, model)).toMatchObject({
      permission: { modeId: "read-only" },
      issues: [{ code: "stale-consent", path: "permission.consentVersion" }],
    });
  });

  test("drops unknown controls and resets values no longer offered by a model", () => {
    expect(resolveHarnessConfiguration(profile, {
      controls: { "openai:verbosity": "medium", "openai:service-tier": "turbo", "x:new": true },
    }, model)).toEqual({
      permission: { modeId: "read-only" },
      controls: { "openai:verbosity": "low", "openai:service-tier": "default" },
      issues: [
        {
          path: "controls.openai:verbosity",
          code: "invalid-value",
          message: "The value for Verbosity is no longer available.",
        },
        {
          path: "controls.openai:service-tier",
          code: "invalid-value",
          message: "The value for Speed is no longer available.",
        },
        {
          path: "controls.x:new",
          code: "unknown-control",
          message: "The submitted engine control is not available.",
        },
      ],
    });
  });

  test("requires a safe permission default", () => {
    expect(() => resolveHarnessConfiguration({
      ...profile,
      permissions: { ...profile.permissions, defaultModeId: "missing" },
    })).toThrow("defaultModeId");
    expect(() => resolveHarnessConfiguration({
      ...profile,
      permissions: { ...profile.permissions, defaultModeId: "workspace-write" },
    })).toThrow("cannot require consent");
  });

  test("never admits unavailable permission modes or controls", () => {
    expect(resolveHarnessConfiguration({
      ...profile,
      permissions: {
        ...profile.permissions,
        modes: profile.permissions.modes.map((mode) => mode.id === "workspace-write"
          ? { ...mode, unavailableReason: "disabled by policy" }
          : mode),
      },
    }, {
      permission: { modeId: "workspace-write", consentVersion: "shell-grant-2" },
    })).toMatchObject({
      permission: { modeId: "read-only" },
      issues: [{ code: "unknown-permission", path: "permission.modeId" }],
    });

    expect(resolveHarnessConfiguration({
      ...profile,
      controls: profile.controls?.map((control) => ({
        ...control,
        unavailableReason: "not enabled for this account",
      })),
    }, { controls: { "openai:verbosity": "high" } })).toEqual({
      permission: { modeId: "read-only" },
      controls: {},
      issues: [{
        code: "invalid-value",
        path: "controls.openai:verbosity",
        message: "The value for Verbosity is no longer available.",
      }],
    });
  });

  test("refuses malformed control defaults instead of admitting provider-invalid values", () => {
    expect(() => resolveHarnessConfiguration({
      ...profile,
      controls: profile.controls?.map((control) => ({ ...control, defaultValue: "missing" })),
    })).toThrow("defaultValue");
  });
});
