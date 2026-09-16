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
  HarnessInlineContext,
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
  type HarnessAdapterFollowUpRequest,
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
  inlineContext?: HarnessInlineContext;
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
  /** Clock used to timestamp limits observed on the provider stream. */
  now?: () => Date;
  /** Create one explicit, isolated SDK session when its first turn starts. */
  connect(
    request: ClaudeAgentSdkConnectRequest,
  ): Promise<ClaudeAgentSdkConnection> | ClaudeAgentSdkConnection;
  /**
   * Select the provider configuration that fixes a connection's identity.
   * Account, model, effort, and run settings are always included. By default,
   * the complete `configuration` object is included too.
   */
  connectionKey?(request: HarnessAdapterRunRequest): unknown;
  /** Change the SDK-free value passed to the injected connection. */
  mapInput?(
    request: HarnessAdapterRunRequest,
  ): Promise<ClaudeAgentSdkTurnInput> | ClaudeAgentSdkTurnInput;
  /** Map input injected into an already-running provider turn. */
  mapFollowUp?(
    request: HarnessAdapterFollowUpRequest,
    turn: HarnessAdapterRunRequest,
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
  steer(request: HarnessAdapterFollowUpRequest): Promise<void>;
  cancel(): Promise<void>;
  checkpoint(): string | null;
  close(): Promise<void>;
  stopSubagent(taskId: string): Promise<boolean>;
}

export interface ClaudeAgentSdkAdapter extends HarnessAdapter {
  open(request: {
    session: HarnessSessionKey;
    resumeToken: string | null;
    persistCheckpoint?(resumeToken: string | null): Promise<void>;
  }): Promise<ClaudeAgentSdkAdapterSession>;
}

const unsupported = { support: "unsupported" as const };

/** Persisted token format understood by the native Claude adapter. */
export const CLAUDE_AGENT_SDK_CHECKPOINT_FORMAT = "anthropic:claude-agent-sdk/session-id@1";

/** Conservative capabilities of the injected adapter itself. */
export const CLAUDE_AGENT_SDK_CAPABILITIES: HarnessCapabilities = {
  resume: { support: "stable" },
  cancel: { support: "stable" },
  interactions: { support: "stable", recovery: "live-only" },
  tools: { support: "stable" },
  images: { support: "stable" },
  thinking: { support: "stable" },
  plans: { support: "stable" },
  usage: { support: "stable" },
  subagents: { support: "stable" },
  shell: unsupported,
  filesystem: unsupported,
  network: unsupported,
  steering: {
    support: "stable",
    strategies: ["same-turn"],
    preferred: "same-turn",
    description: "Injects another user message into the active Claude Agent SDK stream.",
    constraints: { whileInteractionPending: false },
  },
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
      inputPolicy: {
        modalities: {
          text: { support: "stable" },
          image: { support: "stable" },
          resource: { support: "stable" },
          "context-reference": { support: "stable" },
        },
      },
    },
  };
}

function defaultTurnInput(request: HarnessAdapterRunRequest): ClaudeAgentSdkTurnInput {
  return {
    runId: request.runId,
    turnId: request.turnId,
    input: request.input,
    ...(request.inlineContext ? { inlineContext: request.inlineContext } : {}),
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

function defaultFollowUpInput(
  request: HarnessAdapterFollowUpRequest,
  turn: HarnessAdapterRunRequest,
): ClaudeAgentSdkTurnInput {
  return {
    runId: request.runId,
    turnId: request.turnId,
    input: request.input,
    ...(request.inlineContext ? { inlineContext: request.inlineContext } : {}),
    // Same-turn follow-ups inherit the context already installed for the
    // active turn. Repeating it would duplicate untrusted workspace data.
    context: { sources: [], unavailable: [] },
    ...(turn.configuration ? { configuration: turn.configuration } : {}),
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
  authorization: ClaudeAgentSdkDeferredAuthorization;
  settle(decision: ClaudeAgentSdkToolDecision): void;
  request: ClaudeAgentSdkToolRequest;
  turn: ActiveTurn;
  resolving: boolean;
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
  sendTail: Promise<void>;
}

function canonical(value: unknown, seen = new Set<object>()): string {
  if (value === null) return "null";
  if (typeof value === "string") return `string:${JSON.stringify(value)}`;
  if (typeof value === "boolean") return `boolean:${value}`;
  if (typeof value === "number") {
    return `number:${Object.is(value, -0) ? "-0" : String(value)}`;
  }
  if (typeof value === "bigint") return `bigint:${value}`;
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error("Claude connection identity must be serializable");
    seen.add(value);
    const output = `array:[${value.map((entry) => canonical(entry, seen)).join(",")}]`;
    seen.delete(value);
    return output;
  }
  if (typeof value === "object") {
    if (seen.has(value)) throw new Error("Claude connection identity must be serializable");
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("Claude connection identity must be serializable");
    }
    seen.add(value);
    const output = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key], seen)}`)
      .join(",");
    seen.delete(value);
    return `object:{${output}}`;
  }
  throw new Error("Claude connection identity must be serializable");
}

function connectionIdentity(
  request: HarnessAdapterRunRequest,
  providerConfiguration: unknown,
): string {
  return canonical({
    accountId: request.accountId ?? null,
    model: request.model ?? null,
    effort: request.effort ?? null,
    settings: request.settings ?? null,
    providerConfiguration,
  });
}

/** Compose a real HarnessAdapter over a host-owned Agent SDK connection. */
export function createClaudeAgentSdkAdapter(options: ClaudeAgentSdkAdapterOptions): ClaudeAgentSdkAdapter {
  const id = options.id ?? "claude";
  const interruptTimeoutMs = options.interruptTimeoutMs ?? 2_000;
  if (!Number.isFinite(interruptTimeoutMs) || interruptTimeoutMs < 1) {
    throw new Error("interruptTimeoutMs must be a positive number");
  }
  const now = options.now ?? (() => new Date());
  const observedLimits = new Map<string, {
    limits: Map<string, HarnessLimitSnapshot["limits"][number]>;
    fetchedAt: string;
  }>();

  return {
    id,
    checkpoint: { format: CLAUDE_AGENT_SDK_CHECKPOINT_FORMAT },
    capabilities: () => options.capabilities ?? CLAUDE_AGENT_SDK_CAPABILITIES,
    profile: (request) => discovery(options.profile ?? defaultProfile(id), request),
    models: (request) => discovery(options.models, request),
    limits: (request) => {
      if (options.limits) return discovery(options.limits, request);
      const observed = observedLimits.get(request.accountId ?? "");
      return observed && observed.limits.size > 0
        ? {
            status: "available",
            value: { limits: [...observed.limits.values()] },
            fetchedAt: observed.fetchedAt,
          }
        : { status: "unsupported" };
    },

    async open({ session, resumeToken, persistCheckpoint }) {
      let checkpoint = resumeToken;
      let active: ActiveTurn | null = null;
      let connection: ClaudeAgentSdkConnection | null = null;
      let connecting: Promise<ClaudeAgentSdkConnection> | null = null;
      let connectionBinding: string | null = null;
      let connectionAccountId: string | undefined;
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
          if (turn !== null && value.turn !== turn) continue;
          pending.delete(id);
          value.turn.queue.push({
            kind: "interaction-invalidated",
            interactionId: id,
            reason: "turn-ended",
          });
          value.settle({ behavior: "deny", message: "The turn ended before the interaction was answered." });
        }
      };

      const hasPending = (turn: ActiveTurn): boolean =>
        [...pending.values()].some((value) => value.turn === turn);

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
            authorization,
            request,
            settle: resolve,
            turn,
            resolving: false,
          });
        });
      };

      const consume = async (value: ClaudeAgentSdkConnection): Promise<void> => {
        try {
          for await (const message of value.messages) {
            const turn = active;
            if (turn && !turn.finished) turn.consumer.message(message);
          }
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

      const connect = async (
        request: HarnessAdapterRunRequest,
        requestedBinding: string,
      ): Promise<ClaudeAgentSdkConnection> => {
        if (connection) return connection;
        if (streamEnded) throw streamFailure ?? new Error("the Claude provider stream ended");
        if (!connecting) {
          connectionBinding = requestedBinding;
          connectionAccountId = request.accountId;
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
            const cleanup = (): void => {
              request.signal.removeEventListener("abort", abort);
              lifetime.signal.removeEventListener("abort", abort);
            };
            const abort = (): void => {
              if (interrupted) return;
              interrupted = true;
              cleanup();
              void pendingConnection.then((late) => late.close()).catch(() => undefined);
              reject(new HarnessAdapterInterruptedError());
            };
            request.signal.addEventListener("abort", abort, { once: true });
            lifetime.signal.addEventListener("abort", abort, { once: true });
            if (request.signal.aborted || lifetime.signal.aborted) abort();
            void pendingConnection.then(
              (opened) => {
                if (interrupted) return;
                cleanup();
                resolve(opened);
              },
              (error: unknown) => {
                if (interrupted) return;
                cleanup();
                reject(error);
              },
            );
          });
        }
        try {
          connection = await connecting;
        } catch (error) {
          connecting = null;
          connectionBinding = null;
          connectionAccountId = undefined;
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
          const requestedBinding = connectionIdentity(
            request,
            options.connectionKey ? options.connectionKey(request) : request.configuration ?? null,
          );
          if (connectionBinding !== null && connectionBinding !== requestedBinding) {
            throw new HarnessAdapterError(
              "CLAUDE_SESSION_CONFIGURATION_CHANGED",
              "Claude session settings changed. Start a new harness session.",
            );
          }
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
            sendTail: Promise.resolve(),
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
              checkpointWork = checkpointWork
                .then(() => persistCheckpoint?.(value))
                .then(() => options.onCheckpoint?.(value, checkpointRequest(requestValue)));
            },
            onLimits(snapshot) {
              const account = connectionAccountId ?? "";
              const fetchedAt = now().toISOString();
              let observed = observedLimits.get(account);
              if (!observed) {
                observed = { limits: new Map(), fetchedAt };
                observedLimits.set(account, observed);
              }
              for (const limit of snapshot.limits) observed.limits.set(limit.id, limit);
              observed.fetchedAt = fetchedAt;
              options.onLimits?.(snapshot, {
                session,
                ...(connectionAccountId ? { accountId: connectionAccountId } : {}),
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
            const opened = await connect(request, requestedBinding);
            if (request.signal.aborted) throw new HarnessAdapterInterruptedError();
            const input = await (options.mapInput?.(request) ?? defaultTurnInput(request));
            try {
              await opened.send(input);
            } catch (error) {
              // `send` may have started provider work before rejecting. Its
              // stream can no longer be assigned safely to another turn.
              streamFailure = error;
              streamEnded = true;
              if (connection === opened) connection = null;
              connecting = null;
              void Promise.resolve(opened.close()).catch(() => undefined);
              throw error;
            }
          })();
          turn.sendTail = execute;
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
        async steer(followUp) {
          const turn = active;
          if (
            !turn
            || turn.finished
            || turn.cancelling
            || turn.request.signal.aborted
            || followUp.signal.aborted
          ) {
            throw new HarnessAdapterError(
              "CLAUDE_TURN_NOT_STEERABLE",
              "Claude is not ready to accept a follow-up for this turn.",
              true,
            );
          }
          if (
            followUp.expectedTurnId !== turn.request.turnId
            || followUp.turnId !== turn.request.turnId
            || followUp.runId !== turn.request.runId
          ) {
            throw new HarnessAdapterError("CLAUDE_STALE_TURN", "The active Claude turn changed before the follow-up was sent.");
          }
          if (hasPending(turn)) {
            throw new HarnessAdapterError(
              "CLAUDE_INTERACTION_PENDING",
              "Answer the pending Claude request before sending a follow-up.",
              true,
            );
          }
          const sending = turn.sendTail.then(async () => {
            if (
              active !== turn
              || turn.finished
              || turn.cancelling
              || turn.request.signal.aborted
              || followUp.signal.aborted
              || hasPending(turn)
            ) {
              throw new HarnessAdapterError(
                "CLAUDE_TURN_NOT_STEERABLE",
                "Claude is not ready to accept a follow-up for this turn.",
                true,
              );
            }
            const opened = connection;
            if (!opened) {
              throw new HarnessAdapterError(
                "CLAUDE_TURN_NOT_STEERABLE",
                "Claude is not ready to accept a follow-up for this turn.",
                true,
              );
            }
            const input = await (
              options.mapFollowUp?.(followUp, turn.request)
              ?? defaultFollowUpInput(followUp, turn.request)
            );
            if (
              active !== turn
              || turn.finished
              || turn.cancelling
              || turn.request.signal.aborted
              || followUp.signal.aborted
              || hasPending(turn)
            ) {
              throw new HarnessAdapterError(
                "CLAUDE_TURN_NOT_STEERABLE",
                "Claude is not ready to accept a follow-up for this turn.",
                true,
              );
            }
            try {
              await opened.send(input);
            } catch (error) {
              // A rejected send may already have reached the provider. Retire
              // this connection so its stream can never be assigned to a
              // later runtime turn.
              streamFailure = error;
              streamEnded = true;
              if (connection === opened) connection = null;
              connecting = null;
              turn.finished = true;
              turn.consumer.end("failed");
              turn.queue.close();
              turn.settled.resolve({ kind: "transport", error });
              void Promise.resolve(opened.close()).catch(() => undefined);
              throw error;
            }
          });
          turn.sendTail = sending;
          await sending;
        },
        async respond(interactionId, response) {
          const held = pending.get(interactionId);
          if (!held || held.resolving) {
            throw new HarnessAdapterError(
              "INTERACTION_NOT_ACTIVE",
              "The Claude interaction is no longer open.",
            );
          }
          held.resolving = true;
          let decision: ClaudeAgentSdkToolDecision;
          try {
            decision = await held.authorization.resolve(response);
          } catch {
            decision = { behavior: "deny", message: "The host could not resolve this interaction." };
          }
          if (
            pending.get(interactionId) !== held
            || active !== held.turn
            || held.turn.finished
            || held.turn.request.signal.aborted
          ) {
            throw new HarnessAdapterError(
              "INTERACTION_NOT_ACTIVE",
              "The Claude interaction is no longer open.",
            );
          }
          pending.delete(interactionId);
          if (decision.behavior === "deny" && held.request.toolUseId) declined.add(held.request.toolUseId);
          if (decision.behavior === "allow") {
            decision = { behavior: "allow", updatedInput: decision.updatedInput ?? held.request.input };
          }
          held.turn.queue.push({ kind: "interaction-resolved", interactionId, response });
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
