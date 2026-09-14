/**
 * A provider-injected Claude Agent SDK adapter.
 *
 * The host owns process creation, credentials, environment, tool policy, and
 * sandbox configuration. This module owns the long-lived provider stream,
 * turn routing, interactions, checkpoints, and harness event normalization.
 */

import type { HarnessPreparedContext } from "../context.js";
import type {
  HarnessDiscovery,
  HarnessDiscoveryRequest,
  HarnessEngineProfile,
  HarnessLimitSnapshot,
  HarnessModelCatalog,
  HarnessRunSettings,
} from "../profile.js";
import type {
  HarnessCapabilities,
  HarnessInput,
  HarnessInteraction,
  HarnessInteractionResponse,
  HarnessSessionKey,
} from "../protocol.js";
import {
  HarnessAdapterError,
  HarnessAdapterInterruptedError,
  type HarnessAdapter,
  type HarnessAdapterEvent,
  type HarnessAdapterRunRequest,
  type HarnessAdapterSession,
} from "../runtime.js";
import type { HarnessToolDescriptor, HarnessToolResult, HarnessTurnTools } from "../tools.js";
import {
  CLAUDE_AGENT_SDK_NAMESPACE,
  createClaudeAgentSdkEventConsumer,
  type ClaudeAgentSdkEventConsumerOptions,
  type ClaudeAgentSdkPublicError,
  type ClaudeAgentSdkTurnOutcome,
} from "./claude-agent-sdk-events.js";

export interface ClaudeAgentSdkContextContribution {
  instructions?: string;
  content: readonly HarnessInput[];
}

export interface ClaudeAgentSdkTurnInput {
  runId: string;
  turnId: string;
  input: readonly HarnessInput[];
  /** Provider-visible context. Application-only source state is removed. */
  context: HarnessPreparedContext<ClaudeAgentSdkContextContribution>;
  configuration?: Readonly<Record<string, unknown>>;
}

export interface ClaudeAgentSdkToolRequest {
  toolName: string;
  input: Readonly<Record<string, unknown>>;
  toolUseId?: string;
  agentId?: string;
}

export type ClaudeAgentSdkToolDecision =
  | { behavior: "allow"; updatedInput?: Readonly<Record<string, unknown>> }
  | { behavior: "deny"; message?: string };

export interface ClaudeAgentSdkDeferredAuthorization {
  behavior: "ask";
  interaction: HarnessInteraction;
  resolve(
    response: HarnessInteractionResponse,
  ): Promise<ClaudeAgentSdkToolDecision> | ClaudeAgentSdkToolDecision;
}

export type ClaudeAgentSdkToolAuthorization =
  | ClaudeAgentSdkToolDecision
  | ClaudeAgentSdkDeferredAuthorization;

export interface ClaudeAgentSdkConnection {
  /** Complete provider messages. SDK types stay behind the host implementation. */
  messages: AsyncIterable<unknown>;
  send(input: ClaudeAgentSdkTurnInput): Promise<void> | void;
  interrupt(): Promise<void> | void;
  /** Must make `messages` settle and release the host-owned provider process. */
  close(): Promise<void> | void;
  stopSubagent?(taskId: string): Promise<void> | void;
}

export interface ClaudeAgentSdkConnectRequest {
  session: HarnessSessionKey;
  resumeToken: string | null;
  runId: string;
  turnId: string;
  model?: string;
  effort?: string;
  accountId?: string;
  settings?: HarnessRunSettings;
  configuration?: Readonly<Record<string, unknown>>;
  /** Ends only when the adapter session closes, not after its first turn. */
  signal: AbortSignal;
  tools: HarnessTurnTools;
  canUseTool(request: ClaudeAgentSdkToolRequest): Promise<ClaudeAgentSdkToolDecision>;
  /** A host PostCompact hook reports the provider-authored summary here. */
  noteCompactSummary(summary: string): void;
}

export type ClaudeAgentSdkDiscoverySource<T> =
  | HarnessDiscovery<T>
  | ((request: HarnessDiscoveryRequest) => Promise<HarnessDiscovery<T>> | HarnessDiscovery<T>);

export interface ClaudeAgentSdkAdapterOptions {
  id?: string;
  capabilities?: HarnessCapabilities;
  profile?: ClaudeAgentSdkDiscoverySource<HarnessEngineProfile>;
  models?: ClaudeAgentSdkDiscoverySource<HarnessModelCatalog>;
  limits?: ClaudeAgentSdkDiscoverySource<HarnessLimitSnapshot>;
  /** Create one explicit, isolated SDK session when its first turn starts. */
  connect(
    request: ClaudeAgentSdkConnectRequest,
  ): Promise<ClaudeAgentSdkConnection> | ClaudeAgentSdkConnection;
  /** Change the SDK-free value passed to the injected connection. */
  mapInput?(
    request: HarnessAdapterRunRequest,
  ): Promise<ClaudeAgentSdkTurnInput> | ClaudeAgentSdkTurnInput;
  /** Decide immediately or defer a provider permission request to the host UI. */
  authorizeTool?(
    request: ClaudeAgentSdkToolRequest,
    turn: HarnessAdapterRunRequest,
  ): Promise<ClaudeAgentSdkToolAuthorization> | ClaudeAgentSdkToolAuthorization;
  events?: Omit<
    ClaudeAgentSdkEventConsumerOptions,
    "emit" | "onTurnEnded" | "onCheckpoint" | "onLimits" | "takeCompactSummary" | "wasDeclined"
  >;
  onLimits?(
    snapshot: HarnessLimitSnapshot,
    request: Pick<ClaudeAgentSdkConnectRequest, "session" | "accountId" | "runId" | "turnId">,
  ): void;
  /** Persist a resume checkpoint as soon as the provider announces it. */
  onCheckpoint?(
    checkpoint: string,
    request: Pick<ClaudeAgentSdkConnectRequest, "session" | "accountId" | "runId" | "turnId">,
  ): Promise<void> | void;
  /** Bound a provider that acknowledges interrupt but never ends the turn. */
  interruptTimeoutMs?: number;
}

export interface ClaudeAgentSdkAdapterSession extends HarnessAdapterSession {
  cancel(): Promise<void>;
  checkpoint(): string | null;
  close(): Promise<void>;
  stopSubagent(taskId: string): Promise<boolean>;
}

export interface ClaudeAgentSdkAdapter extends HarnessAdapter {
  open(request: { session: HarnessSessionKey; resumeToken: string | null }): Promise<ClaudeAgentSdkAdapterSession>;
}

const unsupported = { support: "unsupported" as const };

/** Conservative capabilities of the injected adapter itself. */
export const CLAUDE_AGENT_SDK_CAPABILITIES: HarnessCapabilities = {
  resume: { support: "stable" },
  cancel: { support: "stable" },
  interactions: { support: "stable" },
  tools: { support: "stable" },
  images: { support: "stable" },
  thinking: { support: "stable" },
  plans: { support: "stable" },
  usage: { support: "stable" },
  subagents: { support: "stable" },
  shell: unsupported,
  filesystem: unsupported,
  network: unsupported,
  extensions: {
    [CLAUDE_AGENT_SDK_NAMESPACE]: { support: "stable" },
    "anthropic:compaction": { support: "stable" },
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

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function discovery<T>(source: ClaudeAgentSdkDiscoverySource<T> | undefined, request: HarnessDiscoveryRequest) {
  return typeof source === "function" ? source(request) : source ?? { status: "unsupported" as const };
}

function defaultProfile(id: string): HarnessDiscovery<HarnessEngineProfile> {
  return {
    status: "available",
    value: {
      id,
      label: "Claude Agent SDK",
      permissions: {
        kind: "host-policy",
        selectable: false,
        defaultModeId: "host",
        modes: [{ id: "host", label: "Managed by host", posture: "restricted" }],
        description: "The host application supplies Claude's tool and sandbox policy.",
      },
    },
  };
}

function defaultTurnInput(request: HarnessAdapterRunRequest): ClaudeAgentSdkTurnInput {
  return {
    runId: request.runId,
    turnId: request.turnId,
    input: request.input,
    context: {
      sources: request.context.sources.map((source) => ({
        sourceId: source.sourceId,
        value: {
          ...(source.value.instructions ? { instructions: source.value.instructions } : {}),
          content: source.value.content,
        },
      })),
      unavailable: request.context.unavailable,
    },
    ...(request.configuration ? { configuration: request.configuration } : {}),
  };
}

function applicationToolFailure(code: string, message: string): HarnessToolResult {
  return { content: [{ type: "text", text: message }], isError: true, code };
}

function checkpointRequest(
  request: ClaudeAgentSdkConnectRequest,
): Pick<ClaudeAgentSdkConnectRequest, "session" | "accountId" | "runId" | "turnId"> {
  return {
    session: request.session,
    ...(request.accountId ? { accountId: request.accountId } : {}),
    runId: request.runId,
    turnId: request.turnId,
  };
}

function publicAdapterError(error: ClaudeAgentSdkPublicError): HarnessAdapterError {
  return new HarnessAdapterError(error.code, error.message, error.retryable === true);
}

interface PendingInteraction {
  queue: AdapterEventQueue;
  authorization: ClaudeAgentSdkDeferredAuthorization;
  settle(decision: ClaudeAgentSdkToolDecision): void;
  request: ClaudeAgentSdkToolRequest;
}

interface ActiveTurn {
  request: HarnessAdapterRunRequest;
  queue: AdapterEventQueue;
  consumer: ReturnType<typeof createClaudeAgentSdkEventConsumer>;
  settled: ReturnType<typeof deferred<
    | { kind: "terminal"; outcome: ClaudeAgentSdkTurnOutcome }
    | { kind: "transport"; error?: unknown }
    | { kind: "interrupted" }
  >>;
  publicFailure: ClaudeAgentSdkPublicError | null;
  finished: boolean;
  cancelling: Promise<void> | null;
}

/** Compose a real HarnessAdapter over a host-owned Agent SDK connection. */
export function createClaudeAgentSdkAdapter(options: ClaudeAgentSdkAdapterOptions): ClaudeAgentSdkAdapter {
  const id = options.id ?? "claude";
  const interruptTimeoutMs = options.interruptTimeoutMs ?? 2_000;
  if (!Number.isFinite(interruptTimeoutMs) || interruptTimeoutMs < 1) {
    throw new Error("interruptTimeoutMs must be a positive number");
  }
  const observedLimits = new Map<string, Map<string, HarnessLimitSnapshot["limits"][number]>>();

  return {
    id,
    capabilities: () => options.capabilities ?? CLAUDE_AGENT_SDK_CAPABILITIES,
    profile: (request) => discovery(options.profile ?? defaultProfile(id), request),
    models: (request) => discovery(options.models, request),
    limits: (request) => {
      if (options.limits) return discovery(options.limits, request);
      const limits = observedLimits.get(request.accountId ?? "");
      return limits && limits.size > 0
        ? { status: "available", value: { limits: [...limits.values()] } }
        : { status: "unsupported" };
    },

    async open({ session, resumeToken }) {
      let checkpoint = resumeToken;
      let active: ActiveTurn | null = null;
      let connection: ClaudeAgentSdkConnection | null = null;
      let connecting: Promise<ClaudeAgentSdkConnection> | null = null;
      let consuming: Promise<void> | null = null;
      let streamEnded = false;
      let streamFailure: unknown;
      let closed = false;
      let closing: Promise<void> | null = null;
      let compactSummary: string | null = null;
      let checkpointWork = Promise.resolve();
      const declined = new Set<string>();
      const pending = new Map<string, PendingInteraction>();
      const lifetime = new AbortController();

      const closePending = (turn: ActiveTurn | null): void => {
        for (const [id, value] of pending) {
          if (turn !== null && value.queue !== turn.queue) continue;
          pending.delete(id);
          value.queue.push({
            kind: "interaction-resolved",
            interactionId: id,
            response: { choiceId: "cancelled" },
          });
          value.settle({ behavior: "deny", message: "The turn ended before the interaction was answered." });
        }
      };

      const tools: HarnessTurnTools = {
        list(): readonly HarnessToolDescriptor[] {
          return active?.request.tools.list() ?? [];
        },
        call(name, input): Promise<HarnessToolResult> {
          if (!active) {
            return Promise.resolve(applicationToolFailure("TOOL_TURN_ENDED", "The tool's turn has ended."));
          }
          return active.request.tools.call(name, input);
        },
      };

      const canUseTool = async (request: ClaudeAgentSdkToolRequest): Promise<ClaudeAgentSdkToolDecision> => {
        const turn = active;
        if (!turn || turn.finished) {
          return { behavior: "deny", message: "That turn has ended. Do not continue it." };
        }
        let authorization: ClaudeAgentSdkToolAuthorization;
        try {
          authorization = await options.authorizeTool?.(request, turn.request)
            ?? { behavior: "deny", message: "The host did not authorize this tool." };
        } catch {
          authorization = { behavior: "deny", message: "The host could not authorize this tool." };
        }
        if (authorization.behavior === "deny") {
          if (request.toolUseId) declined.add(request.toolUseId);
          return authorization;
        }
        if (authorization.behavior === "allow") {
          return {
            behavior: "allow",
            updatedInput: authorization.updatedInput ?? request.input,
          };
        }
        const id = authorization.interaction.id;
        if (!id || pending.has(id)) {
          if (request.toolUseId) declined.add(request.toolUseId);
          return { behavior: "deny", message: "The host supplied an invalid interaction." };
        }
        turn.queue.push({ kind: "interaction-requested", interaction: authorization.interaction });
        return new Promise<ClaudeAgentSdkToolDecision>((resolve) => {
          pending.set(id, {
            queue: turn.queue,
            authorization,
            request,
            settle: resolve,
          });
        });
      };

      const consume = async (value: ClaudeAgentSdkConnection): Promise<void> => {
        try {
          for await (const message of value.messages) active?.consumer.message(message);
        } catch (error) {
          streamFailure = error;
        } finally {
          streamEnded = true;
          const turn = active;
          if (turn && !turn.finished) {
            turn.consumer.end("cancelled");
            turn.queue.close();
            turn.settled.resolve({ kind: "transport", ...(streamFailure === undefined ? {} : { error: streamFailure }) });
          }
        }
      };

      const connect = async (request: HarnessAdapterRunRequest): Promise<ClaudeAgentSdkConnection> => {
        if (connection) return connection;
        if (streamEnded) throw streamFailure ?? new Error("the Claude provider stream ended");
        if (!connecting) {
          const connectRequest: ClaudeAgentSdkConnectRequest = {
            session,
            resumeToken: checkpoint,
            runId: request.runId,
            turnId: request.turnId,
            ...(request.model ? { model: request.model } : {}),
            ...(request.effort ? { effort: request.effort } : {}),
            ...(request.accountId ? { accountId: request.accountId } : {}),
            ...(request.settings ? { settings: request.settings } : {}),
            ...(request.configuration ? { configuration: request.configuration } : {}),
            signal: lifetime.signal,
            tools,
            canUseTool,
            noteCompactSummary(summary) {
              compactSummary = summary;
            },
          };
          const pendingConnection = Promise.resolve().then(() => options.connect(connectRequest));
          connecting = new Promise<ClaudeAgentSdkConnection>((resolve, reject) => {
            let interrupted = false;
            const abort = (): void => {
              if (interrupted) return;
              interrupted = true;
              request.signal.removeEventListener("abort", abort);
              void pendingConnection.then((late) => late.close()).catch(() => undefined);
              reject(new HarnessAdapterInterruptedError());
            };
            request.signal.addEventListener("abort", abort, { once: true });
            if (request.signal.aborted) abort();
            void pendingConnection.then(
              (opened) => {
                if (interrupted) return;
                request.signal.removeEventListener("abort", abort);
                resolve(opened);
              },
              (error: unknown) => {
                if (interrupted) return;
                request.signal.removeEventListener("abort", abort);
                reject(error);
              },
            );
          });
        }
        try {
          connection = await connecting;
        } catch (error) {
          connecting = null;
          throw error;
        }
        consuming = consume(connection);
        return connection;
      };

      const adapterSession: ClaudeAgentSdkAdapterSession = {
        async *run(request) {
          if (closed) throw new Error("the Claude adapter session is closed");
          if (active !== null) throw new Error("the Claude adapter session is already running");
          if (streamEnded) throw streamFailure ?? new Error("the Claude provider stream ended");
          declined.clear();
          const queue = new AdapterEventQueue();
          const settled = deferred<
            | { kind: "terminal"; outcome: ClaudeAgentSdkTurnOutcome }
            | { kind: "transport"; error?: unknown }
            | { kind: "interrupted" }
          >();
          const turn: ActiveTurn = {
            request,
            queue,
            consumer: undefined as never,
            settled,
            publicFailure: null,
            finished: false,
            cancelling: null,
          };
          const consumer = createClaudeAgentSdkEventConsumer({
            ...options.events,
            emit(event) {
              if (event.kind === "error") {
                turn.publicFailure = {
                  code: event.code,
                  message: event.message,
                  ...(event.retryable ? { retryable: true } : {}),
                };
              } else queue.push(event);
            },
            onTurnEnded(outcome) {
              if (turn.finished) return;
              turn.finished = true;
              queue.close();
              settled.resolve({ kind: "terminal", outcome });
            },
            onCheckpoint(value) {
              checkpoint = value;
              const requestValue: ClaudeAgentSdkConnectRequest = {
                session,
                resumeToken,
                runId: request.runId,
                turnId: request.turnId,
                ...(request.accountId ? { accountId: request.accountId } : {}),
                signal: lifetime.signal,
                tools,
                canUseTool,
                noteCompactSummary(summary) { compactSummary = summary; },
              };
              checkpointWork = checkpointWork.then(() => options.onCheckpoint?.(value, checkpointRequest(requestValue)));
            },
            onLimits(snapshot) {
              const account = request.accountId ?? "";
              let limits = observedLimits.get(account);
              if (!limits) {
                limits = new Map();
                observedLimits.set(account, limits);
              }
              for (const limit of snapshot.limits) limits.set(limit.id, limit);
              options.onLimits?.(snapshot, {
                session,
                ...(request.accountId ? { accountId: request.accountId } : {}),
                runId: request.runId,
                turnId: request.turnId,
              });
            },
            takeCompactSummary() {
              const summary = compactSummary;
              compactSummary = null;
              return summary;
            },
            wasDeclined: (id) => declined.has(id),
          });
          turn.consumer = consumer;
          active = turn;

          const execute = (async (): Promise<void> => {
            const opened = await connect(request);
            if (request.signal.aborted) throw new HarnessAdapterInterruptedError();
            const input = await (options.mapInput?.(request) ?? defaultTurnInput(request));
            await opened.send(input);
          })();
          void execute.catch((error: unknown) => {
            if (turn.finished) return;
            turn.finished = true;
            consumer.end("cancelled");
            queue.close();
            settled.resolve(
              error instanceof HarnessAdapterInterruptedError
                ? { kind: "interrupted" }
                : { kind: "transport", error },
            );
          });

          try {
            for await (const event of queue) yield event;
            const result = await settled.promise;
            await execute.catch(() => undefined);
            await checkpointWork;
            if (result.kind === "interrupted" || request.signal.aborted) {
              throw new HarnessAdapterInterruptedError();
            }
            if (result.kind === "transport") throw result.error ?? new Error("the Claude provider stream ended");
            if (result.outcome.status === "interrupted") throw new HarnessAdapterInterruptedError();
            if (result.outcome.status === "error") {
              throw turn.publicFailure
                ? publicAdapterError(turn.publicFailure)
                : new HarnessAdapterError("CLAUDE_PROVIDER_ERROR", "Claude could not complete the turn.");
            }
          } finally {
            closePending(turn);
            turn.finished = true;
            if (active === turn) active = null;
          }
        },
        async respond(interactionId, response) {
          const held = pending.get(interactionId);
          if (!held) throw new Error("unknown Claude interaction");
          pending.delete(interactionId);
          let decision: ClaudeAgentSdkToolDecision;
          try {
            decision = await held.authorization.resolve(response);
          } catch {
            decision = { behavior: "deny", message: "The host could not resolve this interaction." };
          }
          if (decision.behavior === "deny" && held.request.toolUseId) declined.add(held.request.toolUseId);
          if (decision.behavior === "allow") {
            decision = { behavior: "allow", updatedInput: decision.updatedInput ?? held.request.input };
          }
          held.queue.push({ kind: "interaction-resolved", interactionId, response });
          held.settle(decision);
        },
        async cancel() {
          const turn = active;
          if (!turn || turn.finished) return;
          if (turn.cancelling) return turn.cancelling;
          turn.cancelling = (async () => {
            closePending(turn);
            if (!connection) {
              turn.finished = true;
              turn.consumer.end("cancelled");
              turn.queue.close();
              turn.settled.resolve({ kind: "interrupted" });
              return;
            }
            await Promise.resolve(connection.interrupt()).catch(() => undefined);
            let timer: ReturnType<typeof setTimeout> | undefined;
            const ended = await Promise.race([
              turn.settled.promise.then(() => true),
              new Promise<boolean>((resolve) => {
                timer = setTimeout(() => resolve(false), interruptTimeoutMs);
                timer.unref?.();
              }),
            ]);
            if (timer !== undefined) clearTimeout(timer);
            if (ended || turn.finished) return;
            turn.finished = true;
            turn.consumer.end("cancelled");
            turn.queue.close();
            turn.settled.resolve({ kind: "interrupted" });
            await Promise.resolve(connection.close()).catch(() => undefined);
          })();
          return turn.cancelling;
        },
        checkpoint: () => checkpoint,
        async stopSubagent(taskId) {
          const stop = connection?.stopSubagent;
          if (!stop || !active || active.finished) return false;
          try {
            await stop.call(connection, taskId);
            return true;
          } catch {
            return false;
          }
        },
        async close() {
          if (closing) return closing;
          closing = (async () => {
            if (closed) return;
            closed = true;
            lifetime.abort();
            await adapterSession.cancel();
            closePending(null);
            if (connection) await connection.close();
            await consuming?.catch(() => undefined);
          })();
          return closing;
        },
      };
      return adapterSession;
    },
  };
}
