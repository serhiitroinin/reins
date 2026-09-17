import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import {
  createCodexAppServerProcessConnector,
  HarnessAdapterError,
  type CodexAppServerConnectRequest,
  type CodexAppServerProcessChild,
} from "../src/index.ts";

const PARENT_SECRET = "FOLD_HARNESS_CONNECTOR_PARENT_SECRET";

afterEach(() => {
  delete process.env[PARENT_SECRET];
});

function request(controller = new AbortController()): CodexAppServerConnectRequest {
  return {
    session: { tenantId: "tenant", actorId: "actor", threadId: "thread" },
    resumeToken: null,
    runId: "run-1",
    turnId: "turn-1",
    signal: controller.signal,
  };
}

function childScript(source: string): readonly string[] {
  return ["-e", source];
}

async function firstChunk(output: AsyncIterable<Uint8Array | string>): Promise<string> {
  const result = await output[Symbol.asyncIterator]().next();
  if (result.done) throw new Error("process output ended");
  return new TextDecoder().decode(typeof result.value === "string"
    ? new TextEncoder().encode(result.value)
    : result.value);
}

describe("Codex App Server process connector", () => {
  test("uses exact argv and environment while bridging stdin, stdout, and private stderr", async () => {
    process.env[PARENT_SECRET] = "must-not-leak";
    const stderr: Uint8Array[] = [];
    const connect = createCodexAppServerProcessConnector({
      command: process.execPath,
      args: childScript(`
        process.stdin.setEncoding("utf8");
        process.stdin.once("data", (line) => {
          process.stderr.write("diagnostic");
          process.stdout.write(JSON.stringify({
            line,
            allowed: process.env.CONNECTOR_ALLOWED,
            leaked: process.env.${PARENT_SECRET} ?? null,
          }) + "\\n");
        });
      `),
      env: { CONNECTOR_ALLOWED: "yes" },
      onStderr: (chunk) => stderr.push(chunk),
    });
    const connection = await connect(request());
    connection.write("ping\n");
    expect(JSON.parse(await firstChunk(connection.output))).toEqual({
      line: "ping\n",
      allowed: "yes",
      leaked: null,
    });
    for (let attempt = 0; attempt < 20 && stderr.length === 0; attempt += 1) await Bun.sleep(2);
    expect(new TextDecoder().decode(stderr[0])).toBe("diagnostic");
    await connection.close();
  });

  test("fails with bounded safe errors for excessive stdout and stderr", async () => {
    const stdoutConnection = await createCodexAppServerProcessConnector({
      command: process.execPath,
      args: childScript(`process.stdout.write("x".repeat(128)); setInterval(() => {}, 1000);`),
      env: {},
      maxStdoutBytes: 16,
    })(request());
    await expect(firstChunk(stdoutConnection.output)).rejects.toMatchObject({
      code: "CODEX_PROCESS_OUTPUT_TOO_LARGE",
      publicMessage: "The Codex App Server returned too much data.",
    });

    const stderrConnection = await createCodexAppServerProcessConnector({
      command: process.execPath,
      args: childScript(`process.stderr.write("x".repeat(128)); setInterval(() => {}, 1000);`),
      env: {},
      maxStderrBytes: 16,
    })(request());
    await expect(firstChunk(stderrConnection.output)).rejects.toMatchObject({
      code: "CODEX_PROCESS_STDERR_TOO_LARGE",
      publicMessage: "The Codex App Server wrote too much diagnostic output.",
    });
  });

  test("closes promptly on abort and rejects a pre-aborted start", async () => {
    const controller = new AbortController();
    const connect = createCodexAppServerProcessConnector({
      command: process.execPath,
      args: childScript(`setInterval(() => {}, 1000);`),
      env: {},
      shutdownGraceMs: 100,
    });
    const connection = await connect(request(controller));
    controller.abort();
    await connection.close();
    await expect(connection.output[Symbol.asyncIterator]().next()).resolves.toEqual({
      done: true,
      value: undefined,
    });

    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await expect(connect(request(alreadyAborted))).rejects.toMatchObject({
      code: "CODEX_PROCESS_CANCELLED",
    });
  });

  test("bounds queued stdin even when a child never accepts a write", async () => {
    class FakeChild extends EventEmitter {
      readonly stdin = new Writable({ write() {} });
      readonly stdout = new PassThrough();
      readonly stderr = new PassThrough();

      kill(): boolean {
        queueMicrotask(() => this.emit("exit", 0, null));
        return true;
      }
    }
    const child = new FakeChild();
    const connect = createCodexAppServerProcessConnector({
      command: "/explicit/codex",
      args: ["app-server", "--stdio"],
      env: { PATH: "/explicit" },
      maxPendingStdinBytes: 8,
      spawn: () => child as unknown as CodexAppServerProcessChild,
    });
    const connection = await connect(request());
    connection.write("12345678");
    expect(() => connection.write("x")).toThrow(HarnessAdapterError);
    expect(() => connection.write("x")).toThrow("The Codex App Server input queue is full.");
    await connection.close();
  });

  test("validates the process boundary before spawning", () => {
    expect(() => createCodexAppServerProcessConnector({
      command: "",
      args: [],
      env: {},
    })).toThrow("command must be a non-empty string");
    expect(() => createCodexAppServerProcessConnector({
      command: "codex",
      args: [],
      env: process.env as Record<string, string>,
      maxStdoutBytes: 0,
    })).toThrow();
    const env = Object.create({ PATH: "/inherited" }) as Record<string, string>;
    expect(() => createCodexAppServerProcessConnector({
      command: "codex",
      args: [],
      env,
    })).toThrow("env must be a plain string record");
  });
});
