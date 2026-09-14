/**
 * A provider-injected Codex App Server adapter.
 *
 * The host owns process creation, credentials, environment, and policy. This
 * module owns only the App Server conversation and its harness projection.
 */

import { Buffer } from "node:buffer";
import type { HarnessInput, HarnessSessionKey } from "../protocol.js";
import type {
  HarnessCapabilities,
} from "../protocol.js";
import type {
  HarnessDiscovery,
  HarnessDiscoveryRequest,
  HarnessEngineProfile,
  HarnessLimitSnapshot,
  HarnessModelCatalog,
} from "../profile.js";
import {
  HarnessAdapterError,
  HarnessAdapterInterruptedError,
  type HarnessAdapter,
  type HarnessAdapterEvent,
  type HarnessAdapterRunRequest,
  type HarnessAdapterSession,
} from "../runtime.js";
import type { HarnessToolContent, HarnessToolResult } from "../tools.js";
import {
  codexDynamicTools,
  codexInitializeParams,
  codexThreadResumeParams,
  codexThreadStartParams,
  codexTurnSettingOverrides,
  createCodexAppServerClient,
  type CodexAppServerClient,
  type CodexAppServerClientInfo,
  type CodexInitializeOptions,
  type CodexThreadOptions,
} from "./codex-app-server.js";
import {
  createCodexAppServerEventConsumer,
  type CodexAppServerEventConsumerOptions,
  type CodexAppServerTurnOutcome,
} from "./codex-app-server-events.js";

export interface CodexAppServerConnection {
  /** Write one complete JSON-RPC line to the provider. */
  write(line: string): void;
  /** Arbitrarily split UTF-8 bytes or decoded text read from the provider. */
  output: AsyncIterable<Uint8Array | string>;
  /** Must make `output` settle and release the host-owned resource. */
  close(): Promise<void> | void;
}

export interface CodexAppServerConnectRequest {
  session: HarnessSessionKey;
  resumeToken: string | null;
  runId: string;
  turnId: string;
  accountId?: string;
  configuration?: Readonly<Record<string, unknown>>;
  signal: AbortSignal;
}

export type CodexAppServerDiscoverySource<T> =
  | HarnessDiscovery<T>
  | ((request: HarnessDiscoveryRequest) => Promise<HarnessDiscovery<T>> | HarnessDiscovery<T>);

export type CodexAppServerThreadPolicy = Omit<CodexThreadOptions, "dynamicTools">;

export interface CodexAppServerAdapterOptions {
  id?: string;
  clientInfo: CodexAppServerClientInfo;
  initialize?: Omit<CodexInitializeOptions, "clientInfo">;
  capabilities?: HarnessCapabilities;
  profile?: CodexAppServerDiscoverySource<HarnessEngineProfile>;
  models?: CodexAppServerDiscoverySource<HarnessModelCatalog>;
  limits?: CodexAppServerDiscoverySource<HarnessLimitSnapshot>;
  /** The host chooses the real cwd, sandbox, approval policy, and model. */
  thread(request: HarnessAdapterRunRequest): Promise<CodexAppServerThreadPolicy> | CodexAppServerThreadPolicy;
  /** The host creates an explicit, isolated provider connection for this turn. */
  connect(request: CodexAppServerConnectRequest): Promise<CodexAppServerConnection> | CodexAppServerConnection;
  /** Override provider input serialization, for example to stage a local image. */
  mapInput?(input: HarnessInput, request: HarnessAdapterRunRequest): unknown | readonly unknown[];
  events?: Omit<CodexAppServerEventConsumerOptions, "emit" | "onTurnEnded" | "onLimits">;
  onLimits?(
    snapshot: HarnessLimitSnapshot,
    request: Pick<CodexAppServerConnectRequest, "session" | "accountId" | "runId" | "turnId">,
  ): void;
  excludeTurnsOnResume?: boolean;
}

const unsupported = { support: "unsupported" as const };

/** Conservative capabilities of the injected adapter itself. */
export const CODEX_APP_SERVER_CAPABILITIES: HarnessCapabilities = {
  resume: { support: "stable" },
  cancel: { support: "stable" },
  interactions: unsupported,
  tools: { support: "stable" },
  images: { support: "stable" },
  thinking: { support: "stable" },
  plans: { support: "stable" },
  usage: { support: "stable" },
  subagents: unsupported,
  shell: unsupported,
  filesystem: unsupported,
  network: unsupported,
  extensions: {
    "openai:app-server": { support: "stable" },
    "openai:dynamic-tools": { support: "stable" },
  },
};

class AdapterEventQueue implements AsyncIterable<HarnessAdapterEvent> {
  private readonly values: HarnessAdapterEvent[] = [];
  private readonly waiters: Array<(value: IteratorResult<HarnessAdapterEvent>) => void> = [];
  private closed = false;

  push(value: HarnessAdapterEvent): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value });
    else this.values.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.values.length === 0) {
      for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<HarnessAdapterEvent> {
    return {
      next: async () => {
        const value = this.values.shift();
        if (value !== undefined) return { done: false, value };
        if (this.closed) return { done: true, value: undefined };
        return new Promise<IteratorResult<HarnessAdapterEvent>>((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asArray<T>(value: T | readonly T[]): readonly T[] {
  return Array.isArray(value) ? value as readonly T[] : [value as T];
}

function dataUrl(mediaType: string, data: Uint8Array): string {
  return `data:${mediaType};base64,${Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("base64")}`;
}

function defaultInput(input: HarnessInput): unknown {
  if (input.type === "text") return { type: "text", text: input.text, text_elements: [] };
  if (input.type === "image") return { type: "image", url: dataUrl(input.mediaType, input.data) };
  const label = input.name ? `${input.name}: ${input.uri}` : input.uri;
  return { type: "text", text: label, text_elements: [] };
}

function contextText(input: HarnessInput): string {
  if (input.type === "text") return input.text;
  if (input.type === "resource") return input.name ? `${input.name}: ${input.uri}` : input.uri;
  return `[Image: ${input.name ?? input.mediaType}]`;
}

/** Keep trusted source instructions distinct from untrusted source content. */
export function codexAdditionalContext(
  request: Pick<HarnessAdapterRunRequest, "context">,
): Record<string, { kind: "application" | "untrusted"; value: string }> {
  const output: Record<string, { kind: "application" | "untrusted"; value: string }> = {};
  for (const source of request.context.sources) {
    const instructions = source.value.instructions?.trim();
    if (instructions) {
      output[`${source.sourceId}:instructions`] = { kind: "application", value: instructions };
    }
    const content = source.value.content.map(contextText).filter(Boolean).join("\n\n");
    if (content) output[`${source.sourceId}:content`] = { kind: "untrusted", value: content };
  }
  return output;
}

function dynamicToolContent(content: HarnessToolContent): { type: string; text?: string; imageUrl?: string } {
  if (content.type === "text") return { type: "inputText", text: content.text };
  if (content.type === "image") {
    const imageUrl = content.data.startsWith("data:")
      ? content.data
      : `data:${content.mediaType};base64,${content.data}`;
    return { type: "inputImage", imageUrl };
  }
  return { type: "inputText", text: content.text ?? content.uri };
}

/** Translate an application-owned tool result into the App Server response. */
export function codexDynamicToolResult(result: HarnessToolResult): Record<string, unknown> {
  return {
    success: result.isError !== true,
    contentItems: result.content.map(dynamicToolContent),
  };
}

function hasUsage(usage: CodexAppServerTurnOutcome["usage"]): boolean {
  return Object.values(usage).some((value) => value !== undefined);
}

function discovery<T>(source: CodexAppServerDiscoverySource<T> | undefined, request: HarnessDiscoveryRequest) {
  return typeof source === "function" ? source(request) : source ?? { status: "unsupported" as const };
}

function defaultProfile(id: string): HarnessDiscovery<HarnessEngineProfile> {
  return {
    status: "available",
    value: {
      id,
      label: "Codex App Server",
      permissions: {
        kind: "host-policy",
        selectable: false,
        defaultModeId: "host",
        modes: [{ id: "host", label: "Managed by host", posture: "restricted" }],
        description: "The host application supplies the Codex sandbox and approval policy.",
      },
    },
  };
}

interface ActiveTurn {
  client: CodexAppServerClient;
  connection: CodexAppServerConnection;
  threadId: string | null;
  turnId: string | null;
  closed: boolean;
}

async function closeActive(active: ActiveTurn): Promise<void> {
  if (active.closed) return;
  active.closed = true;
  await active.connection.close();
}

/** Compose a real HarnessAdapter over a host-owned App Server connection. */
export function createCodexAppServerAdapter(options: CodexAppServerAdapterOptions): HarnessAdapter {
  const id = options.id ?? "codex";
  let observedLimits: HarnessLimitSnapshot | null = null;

  return {
    id,
    capabilities: () => options.capabilities ?? CODEX_APP_SERVER_CAPABILITIES,
    profile: (request) => discovery(options.profile ?? defaultProfile(id), request),
    models: (request) => discovery(options.models, request),
    limits: (request) => options.limits
      ? discovery(options.limits, request)
      : observedLimits
        ? { status: "available", value: observedLimits }
        : { status: "unsupported" },

    async open({ session, resumeToken }) {
      let checkpoint = resumeToken;
      let active: ActiveTurn | null = null;
      let closed = false;

      const adapterSession: HarnessAdapterSession = {
        async *run(request) {
          if (closed) throw new Error("the Codex adapter session is closed");
          if (active !== null) throw new Error("the Codex adapter session is already running");

          const queue = new AdapterEventQueue();
          const settled = deferred<
            | { kind: "terminal"; outcome: CodexAppServerTurnOutcome }
            | { kind: "transport"; error?: unknown }
          >();
          let terminal = false;
          let publicFailure: Extract<HarnessAdapterEvent, { kind: "error" }> | null = null;

          const connectRequest: CodexAppServerConnectRequest = {
            session,
            resumeToken: checkpoint,
            runId: request.runId,
            turnId: request.turnId,
            ...(request.accountId ? { accountId: request.accountId } : {}),
            ...(request.configuration ? { configuration: request.configuration } : {}),
            signal: request.signal,
          };

          const execute = async (): Promise<void> => {
            const connection = await options.connect(connectRequest);
            let consumer!: ReturnType<typeof createCodexAppServerEventConsumer>;
            const client = createCodexAppServerClient({
              write: (line) => connection.write(line),
              hooks: {
                notification: (method, params) => consumer.notification(method, params),
                async request(method, params) {
                  if (method !== "item/tool/call") {
                    return { error: { code: -32601, message: "this adapter answers only dynamic tool calls" } };
                  }
                  const value = record(params);
                  const name = nonEmpty(value.tool);
                  if (name === null) {
                    return { error: { code: -32602, message: "the dynamic tool call named no tool" } };
                  }
                  const result = await request.tools.call(name, value.arguments);
                  return { result: codexDynamicToolResult(result) };
                },
              },
            });
            const current: ActiveTurn = {
              client,
              connection,
              threadId: null,
              turnId: null,
              closed: false,
            };
            active = current;

            consumer = createCodexAppServerEventConsumer({
              ...options.events,
              emit(event) {
                if (event.kind === "error") publicFailure = event;
                else queue.push(event);
              },
              onTurnEnded(outcome) {
                if (terminal) return;
                terminal = true;
                settled.resolve({ kind: "terminal", outcome });
              },
              onLimits(snapshot) {
                observedLimits = snapshot;
                options.onLimits?.(snapshot, connectRequest);
              },
            });

            const decoder = new TextDecoder();
            const outputDone = (async () => {
              let failure: unknown;
              try {
                for await (const chunk of connection.output) {
                  client.text(typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true }));
                }
                const tail = decoder.decode();
                if (tail) client.text(tail);
              } catch (error) {
                failure = error;
              } finally {
                consumer.end(request.signal.aborted ? "cancelled" : "failed");
                client.end();
                if (!terminal) settled.resolve({ kind: "transport", ...(failure === undefined ? {} : { error: failure }) });
              }
            })();

            try {
              await client.initialize(codexInitializeParams({
                clientInfo: options.clientInfo,
                ...options.initialize,
              }));
              client.initialized();

              const policy = await options.thread(request);
              const opened = checkpoint === null
                ? await client.startThread(codexThreadStartParams({
                    ...policy,
                    dynamicTools: codexDynamicTools(request.tools.list()),
                  }))
                : await client.resumeThread(codexThreadResumeParams({
                    ...policy,
                    threadId: checkpoint,
                    excludeTurns: options.excludeTurnsOnResume ?? true,
                  }));
              const threadId = nonEmpty(record(opened.thread).id);
              if (threadId === null) throw new Error("the Codex App Server named no thread");
              current.threadId = threadId;

              const input = request.input.flatMap((item) => asArray(
                options.mapInput?.(item, request) ?? defaultInput(item),
              ));
              const additionalContext = codexAdditionalContext(request);
              const turn = await client.startTurn({
                threadId,
                input,
                ...(Object.keys(additionalContext).length > 0 ? { additionalContext } : {}),
                ...(request.model ? { model: request.model } : {}),
                ...(request.effort ? { effort: request.effort } : {}),
                ...codexTurnSettingOverrides(request.settings),
              });
              const turnId = nonEmpty(record(turn.turn).id);
              if (turnId === null) throw new Error("the Codex App Server named no turn");
              current.turnId = turnId;
              // A thread becomes resumable only after the provider accepted its turn.
              checkpoint = threadId;

              const end = await settled.promise;
              if (end.kind === "transport") {
                if (end.error !== undefined) throw end.error;
                throw new Error("the Codex App Server transport ended before the turn completed");
              }
              if (hasUsage(end.outcome.usage)) queue.push({ kind: "usage", usage: end.outcome.usage });
              queue.close();
              if (end.outcome.status === "interrupted") throw new HarnessAdapterInterruptedError();
              if (end.outcome.status === "error") {
                const failure = publicFailure;
                if (failure !== null) {
                  throw new HarnessAdapterError(failure.code, failure.message, failure.retryable ?? false);
                }
                throw new Error("the Codex provider failed without a public error");
              }
            } finally {
              queue.close();
              await closeActive(current);
              await outputDone;
              if (active === current) active = null;
            }
          };

          const execution = execute().catch((error) => {
            queue.close();
            throw error;
          });
          let executionFailure: unknown;
          try {
            for await (const event of queue) yield event;
            await execution;
          } catch (error) {
            executionFailure = error;
          } finally {
            // If a consumer stops reading, still release the provider connection.
            if (active !== null) await closeActive(active);
            await execution.catch(() => undefined);
          }
          if (executionFailure !== undefined) throw executionFailure;
        },

        async cancel() {
          const current = active;
          if (current === null) return;
          try {
            if (current.threadId !== null && current.turnId !== null) {
              await current.client.interruptTurn({
                threadId: current.threadId,
                turnId: current.turnId,
              });
            }
          } finally {
            await closeActive(current);
          }
        },

        checkpoint: () => checkpoint,

        async close() {
          if (closed) return;
          closed = true;
          if (active !== null) await closeActive(active);
        },
      };
      return adapterSession;
    },
  };
}
