/**
 * Credential-bearing native provider smoke test. It is never run by `check`.
 * Set FOLD_HARNESS_LIVE=1 to confirm that the test may use a local account.
 */

import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  CODEX_SERVICE_TIER_CONTROL_ID,
  createClaudeAgentSdkAdapter,
  createClaudeAgentSdkConnector,
  createClaudeAgentSdkDiscovery,
  createCodexAppServerAdapter,
  createCodexAppServerDiscovery,
  createCodexAppServerProcessConnector,
  createHarness,
  createMemoryPersistence,
  createToolHost,
  type HarnessAdapter,
  type HarnessDiscovery,
  type HarnessEngineProfile,
  type HarnessEvent,
  type HarnessLimitSnapshot,
  type HarnessRun,
  type HarnessRunRequest,
  type HarnessRuntime,
} from "../src/index.js";

type Provider = "claude" | "codex";

const LIVE_TIMEOUT_MS = 90_000;
const unsupported = { support: "unsupported" as const };
const session = { tenantId: "live", actorId: "smoke", threadId: "native-session" } as const;
let lastEventKinds: string[] = [];
let lastErrorCode: string | undefined;
let lastTurnStatus: string | undefined;
let lastAssistantText: string | undefined;

class SmokeFailure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function selectedProvider(): Provider {
  const value = argument("--provider");
  if (value === "claude" || value === "codex") return value;
  throw new Error("Usage: bun run smoke:native -- --provider claude|codex");
}

function requireOptIn(): void {
  if (process.env.FOLD_HARNESS_LIVE !== "1") {
    throw new Error("Set FOLD_HARNESS_LIVE=1 to allow local provider account use.");
  }
}

function safeEnvironment(): Record<string, string> {
  const names = [
    "PATH",
    "USER",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "TERM",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "NO_PROXY",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
    "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
  ];
  return Object.fromEntries(names.flatMap((name) => {
    const value = process.env[name];
    return value === undefined ? [] : [[name, value]];
  }));
}

function profile(provider: Provider): HarnessDiscovery<HarnessEngineProfile> {
  return {
    status: "available",
    value: {
      id: `native-live:${provider}`,
      label: provider === "claude" ? "Claude Code" : "Codex",
      modelSelection: "optional",
      permissions: {
        kind: provider === "claude" ? "permission-mode" : "approval-policy",
        selectable: false,
        defaultModeId: provider === "claude" ? "default" : "never",
        modes: [{
          id: provider === "claude" ? "default" : "never",
          label: provider === "claude" ? "Ask" : "Host policy",
          posture: "restricted",
        }],
      },
      inputPolicy: { modalities: { text: { support: "stable" } } },
      ...(provider === "codex" ? {
        controls: [{
          id: CODEX_SERVICE_TIER_CONTROL_ID,
          label: "Speed",
          kind: "select" as const,
          scope: "turn" as const,
          options: [
            { id: "default", label: "Standard" },
            { id: "priority", label: "Fast" },
          ],
          defaultValue: "default",
        }],
      } : {}),
    },
  };
}

function selectedModel(provider: Provider): string | undefined {
  return process.env.FOLD_HARNESS_LIVE_MODEL ?? (provider === "claude" ? "sonnet" : undefined);
}

function text(events: readonly HarnessEvent[]): string {
  return events.flatMap((event) => event.payload.kind === "assistant-text" ? [event.payload.text] : []).join("");
}

function has(events: readonly HarnessEvent[], kind: HarnessEvent["payload"]["kind"]): boolean {
  return events.some((event) => event.payload.kind === kind);
}

async function bounded<T>(work: Promise<T>, stage: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new SmokeFailure(`${stage.toUpperCase()}_TIMEOUT`)), LIVE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function collect(
  run: HarnessRun,
  options: { respond?: boolean; steerAfterTool?: boolean } = {},
): Promise<HarnessEvent[]> {
  const events: HarnessEvent[] = [];
  let steered = false;
  for await (const event of run.events) {
    events.push(event);
    if (options.respond && event.payload.kind === "interaction-requested") {
      await run.respond(event.payload.interaction.id, {
        choiceId: "allow",
        labels: ["allow"],
        text: "allow",
      });
    }
    if (options.steerAfterTool && !steered && event.payload.kind === "tool-started") {
      steered = true;
      const result = await run.followUp({
        expectedTurnId: run.turnId,
        input: [{ type: "text", text: "The note is ready. Reply with NATIVE_STEER_OK." }],
      }, { strategy: "same-turn" });
      if (result.strategy !== "same-turn") throw new SmokeFailure("STEERING_STRATEGY_CHANGED");
    }
  }
  return events;
}

async function completedTurn(
  runtime: HarnessRuntime,
  request: HarnessRunRequest,
  options: { respond?: boolean; steerAfterTool?: boolean } = {},
): Promise<HarnessEvent[]> {
  const run = runtime.start(request);
  const events = await bounded(collect(run, options), "turn");
  const status = await run.done;
  lastEventKinds = events.map((event) => event.payload.kind);
  lastErrorCode = events.find((event) => event.payload.kind === "error")?.payload.code;
  lastTurnStatus = status;
  lastAssistantText = text(events).slice(0, 500);
  if (status !== "completed") throw new SmokeFailure("TURN_NOT_COMPLETED");
  return events;
}

function limitSummary(discovery: HarnessDiscovery<HarnessLimitSnapshot> | undefined): unknown {
  if (discovery?.status !== "available") return discovery ?? null;
  return {
    fetchedAt: discovery.fetchedAt,
    planLabel: discovery.value.planLabel,
    limits: discovery.value.limits.map((limit) => ({
      id: limit.id,
      label: limit.label,
      usedPercent: limit.usedPercent,
      remaining: limit.remaining,
      resetsAt: limit.resetsAt,
    })),
  };
}

interface LiveAdapterState {
  stderrBytes: number;
  checkpoints: number;
  interactions: number;
  limitSnapshots: number;
}

interface AdapterSetup {
  adapter: HarnessAdapter;
  cleanup(): Promise<void>;
}

async function claudeAdapter(workspace: string, state: LiveAdapterState): Promise<AdapterSetup> {
  const configDirectory = process.env.FOLD_HARNESS_LIVE_CLAUDE_CONFIG_DIR;
  const environment = {
    ...safeEnvironment(),
    HOME: homedir(),
    ...(configDirectory ? { CLAUDE_CONFIG_DIR: configDirectory } : {}),
    NO_COLOR: "1",
  };
  const discovery = createClaudeAgentSdkDiscovery({
    configure: () => ({ cwd: workspace, env: environment }),
  });
  const adapter = createClaudeAgentSdkAdapter({
    id: "native-live:claude",
    profile: profile("claude"),
    models: discovery.models,
    limits: discovery.limits,
    authorizeTool(request) {
      if (state.interactions > 0) return { behavior: "allow", updatedInput: request.input };
      state.interactions += 1;
      return {
        behavior: "ask",
        interaction: {
          id: `native-live-permission-${state.interactions}`,
          kind: "permission",
          title: "Allow the live smoke tool?",
          choices: [{ id: "allow", label: "Allow" }],
          acceptsText: false,
        },
        resolve(response) {
          return response.choiceId === "allow"
            ? { behavior: "allow", updatedInput: request.input }
            : { behavior: "deny", message: "The live smoke denied the tool." };
        },
      };
    },
    onCheckpoint() { state.checkpoints += 1; },
    onLimits() { state.limitSnapshots += 1; },
    connect: createClaudeAgentSdkConnector({
      onStderr(chunk) { state.stderrBytes += Buffer.byteLength(chunk); },
      configure: () => ({
        cwd: workspace,
        env: environment,
        tools: [],
        skills: [],
        settingSources: [],
        strictMcpConfig: true,
        permissionMode: "default",
        systemPrompt: "Follow the user's smoke-test instructions. Use only the supplied application tools.",
        persistSession: true,
        maxTurns: 12,
      }),
    }),
  });
  return { adapter, async cleanup() {} };
}

async function codexAdapter(root: string, workspace: string, state: LiveAdapterState): Promise<AdapterSetup> {
  const command = process.env.FOLD_HARNESS_LIVE_CODEX_COMMAND
    ?? execFileSync("which", ["codex"], { encoding: "utf8" }).trim();
  const sourceHome = process.env.FOLD_HARNESS_LIVE_CODEX_HOME ?? join(homedir(), ".codex");
  const privateHome = join(root, "codex-home");
  await mkdir(privateHome, { recursive: true, mode: 0o700 });
  if (!process.env.CODEX_API_KEY && !process.env.OPENAI_API_KEY) {
    await copyFile(join(sourceHome, "auth.json"), join(privateHome, "auth.json"));
  }
  const connector = createCodexAppServerProcessConnector({
    command,
    args: [
      "app-server",
      "--stdio",
      "--strict-config",
      "--disable", "shell_tool",
      "--disable", "unified_exec",
      "--disable", "shell_snapshot",
      "-c", "skills.include_instructions=false",
      "-c", "skills.bundled.enabled=false",
      "-c", "cli_auth_credentials_store=\"file\"",
    ],
    cwd: workspace,
    env: {
      ...safeEnvironment(),
      HOME: privateHome,
      CODEX_HOME: privateHome,
      NO_COLOR: "1",
    },
    onStderr(chunk) { state.stderrBytes += chunk.byteLength; },
  });
  const clientInfo = { name: "fold-harness-live-smoke", title: "Fold Harness live smoke", version: "1" };
  const discovery = createCodexAppServerDiscovery({ clientInfo, connect: connector });
  const adapter = createCodexAppServerAdapter({
    id: "native-live:codex",
    clientInfo,
    profile: profile("codex"),
    models: discovery.models,
    limits: discovery.limits,
    thread: (request) => ({
      cwd: workspace,
      sandbox: "read-only",
      approvalPolicy: "never",
      ...(request.model ? { model: request.model } : {}),
    }),
    connect: connector,
    onCheckpoint() { state.checkpoints += 1; },
    onLimits() { state.limitSnapshots += 1; },
  });
  return { adapter, async cleanup() {} };
}

const provider = selectedProvider();
requireOptIn();
const smokeRoot = await mkdtemp(join(tmpdir(), `fold-harness-native-${provider}-`));
const workspace = join(smokeRoot, "workspace");
await mkdir(workspace, { mode: 0o700 });
const state: LiveAdapterState = {
  stderrBytes: 0,
  checkpoints: 0,
  interactions: 0,
  limitSnapshots: 0,
};
let blockStartedResolve!: () => void;
const blockStarted = new Promise<void>((resolve) => { blockStartedResolve = resolve; });
const tools = createToolHost([
  {
    name: "smoke_echo",
    description: "Return the exact value. Use this tool when the user asks for the live smoke marker.",
    inputSchema: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    },
    validate(input) {
      const value = typeof input === "object" && input !== null
        ? (input as { value?: unknown }).value
        : undefined;
      if (typeof value !== "string") throw new Error("value is required");
      return { value };
    },
    execute: async ({ value }) => ({ content: [{ type: "text" as const, text: value }] }),
  },
  {
    name: "smoke_pause",
    description: "Mark a steering boundary and return immediately.",
    inputSchema: { type: "object", additionalProperties: false },
    execute: async () => ({
      content: [{ type: "text" as const, text: "Wait for the user's next message before you answer." }],
    }),
  },
  {
    name: "smoke_block",
    description: "Wait until the host cancels this turn.",
    inputSchema: { type: "object", additionalProperties: false },
    async execute(_input, context) {
      blockStartedResolve();
      await new Promise<void>((resolve) => {
        if (context.signal.aborted) resolve();
        else context.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return { content: [{ type: "text", text: "cancelled" }], isError: true, code: "CANCELLED" };
    },
  },
]);

let stage = "setup";
let runtime: HarnessRuntime | undefined;
let setup: AdapterSetup | undefined;
const persistence = createMemoryPersistence();
const makeAdapter = () => provider === "claude"
  ? claudeAdapter(workspace, state)
  : codexAdapter(smokeRoot, workspace, state);

try {
  setup = await makeAdapter();
  stage = "discovery";
  const capabilities = await setup.adapter.capabilities();
  const discoveredProfile = await setup.adapter.profile?.({});
  const discoveredModels = await setup.adapter.models?.({});
  const discoveredLimits = await setup.adapter.limits?.({});
  if (capabilities.resume.support === "unsupported") throw new SmokeFailure("RESUME_NOT_DISCOVERED");
  if (capabilities.tools.support === "unsupported") throw new SmokeFailure("TOOLS_NOT_DISCOVERED");
  if (capabilities.steering?.strategies.includes("same-turn") !== true) {
    throw new SmokeFailure("STEERING_NOT_DISCOVERED");
  }
  if (discoveredProfile?.status !== "available") throw new SmokeFailure("PROFILE_NOT_AVAILABLE");
  if (discoveredModels?.status !== "available") throw new SmokeFailure("MODELS_NOT_AVAILABLE");

  runtime = createHarness({ adapters: [setup.adapter], persistence, tools });
  const base = {
    session,
    adapterId: setup.adapter.id,
    ...(selectedModel(provider) ? { model: selectedModel(provider)! } : {}),
  } as const;

  stage = "fresh-tool-turn";
  const first = await completedTurn(runtime, {
    ...base,
    input: [{
      type: "text",
      text: "Call smoke_echo exactly once with value NATIVE_TOOL_OK. Then reply with exactly NATIVE_TOOL_OK.",
    }],
    ...(provider === "codex" ? {
      settings: { controls: { [CODEX_SERVICE_TIER_CONTROL_ID]: "priority" } },
    } : {}),
  }, { respond: provider === "claude" });
  if (!has(first, "tool-started") || !has(first, "tool-completed")) {
    throw new SmokeFailure("TOOL_EVENTS_MISSING");
  }
  if (!text(first).includes("NATIVE_TOOL_OK")) throw new SmokeFailure("TOOL_MARKER_MISSING");
  if (provider === "claude" && !has(first, "interaction-requested")) {
    throw new SmokeFailure("INTERACTION_EVENT_MISSING");
  }

  stage = "close-fresh-runtime";
  await runtime.close();
  runtime = undefined;
  await setup.cleanup();
  setup = undefined;

  stage = "resume-setup";
  setup = await makeAdapter();
  runtime = createHarness({ adapters: [setup.adapter], persistence, tools });
  stage = "resumed-turn";
  const resumed = await completedTurn(runtime, {
    ...base,
    input: [{ type: "text", text: "Reply with exactly NATIVE_RESUME_OK." }],
  });
  if (!text(resumed).includes("NATIVE_RESUME_OK")) throw new SmokeFailure("RESUME_MARKER_MISSING");

  stage = "steering-turn";
  const steered = await completedTurn(runtime, {
    ...base,
    input: [{
      type: "text",
      text: "Use smoke_pause to check whether my note is ready. After the tool result, wait for my next message before answering.",
    }],
  }, { steerAfterTool: true });
  if (!text(steered).includes("NATIVE_STEER_OK")) throw new SmokeFailure("STEERING_MARKER_MISSING");

  stage = "cancellation-turn";
  const cancellation = runtime.start({
    ...base,
    input: [{ type: "text", text: "Call smoke_block exactly once and wait for its result." }],
  });
  const cancellationEvents = bounded(collect(cancellation), "cancellation-events");
  await bounded(blockStarted, "cancellation-tool");
  await bounded(cancellation.cancel(), "cancellation");
  const cancelled = await cancellationEvents;
  if (await cancellation.done !== "interrupted") throw new SmokeFailure("CANCEL_STATUS_CHANGED");
  if (cancelled.at(-1)?.payload.kind !== "turn-completed"
      || cancelled.at(-1)?.payload.kind === "turn-completed" && cancelled.at(-1)?.payload.status !== "interrupted") {
    throw new SmokeFailure("CANCEL_TERMINAL_MISSING");
  }

  stage = "limits";
  const finalLimits = await setup.adapter.limits?.({});
  const limitStatus = finalLimits?.status ?? "missing";
  const summary = {
    provider,
    status: "passed",
    discovery: {
      profile: discoveredProfile.status,
      models: discoveredModels.status,
      limitsBeforeRun: discoveredLimits?.status ?? "missing",
      limitsAfterRun: limitStatus,
      defaultModelId: discoveredModels.value.defaultModelId,
      modelCatalog: discoveredModels.value.models.map((model) => ({
        id: model.id,
        label: model.label,
        effort: model.effort?.options.map((option) => option.id) ?? [],
      })),
      limitSnapshotBeforeRun: limitSummary(discoveredLimits),
      limitSnapshotAfterRun: limitSummary(finalLimits),
    },
    matrix: {
      fresh: true,
      resume: true,
      tools: true,
      interactions: provider === "claude",
      fast: provider === "codex",
      steering: true,
      cancellation: true,
    },
    observations: {
      checkpoints: state.checkpoints,
      limitSnapshots: state.limitSnapshots,
      stderrBytes: state.stderrBytes,
      lastTurnStatus,
      lastErrorCode,
      lastEventKinds,
      ...(process.env.FOLD_HARNESS_LIVE_DEBUG === "1" ? { lastAssistantText } : {}),
    },
  };
  if (state.checkpoints < 1) throw new SmokeFailure("CHECKPOINT_NOT_OBSERVED");
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    provider,
    status: "failed",
    stage,
    code: error instanceof SmokeFailure ? error.code : "UNEXPECTED_FAILURE",
    observations: {
      checkpoints: state.checkpoints,
      limitSnapshots: state.limitSnapshots,
      stderrBytes: state.stderrBytes,
      lastTurnStatus,
      lastErrorCode,
      lastEventKinds,
      ...(process.env.FOLD_HARNESS_LIVE_DEBUG === "1" ? { lastAssistantText } : {}),
    },
  }, null, 2));
  process.exitCode = 1;
} finally {
  await runtime?.close().catch(() => undefined);
  await setup?.cleanup().catch(() => undefined);
  if (!process.env.FOLD_HARNESS_LIVE_KEEP) await rm(smokeRoot, { recursive: true, force: true });
}
