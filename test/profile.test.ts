import { describe, expect, test } from "bun:test";
import {
  harnessControls,
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
  test("merges engine and model-specific controls", () => {
    expect(harnessControls(profile, model).map(({ id }) => id)).toEqual([
      "openai:verbosity",
      "openai:service-tier",
    ]);
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
});

