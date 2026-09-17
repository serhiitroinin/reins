/** Explicit Node child-process transport for the Codex App Server adapter. */

import { Buffer } from "node:buffer";
import { spawn as nodeSpawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import {
  HarnessAdapterError,
} from "../runtime.js";
import type {
  CodexAppServerConnectRequest,
  CodexAppServerConnection,
} from "./codex-app-server-adapter.js";

const DEFAULT_STDOUT_BYTES = 64 * 1024 * 1024;
const DEFAULT_STDERR_BYTES = 1024 * 1024;
const DEFAULT_PENDING_STDIN_BYTES = 4 * 1024 * 1024;
const DEFAULT_SHUTDOWN_GRACE_MS = 2_000;

export interface CodexAppServerProcessChild {
  stdin: Pick<Writable, "destroyed" | "writableEnded" | "write" | "end" | "destroy" | "on">;
  stdout: Pick<Readable, "destroy" | typeof Symbol.asyncIterator>;
  stderr: Pick<Readable, "destroy" | typeof Symbol.asyncIterator>;
  kill(signal?: NodeJS.Signals | number): boolean;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(event: "error", listener: (error: Error) => void): this;
}

export type CodexAppServerProcessSpawn = (
  command: string,
  args: readonly string[],
  options: {
    cwd?: string;
    env: NodeJS.ProcessEnv;
    shell: false;
    windowsHide: true;
    stdio: ["pipe", "pipe", "pipe"];
  },
) => CodexAppServerProcessChild;

export interface CodexAppServerProcessOptions {
  /** Executable selected by the host. Prefer an absolute path. */
  command: string;
  /** Complete argv, normally beginning with `app-server`, `--stdio`. */
  args: readonly string[];
  /** Exact child environment. The parent process environment is never merged. */
  env: Readonly<Record<string, string>>;
  /** Process cwd only; it is not a filesystem boundary. */
  cwd?: string;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  maxPendingStdinBytes?: number;
  shutdownGraceMs?: number;
  /** Raw stderr is host-private and never enters harness events or errors. */
  onStderr?(chunk: Uint8Array): void;
  /** Structural test/embedding seam. Defaults to `node:child_process.spawn`. */
  spawn?: CodexAppServerProcessSpawn;
}

interface ProcessLimits {
  maxStdoutBytes: number;
  maxStderrBytes: number;
  maxPendingStdinBytes: number;
  shutdownGraceMs: number;
}

type ProcessRead =
  | { kind: "stdout"; result: IteratorResult<Uint8Array | string> }
  | { kind: "fatal"; error: HarnessAdapterError };

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return selected;
}

function validateOptions(options: CodexAppServerProcessOptions): {
  command: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  cwd?: string;
  limits: ProcessLimits;
} {
  if (typeof options.command !== "string" || options.command.trim().length === 0) {
    throw new TypeError("command must be a non-empty string");
  }
  if (!Array.isArray(options.args) || options.args.some((argument) => typeof argument !== "string")) {
    throw new TypeError("args must contain only strings");
  }
  const prototype = Object.getPrototypeOf(options.env) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("env must be a plain string record");
  }
  const env: NodeJS.ProcessEnv = {};
  for (const key of Reflect.ownKeys(options.env)) {
    if (typeof key !== "string") throw new TypeError("env must not contain symbol keys");
    const descriptor = Object.getOwnPropertyDescriptor(options.env, key);
    if (!descriptor?.enumerable || !("value" in descriptor) || typeof descriptor.value !== "string") {
      throw new TypeError(`env.${key} must be an enumerable string data property`);
    }
    if (key.includes("\0") || descriptor.value.includes("\0")) {
      throw new TypeError("env must not contain null bytes");
    }
    env[key] = descriptor.value;
  }
  if (options.command.includes("\0") || options.args.some((argument) => argument.includes("\0"))) {
    throw new TypeError("command and args must not contain null bytes");
  }
  if (options.cwd !== undefined && (options.cwd.length === 0 || options.cwd.includes("\0"))) {
    throw new TypeError("cwd must be a non-empty path without null bytes");
  }
  return {
    command: options.command,
    args: [...options.args],
    env,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    limits: {
      maxStdoutBytes: positiveInteger(options.maxStdoutBytes, DEFAULT_STDOUT_BYTES, "maxStdoutBytes"),
      maxStderrBytes: positiveInteger(options.maxStderrBytes, DEFAULT_STDERR_BYTES, "maxStderrBytes"),
      maxPendingStdinBytes: positiveInteger(
        options.maxPendingStdinBytes,
        DEFAULT_PENDING_STDIN_BYTES,
        "maxPendingStdinBytes",
      ),
      shutdownGraceMs: positiveInteger(options.shutdownGraceMs, DEFAULT_SHUTDOWN_GRACE_MS, "shutdownGraceMs"),
    },
  };
}

function bytes(chunk: Uint8Array | string): Uint8Array {
  return typeof chunk === "string" ? Buffer.from(chunk) : chunk;
}

function timeout(milliseconds: number): Promise<"timeout"> {
  return new Promise((resolve) => setTimeout(() => resolve("timeout"), milliseconds));
}

function connectionFor(
  child: CodexAppServerProcessChild,
  request: CodexAppServerConnectRequest,
  limits: ProcessLimits,
  onStderr: CodexAppServerProcessOptions["onStderr"],
): CodexAppServerConnection {
  let closed = false;
  let closeWork: Promise<void> | null = null;
  let pendingStdinBytes = 0;
  let fatal: HarnessAdapterError | null = null;
  let resolveFatal!: (value: HarnessAdapterError) => void;
  const fatalSignal = new Promise<HarnessAdapterError>((resolve) => { resolveFatal = resolve; });
  let exited = false;
  let resolveExit!: () => void;
  const exit = new Promise<void>((resolve) => { resolveExit = resolve; });

  const fail = (error: HarnessAdapterError): void => {
    if (fatal || closed) return;
    fatal = error;
    resolveFatal(error);
    try {
      child.kill("SIGTERM");
    } catch {
      // The output reader still observes process/stream termination.
    }
  };

  child.once("exit", () => {
    exited = true;
    resolveExit();
  });
  child.once("error", () => {
    fail(new HarnessAdapterError(
      "CODEX_PROCESS_FAILED",
      "The Codex App Server process failed.",
      true,
    ));
    exited = true;
    resolveExit();
  });
  child.stdin.on("error", () => {
    fail(new HarnessAdapterError(
      "CODEX_PROCESS_INPUT_FAILED",
      "The Codex App Server input stream failed.",
      true,
    ));
  });

  const stderrWork = (async (): Promise<void> => {
    let total = 0;
    try {
      for await (const raw of child.stderr) {
        const chunk = bytes(raw as Uint8Array | string);
        total += chunk.byteLength;
        if (total > limits.maxStderrBytes) {
          fail(new HarnessAdapterError(
            "CODEX_PROCESS_STDERR_TOO_LARGE",
            "The Codex App Server wrote too much diagnostic output.",
          ));
          return;
        }
        try {
          onStderr?.(new Uint8Array(chunk));
        } catch {
          // Stderr observation is operational and cannot affect provider work.
        }
      }
    } catch {
      fail(new HarnessAdapterError(
        "CODEX_PROCESS_STDERR_FAILED",
        "The Codex App Server diagnostic stream failed.",
        true,
      ));
    }
  })();

  const close = (): Promise<void> => {
    if (closeWork) return closeWork;
    closed = true;
    request.signal.removeEventListener("abort", abort);
    closeWork = (async () => {
      if (!child.stdin.destroyed && !child.stdin.writableEnded) {
        try {
          child.stdin.end();
        } catch {
          // Process termination below is authoritative.
        }
      }
      if (!exited) {
        try {
          child.kill("SIGTERM");
        } catch {
          // A concurrently exited process needs no signal.
        }
        if (await Promise.race([exit.then(() => "exit" as const), timeout(limits.shutdownGraceMs)]) === "timeout") {
          try {
            child.kill("SIGKILL");
          } catch {
            // The process may have exited between the timeout and this signal.
          }
          await Promise.race([exit, timeout(limits.shutdownGraceMs)]);
        }
      }
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      await stderrWork.catch(() => undefined);
    })();
    return closeWork;
  };

  const abort = (): void => { void close(); };
  request.signal.addEventListener("abort", abort, { once: true });
  if (request.signal.aborted) abort();

  const output = (async function* (): AsyncGenerator<Uint8Array> {
    const iterator = child.stdout[Symbol.asyncIterator]() as AsyncIterator<Uint8Array | string>;
    let total = 0;
    try {
      for (;;) {
        const read: ProcessRead = await Promise.race([
          iterator.next().then((result): ProcessRead => ({ kind: "stdout", result })),
          fatalSignal.then((error): ProcessRead => ({ kind: "fatal", error })),
        ]);
        if (read.kind === "fatal") throw read.error;
        if (read.result.done) {
          if (closed) return;
          throw fatal ?? new HarnessAdapterError(
            "CODEX_PROCESS_ENDED",
            "The Codex App Server process ended unexpectedly.",
            true,
          );
        }
        const chunk = bytes(read.result.value);
        total += chunk.byteLength;
        if (total > limits.maxStdoutBytes) {
          throw new HarnessAdapterError(
            "CODEX_PROCESS_OUTPUT_TOO_LARGE",
            "The Codex App Server returned too much data.",
          );
        }
        yield new Uint8Array(chunk);
      }
    } catch (error) {
      await close();
      if (error instanceof HarnessAdapterError) throw error;
      throw new HarnessAdapterError(
        "CODEX_PROCESS_OUTPUT_FAILED",
        "The Codex App Server output stream failed.",
        true,
      );
    } finally {
      await iterator.return?.();
    }
  })();

  return {
    write(line) {
      if (closed || child.stdin.destroyed || child.stdin.writableEnded) {
        throw new HarnessAdapterError(
          "CODEX_PROCESS_INPUT_CLOSED",
          "The Codex App Server input stream is closed.",
        );
      }
      if (fatal) throw fatal;
      const size = Buffer.byteLength(line);
      if (pendingStdinBytes + size > limits.maxPendingStdinBytes) {
        const error = new HarnessAdapterError(
          "CODEX_PROCESS_INPUT_TOO_LARGE",
          "The Codex App Server input queue is full.",
        );
        fail(error);
        throw error;
      }
      pendingStdinBytes += size;
      try {
        child.stdin.write(line, (error?: Error | null) => {
          pendingStdinBytes = Math.max(0, pendingStdinBytes - size);
          if (error) {
            fail(new HarnessAdapterError(
              "CODEX_PROCESS_INPUT_FAILED",
              "The Codex App Server input stream failed.",
              true,
            ));
          }
        });
      } catch {
        pendingStdinBytes = Math.max(0, pendingStdinBytes - size);
        const error = new HarnessAdapterError(
          "CODEX_PROCESS_INPUT_FAILED",
          "The Codex App Server input stream failed.",
          true,
        );
        fail(error);
        throw error;
      }
    },
    output,
    close,
  };
}

/**
 * Build the `connect` callback consumed by `createCodexAppServerAdapter`.
 *
 * This helper deliberately does not add argv, inherit environment variables,
 * discover credentials, select a cwd, or make sandbox/approval claims.
 */
export function createCodexAppServerProcessConnector(
  options: CodexAppServerProcessOptions,
): (request: CodexAppServerConnectRequest) => Promise<CodexAppServerConnection> {
  const validated = validateOptions(options);
  const spawn = options.spawn ?? ((command, args, spawnOptions) => nodeSpawn(command, [...args], spawnOptions));
  return async (request) => {
    if (request.signal.aborted) {
      throw new HarnessAdapterError("CODEX_PROCESS_CANCELLED", "The Codex App Server start was cancelled.");
    }
    let child: CodexAppServerProcessChild;
    try {
      child = spawn(validated.command, validated.args, {
        ...(validated.cwd ? { cwd: validated.cwd } : {}),
        env: { ...validated.env },
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      throw new HarnessAdapterError(
        "CODEX_PROCESS_START_FAILED",
        "The Codex App Server process could not be started.",
        true,
      );
    }
    return connectionFor(child, request, validated.limits, options.onStderr);
  };
}

