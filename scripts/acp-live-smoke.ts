/**
 * Credential-bearing ACP compatibility smoke test. Not run in CI.
 *
 * The script creates a synthetic workspace and an isolated HOME. Point the
 * provider-specific `ACP_SMOKE_*_HOME` variable at a prepared private account
 * directory, or provide the provider's API-key environment variable.
 */

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createAcpV1Adapter,
  type AcpV1ByteConnection,
  type AcpV1NegotiatedAgent,
  type AcpV1SessionConfigOption,
} from "../src/index.js";
import { createHarness } from "../src/runtime.js";
import { createMemoryPersistence } from "../src/stores.js";
import type { HarnessEvent, HarnessRunRequest } from "../src/protocol.js";

type Provider = "claude" | "codex" | "opencode" | "grok";

const commands: Record<Provider, readonly string[]> = {
  claude: ["npm", "exec", "--yes", "@agentclientprotocol/claude-agent-acp@0.77.0"],
  codex: ["npm", "exec", "--yes", "@agentclientprotocol/codex-acp@1.11.0"],
  opencode: ["opencode", "acp"],
  grok: ["grok", "agent", "stdio"],
};

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function selectedProvider(): Provider {
  const value = argument("--provider");
  if (value === "claude" || value === "codex" || value === "opencode" || value === "grok") return value;
  throw new Error("Usage: bun run smoke:acp -- --provider claude|codex|opencode|grok");
}

function inheritedEnvironment(): Record<string, string> {
  const allowed = [
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
    "NODE_EXTRA_CA_CERTS",
    "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CODEX_API_KEY",
    "OPENAI_API_KEY",
    "XAI_API_KEY",
  ];
  return Object.fromEntries(allowed.flatMap((name) => {
    const value = process.env[name];
    return value === undefined ? [] : [[name, value]];
  }));
}

function providerEnvironment(provider: Provider, isolatedHome: string): Record<string, string> {
  const environment: Record<string, string> = {
    ...inheritedEnvironment(),
    HOME: isolatedHome,
    XDG_CONFIG_HOME: join(isolatedHome, ".config"),
    XDG_DATA_HOME: join(isolatedHome, ".local", "share"),
    XDG_CACHE_HOME: join(isolatedHome, ".cache"),
    npm_config_userconfig: "/dev/null",
  };
  if (provider === "codex") {
    environment.CODEX_HOME = process.env.ACP_SMOKE_CODEX_HOME ?? join(isolatedHome, ".codex");
  }
  if (provider === "claude") {
    const configDirectory = process.env.ACP_SMOKE_CLAUDE_HOME;
    if (configDirectory) environment.CLAUDE_CONFIG_DIR = configDirectory;
  }
  if (provider === "opencode") {
    environment.XDG_CONFIG_HOME = process.env.ACP_SMOKE_OPENCODE_CONFIG_HOME ?? join(isolatedHome, ".config");
    environment.XDG_DATA_HOME = process.env.ACP_SMOKE_OPENCODE_DATA_HOME ?? join(isolatedHome, ".local", "share");
  }
  if (provider === "grok") {
    environment.GROK_HOME = process.env.ACP_SMOKE_GROK_HOME ?? join(isolatedHome, ".grok");
  }
  return environment;
}

function launch(
  command: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string>>,
  diagnostics: { stderrBytes: number; exitCode?: number },
): AcpV1ByteConnection {
  const child = Bun.spawn([...command], {
    cwd,
    env: { ...env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  void (async () => {
    for await (const chunk of child.stderr) diagnostics.stderrBytes += chunk.byteLength;
  })();
  void child.exited.then((code) => { diagnostics.exitCode = code; });
  let closed = false;
  return {
    readable: child.stdout,
    writable: new WritableStream<Uint8Array>({
      async write(chunk) {
        child.stdin.write(chunk);
        await child.stdin.flush();
      },
      close() { child.stdin.end(); },
      abort() { child.stdin.end(); },
    }),
    async close() {
      if (closed) return;
      closed = true;
      child.stdin.end();
      child.kill();
      const exited = await Promise.race([
        child.exited.then(() => true),
        Bun.sleep(2_000).then(() => false),
      ]);
      if (!exited) {
        child.kill(9);
        await child.exited;
      }
    },
  };
}

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of stream) values.push(value);
  return values;
}

class SmokeFailure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

async function runTurn(runtime: ReturnType<typeof createHarness>, request: HarnessRunRequest): Promise<HarnessEvent[]> {
  const run = runtime.start(request);
  const events = await collect(run.events);
  const status = await run.done;
  if (status !== "completed") {
    const error = events.find((event) => event.payload.kind === "error");
    throw new SmokeFailure(error?.payload.kind === "error" ? error.payload.code : `TURN_${status.toUpperCase()}`);
  }
  return events;
}

function text(events: readonly HarnessEvent[]): string {
  return events.flatMap((event) => event.payload.kind === "assistant-text" ? [event.payload.text] : []).join("");
}

function configSelection(): Readonly<Record<string, string | boolean>> {
  const source = process.env.ACP_SMOKE_CONFIG_JSON;
  if (!source) return {};
  const parsed: unknown = JSON.parse(source);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("ACP_SMOKE_CONFIG_JSON must be a JSON object");
  }
  for (const value of Object.values(parsed)) {
    if (typeof value !== "string" && typeof value !== "boolean") {
      throw new Error("ACP_SMOKE_CONFIG_JSON values must be strings or booleans");
    }
  }
  return parsed as Readonly<Record<string, string | boolean>>;
}

function summarizeOptions(options: readonly AcpV1SessionConfigOption[]): unknown {
  return options.map((option) => ({ id: option.id, category: option.category, type: option.type }));
}

const provider = selectedProvider();
const smokeRoot = await mkdtemp(join(tmpdir(), `fold-harness-acp-${provider}-`));
const isolatedHome = process.env.ACP_SMOKE_HOME ?? join(smokeRoot, "home");
const workspace = join(smokeRoot, "workspace");
await mkdir(isolatedHome, { recursive: true, mode: 0o700 });
await mkdir(workspace, { recursive: true, mode: 0o700 });

const diagnostics: Array<{ stderrBytes: number; exitCode?: number }> = [];
const errors: Array<{ type: string; numericCode?: number; hasData: boolean }> = [];
const negotiated: AcpV1NegotiatedAgent[] = [];
const sessionOptions: unknown[] = [];
const persistence = createMemoryPersistence();
const selectedConfig = configSelection();

const makeAdapter = () => createAcpV1Adapter({
  id: `acp-live:${provider}`,
  session: () => ({ cwd: workspace }),
  connect() {
    const processDiagnostics = { stderrBytes: 0 };
    diagnostics.push(processDiagnostics);
    return launch(commands[provider], workspace, providerEnvironment(provider, isolatedHome), processDiagnostics);
  },
  onNegotiated(value) { negotiated.push(value); },
  publicError(error) {
    const record = typeof error === "object" && error !== null ? error as Record<string, unknown> : {};
    const type = error instanceof Error ? error.constructor.name : typeof error;
    const numericCode = typeof record.code === "number" ? record.code : undefined;
    errors.push({ type, ...(numericCode !== undefined ? { numericCode } : {}), hasData: record.data !== undefined });
    return {
      code: `ACP_LIVE_${type.replace(/[^A-Za-z0-9_]/g, "_").toUpperCase()}${numericCode !== undefined ? `_${numericCode}` : ""}`,
      message: "The live ACP peer returned an error; provider-authored details were redacted.",
    };
  },
  async configureSession(controller) {
    sessionOptions.push(summarizeOptions(controller.configOptions));
    const model = process.env.ACP_SMOKE_MODEL;
    const effort = process.env.ACP_SMOKE_EFFORT;
    const modelOption = controller.configOptions.find((option) => option.category === "model");
    const effortOption = controller.configOptions.find((option) => option.category === "thought_level");
    if (model && modelOption) await controller.setConfigOption(modelOption.id, model);
    if (effort && effortOption) await controller.setConfigOption(effortOption.id, effort);
    for (const [id, value] of Object.entries(selectedConfig)) await controller.setConfigOption(id, value);
  },
});

const baseRequest = {
  session: { tenantId: "live", actorId: "smoke", threadId: `${provider}-session` },
  adapterId: `acp-live:${provider}`,
} as const;

let stage = "create-first-runtime";
let activeRuntime: ReturnType<typeof createHarness> | undefined;
try {
  activeRuntime = createHarness({ adapters: [makeAdapter()], persistence });
  stage = "first-turn";
  const first = await runTurn(activeRuntime, {
    ...baseRequest,
    input: [{ type: "text", text: "Reply with exactly ACP_SMOKE_ONE_OK" }],
  });
  if (!text(first).includes("ACP_SMOKE_ONE_OK")) throw new SmokeFailure("FIRST_MARKER_MISSING");
  stage = "second-turn";
  const second = await runTurn(activeRuntime, {
    ...baseRequest,
    input: [{ type: "text", text: "Reply with exactly ACP_SMOKE_TWO_OK" }],
  });
  if (!text(second).includes("ACP_SMOKE_TWO_OK")) throw new SmokeFailure("SECOND_MARKER_MISSING");
  stage = "close-first-runtime";
  await activeRuntime.close();
  activeRuntime = undefined;

  stage = "create-resumed-runtime";
  activeRuntime = createHarness({ adapters: [makeAdapter()], persistence });
  stage = "resumed-turn";
  const resumed = await runTurn(activeRuntime, {
    ...baseRequest,
    input: [{ type: "text", text: "Reply with exactly ACP_SMOKE_RESUME_OK" }],
  });
  if (!text(resumed).includes("ACP_SMOKE_RESUME_OK")) throw new SmokeFailure("RESUME_MARKER_MISSING");
  stage = "close-resumed-runtime";
  await activeRuntime.close();
  activeRuntime = undefined;

  console.log(JSON.stringify({
    provider,
    status: "passed",
    turns: 3,
    resumed: true,
    negotiated,
    sessionOptions,
    diagnostics,
    errors,
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    provider,
    status: "failed",
    stage,
    code: error instanceof SmokeFailure ? error.code : "UNEXPECTED_FAILURE",
    negotiated,
    sessionOptions,
    diagnostics,
    errors,
  }, null, 2));
  process.exitCode = 1;
} finally {
  await activeRuntime?.close().catch(() => undefined);
  if (!process.env.ACP_SMOKE_KEEP) await rm(smokeRoot, { recursive: true, force: true });
}
