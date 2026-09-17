#!/usr/bin/env node

import { readFile, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createFilePersistence } from "../persistence/file.js";
import { resolveHarnessSidecarHost } from "../sidecar-host.js";
import { runHarnessSidecarStdio } from "../sidecar-node.js";

interface CliOptions {
  host: string;
  store: string;
  maxPendingOutputBytes?: number;
}

const USAGE = `Usage: fold-harness-sidecar --host <absolute-module-path> --store <absolute-directory>

Options:
  --host <path>                       Explicit JS host module exporting adapters
  --store <path>                      Private single-writer persistence directory
  --max-pending-output-bytes <bytes>  Bound queued stdout protocol data
  --help                              Show this help
  --version                           Show the package version`;

function positive(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function parse(argv: readonly string[]): CliOptions | "help" | "version" {
  let host: string | undefined;
  let store: string | undefined;
  let maxPendingOutputBytes: number | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return "help";
    if (argument === "--version" || argument === "-v") return "version";
    if (argument === "--host") host = argv[++index];
    else if (argument === "--store") store = argv[++index];
    else if (argument === "--max-pending-output-bytes") {
      maxPendingOutputBytes = positive(argv[++index], "--max-pending-output-bytes");
    } else throw new Error(`unknown argument: ${String(argument)}`);
  }
  if (!host || !store) throw new Error("--host and --store are required");
  if (!isAbsolute(host) || !isAbsolute(store)) {
    throw new Error("--host and --store must be absolute paths");
  }
  return { host, store, ...(maxPendingOutputBytes ? { maxPendingOutputBytes } : {}) };
}

async function packageVersion(): Promise<string> {
  const packagePath = fileURLToPath(new URL("../../package.json", import.meta.url));
  const value = JSON.parse(await readFile(packagePath, "utf8")) as { version?: unknown };
  return typeof value.version === "string" ? value.version : "unknown";
}

async function main(): Promise<void> {
  const selected = parse(process.argv.slice(2));
  if (selected === "help") {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (selected === "version") {
    process.stdout.write(`${await packageVersion()}\n`);
    return;
  }
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    const hostPath = await realpath(selected.host);
    const loaded: unknown = await import(pathToFileURL(hostPath).href);
    const host = await resolveHarnessSidecarHost(loaded, controller.signal);
    const running = runHarnessSidecarStdio({
      adapters: host.adapters,
      persistence: createFilePersistence({ directory: selected.store }),
      input: process.stdin,
      output: process.stdout,
      signal: controller.signal,
      ...(host.server ? { server: host.server } : {}),
      ...(host.contextSources ? { contextSources: host.contextSources } : {}),
      ...(host.onContextError ? { onContextError: host.onContextError } : {}),
      ...(host.onDiagnostic ? { onDiagnostic: host.onDiagnostic } : {}),
      ...(selected.maxPendingOutputBytes ? { maxPendingOutputBytes: selected.maxPendingOutputBytes } : {}),
    });
    await running.done;
  } finally {
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "the sidecar failed";
  process.stderr.write(`fold-harness-sidecar: ${message}\n`);
  process.exitCode = 1;
});
