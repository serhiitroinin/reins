/** Bounded Node stdio deployment for the transport-neutral sidecar. */

import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import {
  createHarnessSidecar,
  type HarnessSidecar,
  type HarnessSidecarOptions,
} from "./sidecar.js";

export const HARNESS_SIDECAR_DEFAULT_MAX_PENDING_OUTPUT_BYTES = 16_000_000;

export interface HarnessSidecarStdioOptions extends Omit<HarnessSidecarOptions, "write"> {
  input: Readable;
  output: Writable;
  signal?: AbortSignal;
  maxPendingOutputBytes?: number;
}

export interface HarnessSidecarStdio {
  readonly sidecar: HarnessSidecar;
  /** Resolves after clean shutdown and output delivery; rejects on transport failure. */
  readonly done: Promise<void>;
  close(reason?: string): Promise<void>;
}

/** Connect one sidecar to newline-delimited stdin/stdout-style streams. */
export function runHarnessSidecarStdio(options: HarnessSidecarStdioOptions): HarnessSidecarStdio {
  const maximum = options.maxPendingOutputBytes ?? HARNESS_SIDECAR_DEFAULT_MAX_PENDING_OUTPUT_BYTES;
  if (!Number.isSafeInteger(maximum) || maximum < 1) {
    throw new Error("maxPendingOutputBytes must be a positive integer");
  }
  let pendingBytes = 0;
  let closing = false;
  let transportFailure: Error | null = null;
  let settleDone!: () => void;
  let rejectDone!: (error: Error) => void;
  const done = new Promise<void>((resolve, reject) => {
    settleDone = resolve;
    rejectDone = reject;
  });
  const decoder = new StringDecoder("utf8");

  let sidecar!: HarnessSidecar;
  const fail = (error: unknown): void => {
    if (transportFailure) return;
    transportFailure = error instanceof Error ? error : new Error("the sidecar stdio transport failed");
    void sidecar?.end("the sidecar stdio transport failed").then(
      () => { closing = true; finish(); },
      () => { closing = true; finish(); },
    );
  };
  const write = (line: string): void => {
    if (closing || transportFailure) return;
    const bytes = Buffer.byteLength(line, "utf8");
    if (bytes > maximum || pendingBytes + bytes > maximum) {
      fail(new Error("the sidecar stdout queue exceeded its safe byte limit"));
      return;
    }
    pendingBytes += bytes;
    try {
      options.output.write(line, "utf8", (error?: Error | null) => {
        pendingBytes -= bytes;
        if (error) fail(error);
        else finish();
      });
    } catch (error) {
      pendingBytes -= bytes;
      fail(error);
    }
  };

  sidecar = createHarnessSidecar({
    adapters: options.adapters,
    persistence: options.persistence,
    write,
    ...(options.server ? { server: options.server } : {}),
    ...(options.contextSources ? { contextSources: options.contextSources } : {}),
    ...(options.onContextError ? { onContextError: options.onContextError } : {}),
    ...(options.onDiagnostic ? { onDiagnostic: options.onDiagnostic } : {}),
    ...(options.onMalformedMessage ? { onMalformedMessage: options.onMalformedMessage } : {}),
    ...(options.createId ? { createId: options.createId } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.maxBufferedChars === undefined ? {} : { maxBufferedChars: options.maxBufferedChars }),
  });

  const detach = (): void => {
    options.input.off("data", onData);
    options.input.off("end", onEnd);
    options.input.off("error", onInputError);
    options.output.off("error", onOutputError);
    options.signal?.removeEventListener("abort", onAbort);
    options.input.pause();
  };
  const finish = (): void => {
    if (!closing || pendingBytes !== 0) return;
    detach();
    if (transportFailure) rejectDone(transportFailure);
    else settleDone();
  };
  const onData = (chunk: Buffer | string): void => {
    const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
    if (text !== "") sidecar.text(text);
  };
  const onEnd = (): void => {
    const final = decoder.end();
    if (final !== "") sidecar.text(final);
    void sidecar.end("the sidecar stdin stream ended").catch(fail);
  };
  const onInputError = (error: Error): void => fail(error);
  const onOutputError = (error: Error): void => fail(error);
  const onAbort = (): void => {
    void sidecar.end("the sidecar host aborted").catch(fail);
  };

  options.input.on("data", onData);
  options.input.once("end", onEnd);
  options.input.once("error", onInputError);
  options.output.once("error", onOutputError);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  else options.input.resume();

  void sidecar.closed.then(() => {
    closing = true;
    finish();
  }, fail);

  return {
    sidecar,
    done,
    async close(reason = "the sidecar stdio host closed") {
      await sidecar.end(reason);
      await done;
    },
  };
}
