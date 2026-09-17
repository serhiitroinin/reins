import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface PackageFile {
  name: string;
  version: string;
}

interface PackResult {
  filename: string;
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function run(
  command: string,
  args: readonly string[],
  cwd: string,
  timeoutMs = 120_000,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
    env: environment,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    throw new Error(`${command} failed with exit code ${String(result.status)}`);
  }
  return result.stdout ?? "";
}

const temporary = await mkdtemp(join(tmpdir(), "fold-harness-consumer-"));
try {
  const packDirectory = join(temporary, "pack");
  const consumer = join(temporary, "consumer");
  const store = join(temporary, "store");
  const cargoTarget = join(temporary, "cargo-target");
  await mkdir(packDirectory);
  await mkdir(consumer);
  await mkdir(store, { mode: 0o700 });

  const packageFile = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  ) as PackageFile;
  const packOutput = run("npm", ["pack", "--json", "--pack-destination", packDirectory], root);
  const packed = JSON.parse(packOutput) as PackResult[];
  const filename = packed[0]?.filename;
  if (!filename) throw new Error("npm pack did not return a tarball name");
  const tarball = join(packDirectory, filename);

  await writeFile(join(consumer, "package.json"), JSON.stringify({
    name: "fold-harness-clean-consumer",
    private: true,
    type: "module",
  }, null, 2));
  run(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      tarball,
      "typescript@5.9.3",
      "@types/node@22.20.1",
    ],
    consumer,
    120_000,
    {
      ...process.env,
      npm_config_min_release_age: "0",
      npm_config_minimum_release_age: "0",
    },
  );

  await writeFile(join(consumer, "index.mjs"), `
import {
  createHarness,
  createMemoryPersistence,
  createToolHost,
} from "@serhiitroinin/fold-harness";
import { createScriptedAdapter } from "@serhiitroinin/fold-harness/testing";

const tools = createToolHost([{
  name: "ping",
  description: "Return one value",
  inputSchema: { type: "object", additionalProperties: false },
  execute: async () => ({ content: [{ type: "text", text: "pong" }] }),
}]);
const fixture = createScriptedAdapter({
  async *script({ tools }) {
    const result = await tools.call("ping", {});
    const first = result.content[0];
    yield { kind: "assistant-text", text: first?.type === "text" ? first.text : "missing" };
  },
});
const harness = createHarness({
  adapters: [fixture.adapter],
  persistence: createMemoryPersistence(),
  tools,
});
const run = harness.start({
  session: { tenantId: "clean", actorId: "consumer", threadId: "one" },
  adapterId: fixture.adapter.id,
  input: [{ type: "text", text: "ping" }],
});
const events = [];
for await (const event of run.events) events.push(event);
if (!events.some((event) => event.payload.kind === "assistant-text" && event.payload.text === "pong")) {
  throw new Error("the installed Node API did not complete the tool turn");
}
if (events.at(-1)?.payload.kind !== "turn-completed") {
  throw new Error("the installed Node API did not seal the turn");
}
await harness.close();
console.log("clean Node consumer passed");
`);

  await writeFile(join(consumer, "types.ts"), `
import { createHarness, createMemoryPersistence, type HarnessEvent } from "@serhiitroinin/fold-harness";
import type { HarnessSidecarInitializeResult } from "@serhiitroinin/fold-harness/sidecar-protocol";
const events: HarnessEvent[] = [];
const initialize: HarnessSidecarInitializeResult | null = null;
void events;
void initialize;
void createHarness;
void createMemoryPersistence;
`);
  await writeFile(join(consumer, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      skipLibCheck: true,
      noEmit: true,
    },
    include: ["types.ts"],
  }, null, 2));

  run("node", [join(consumer, "index.mjs")], consumer);
  run(
    "node",
    [join(consumer, "node_modules/typescript/bin/tsc"), "-p", join(consumer, "tsconfig.json")],
    consumer,
  );

  const installed = join(consumer, "node_modules", "@serhiitroinin", "fold-harness");
  const sidecar = join(installed, "dist", "bin", "fold-harness-sidecar.js");
  const sidecarBin = join(
    consumer,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "fold-harness-sidecar.cmd" : "fold-harness-sidecar",
  );
  const reportedVersion = process.platform === "win32"
    ? run("cmd.exe", ["/d", "/s", "/c", sidecarBin, "--version"], consumer).trim()
    : run(sidecarBin, ["--version"], consumer).trim();
  if (reportedVersion !== packageFile.version) {
    throw new Error(`installed sidecar reported ${reportedVersion}; expected ${packageFile.version}`);
  }

  const host = join(consumer, "host.mjs");
  await writeFile(host, await readFile(join(root, "test", "fixtures", "sidecar-host.mjs"), "utf8"));
  const rustManifest = join(installed, "bindings", "rust", "Cargo.toml");
  const rust = spawnSync("cargo", [
    "run",
    "--quiet",
    "--locked",
    "--manifest-path",
    rustManifest,
    "--example",
    "sidecar_client",
    "--",
    "node",
    sidecar,
    "--host",
    host,
    "--store",
    store,
  ], {
    cwd: consumer,
    env: { ...process.env, CARGO_TARGET_DIR: cargoTarget },
    stdio: "inherit",
    timeout: 180_000,
  });
  if (rust.error) throw rust.error;
  if (rust.status !== 0) throw new Error(`the clean Rust consumer failed with exit code ${String(rust.status)}`);

  console.log(`Clean consumer smoke passed for ${packageFile.name}@${packageFile.version}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
