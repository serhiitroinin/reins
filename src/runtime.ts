/**
 * Session lifecycle shared by every provider adapter.
 *
 * The runtime owns identity, event envelopes, persistence, cancellation, and
 * terminal-event sealing. An adapter owns only provider communication.
 */

import {
  harnessSessionKey,
  type HarnessCapabilities,
  type HarnessEvent,
  type HarnessEventInput,
  type HarnessEventPayload,
  type HarnessInteractionResponse,
  type HarnessInput,
  type HarnessRunRequest,
  type HarnessSessionKey,
  type HarnessSteeringStrategy,
  type HarnessTurnStatus,
} from "./protocol.js";
import {
  HarnessContextPreparationError,
  prepareHarnessContext,
  type HarnessContextContribution,
  type HarnessContextPrepareRequest,
  type HarnessContextPreparationOptions,
  type HarnessPreparedContext,
  type HarnessContextSource,
} from "./context.js";
import type {
  HarnessDiscovery,
  HarnessDiscoveryRequest,
  HarnessEngineProfile,
  HarnessLimitSnapshot,
  HarnessModelCatalog,
} from "./profile.js";
import { bindToolHost, emptyToolHost, type HarnessToolHost, type HarnessTurnTools } from "./tools.js";

export type HarnessAdapterEvent = Exclude<
  HarnessEventPayload,
  { kind: "turn-started" } | { kind: "turn-completed" }
>;

export interface HarnessAdapterRunRequest extends HarnessRunRequest {
  runId: string;
  turnId: string;
  signal: AbortSignal;
  tools: HarnessTurnTools;
  context: HarnessPreparedContext<HarnessContextContribution>;
}

export interface HarnessAdapterFollowUpRequest {
  /** Harness-owned active turn precondition, not a provider turn id. */
  expectedTurnId: string;
  runId: string;
  turnId: string;
  input: readonly HarnessInput[];
  metadata?: Readonly<Record<string, unknown>>;
  signal: AbortSignal;
}

export interface HarnessAdapterSession {
  /**
   * Yield only events owned by this invocation's `runId` and `turnId`.
   * Once the iterable settles, the adapter must not surface late events from
   * this turn through a later invocation.
   */
  run(request: HarnessAdapterRunRequest): AsyncIterable<HarnessAdapterEvent>;
  /** Accept more input into the active provider turn without ending it. */
  steer?(request: HarnessAdapterFollowUpRequest): Promise<void>;
  respond?(interactionId: string, response: HarnessInteractionResponse): Promise<void>;
  /**
   * Dispatch cancellation and resolve only after the active `run()` iterable
   * has drained. An adapter that cannot isolate late events must retire its
   * provider session before resolving.
   */
  cancel?(): Promise<void>;
  checkpoint?(): Promise<string | null> | string | null;
  close?(): Promise<void>;
}

export interface HarnessAdapterOpenRequest {
  session: HarnessSessionKey;
  resumeToken: string | null;
}

export interface HarnessAdapter {
  readonly id: string;
  capabilities(): Promise<HarnessCapabilities> | HarnessCapabilities;
  profile?(request: HarnessDiscoveryRequest): Promise<HarnessDiscovery<HarnessEngineProfile>> | HarnessDiscovery<HarnessEngineProfile>;
  models?(request: HarnessDiscoveryRequest): Promise<HarnessDiscovery<HarnessModelCatalog>> | HarnessDiscovery<HarnessModelCatalog>;
  limits?(request: HarnessDiscoveryRequest): Promise<HarnessDiscovery<HarnessLimitSnapshot>> | HarnessDiscovery<HarnessLimitSnapshot>;
  open(request: HarnessAdapterOpenRequest): Promise<HarnessAdapterSession>;
}

export interface StoredHarnessSession {
  key: HarnessSessionKey;
  adapterId: string;
  resumeToken: string | null;
  updatedAt: string;
}

export interface HarnessEventStore {
  append(event: HarnessEventInput): Promise<HarnessEvent>;
  list(session: HarnessSessionKey, adapterId: string, after?: number): Promise<readonly HarnessEvent[]>;
}

export interface HarnessSessionStore {
  load(session: HarnessSessionKey, adapterId: string): Promise<StoredHarnessSession | null>;
  save(session: StoredHarnessSession): Promise<void>;
  remove(session: HarnessSessionKey, adapterId: string): Promise<void>;
}

export interface HarnessPersistence {
  events: HarnessEventStore;
  sessions: HarnessSessionStore;
}

export interface HarnessRun {
  readonly runId: string;
  readonly turnId: string;
  readonly events: AsyncIterable<HarnessEvent>;
  readonly done: Promise<HarnessTurnStatus>;
  cancel(): Promise<void>;
  followUp(request: HarnessFollowUpRequest, options?: HarnessFollowUpOptions): Promise<HarnessFollowUpResult>;
  respond(interactionId: string, response: HarnessInteractionResponse): Promise<void>;
}

export interface HarnessFollowUpRequest {
  /** Refuse rather than mutating a turn that changed under the caller. */
  expectedTurnId: string;
  input: readonly HarnessInput[];
  metadata?: Readonly<Record<string, unknown>>;
}

export interface HarnessFollowUpOptions {
  /** Omit to use the adapter-declared preferred strategy. */
  strategy?: HarnessSteeringStrategy;
  /** Host identity and prepared context for a replacement turn. */
  replacement?: HarnessStartOptions;
}

export interface HarnessFollowUpResult {
  strategy: HarnessSteeringStrategy;
  /** Same run for same-turn steering; a fresh run for replacement steering. */
  run: HarnessRun;
}

/**
 * Runtime-only values an application may bind to an already-admitted turn.
 *
 * These values deliberately stay outside `HarnessRunRequest`: they contain
 * live objects and host identity that do not belong in the JSON wire contract.
 * A supplied controller becomes the run's controller; `cancel()` aborts it.
 */
export interface HarnessStartOptions {
  runId?: string;
  turnId?: string;
  controller?: AbortController;
  context?: HarnessPreparedContext<HarnessContextContribution>;
}

export interface HarnessRuntime {
  capabilities(adapterId: string): Promise<HarnessCapabilities>;
  profile(adapterId: string, request?: HarnessDiscoveryRequest): Promise<HarnessDiscovery<HarnessEngineProfile>>;
  models(adapterId: string, request?: HarnessDiscoveryRequest): Promise<HarnessDiscovery<HarnessModelCatalog>>;
  limits(adapterId: string, request?: HarnessDiscoveryRequest): Promise<HarnessDiscovery<HarnessLimitSnapshot>>;
  start(request: HarnessRunRequest, options?: HarnessStartOptions): HarnessRun;
  close(): Promise<void>;
}

export interface HarnessRuntimeOptions {
  adapters: readonly HarnessAdapter[];
  persistence: HarnessPersistence;
  tools?: HarnessToolHost;
  contextSources?: readonly HarnessContextSource<HarnessContextContribution, HarnessContextPrepareRequest>[];
  onContextError?: HarnessContextPreparationOptions<HarnessContextContribution, HarnessContextPrepareRequest>["onError"];
  createId?: () => string;
  now?: () => Date;
}

export class HarnessRuntimeError extends Error {
  constructor(
    readonly code:
      | "UNKNOWN_ADAPTER"
      | "SESSION_BUSY"
      | "INTERACTION_UNSUPPORTED"
      | "INTERACTION_NOT_ACTIVE"
      | "FOLLOW_UP_UNSUPPORTED"
      | "FOLLOW_UP_FAILED"
      | "STALE_TURN"
      | "TURN_NOT_ACTIVE"
      | "RUNTIME_CLOSED",
    message: string,
  ) {
    super(message);
    this.name = "HarnessRuntimeError";
  }
}

/** An adapter failure whose message is explicitly safe to show and persist. */
export class HarnessAdapterError extends Error {
  constructor(
    readonly code: string,
    readonly publicMessage: string,
    readonly retryable = false,
  ) {
    super(publicMessage);
    this.name = "HarnessAdapterError";
  }
}

/** A provider-owned interruption that should seal the turn without an error event. */
export class HarnessAdapterInterruptedError extends Error {
  constructor() {
    super("The provider interrupted the turn.");
    this.name = "HarnessAdapterInterruptedError";
  }
}

interface ManagedSession {
  adapter: HarnessAdapter;
  session: HarnessAdapterSession;
  active: boolean;
}

class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(value: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value });
    else this.values.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async () => {
        const value = this.values.shift();
        if (value !== undefined) return { done: false, value };
        if (this.closed) return { done: true, value: undefined };
        return new Promise<IteratorResult<T>>((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

function safeError(error: unknown): { code: string; message: string; retryable?: boolean } {
  if (error instanceof HarnessRuntimeError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof HarnessAdapterError) {
    return {
      code: error.code,
      message: error.publicMessage,
      ...(error.retryable ? { retryable: true } : {}),
    };
  }
  if (error instanceof HarnessContextPreparationError) {
    return {
      code: error.code,
      message: error.publicMessage,
      ...(error.retryable ? { retryable: true } : {}),
    };
  }
  return { code: "ADAPTER_ERROR", message: "The adapter turn failed." };
}

export function createHarness(options: HarnessRuntimeOptions): HarnessRuntime {
  const adapters = new Map(options.adapters.map((adapter) => [adapter.id, adapter]));
  if (adapters.size !== options.adapters.length) throw new Error("adapter identifiers must be unique");
  const createId = options.createId ?? (() => crypto.randomUUID());
  const now = options.now ?? (() => new Date());
  const tools = options.tools ?? emptyToolHost;
  const contextSources = options.contextSources ?? [];
  const opened = new Map<string, Promise<ManagedSession>>();
  const reserved = new Set<string>();
  let closed = false;

  const adapterFor = (id: string): HarnessAdapter => {
    const adapter = adapters.get(id);
    if (!adapter) throw new HarnessRuntimeError("UNKNOWN_ADAPTER", `Unknown harness adapter: ${id}`);
    return adapter;
  };

  const discover = async <T>(
    adapterId: string,
    method: ((request: HarnessDiscoveryRequest) => Promise<HarnessDiscovery<T>> | HarnessDiscovery<T>) | undefined,
    request: HarnessDiscoveryRequest,
  ): Promise<HarnessDiscovery<T>> => {
    if (!method) return { status: "unsupported" };
    try {
      return await method(request);
    } catch (error) {
      if (error instanceof HarnessAdapterError) {
        return {
          status: "unavailable",
          message: error.publicMessage,
          ...(error.retryable ? { retryable: true } : {}),
        };
      }
      return { status: "unavailable", message: `${adapterId} discovery failed.` };
    }
  };

  const open = (key: HarnessSessionKey, adapter: HarnessAdapter): Promise<ManagedSession> => {
    const id = harnessSessionKey(key, adapter.id);
    const known = opened.get(id);
    if (known) return known;
    const created = options.persistence.sessions.load(key, adapter.id)
      .then(async (stored) => ({
        adapter,
        session: await adapter.open({ session: key, resumeToken: stored?.resumeToken ?? null }),
        active: false,
      }));
    opened.set(id, created);
    void created.catch(() => opened.delete(id));
    return created;
  };

  const persistCheckpoint = async (managed: ManagedSession, key: HarnessSessionKey): Promise<void> => {
    const resumeToken = await managed.session.checkpoint?.() ?? null;
    await options.persistence.sessions.save({
      key,
      adapterId: managed.adapter.id,
      resumeToken,
      updatedAt: now().toISOString(),
    });
  };

  const prepareContext = (
    request: HarnessRunRequest,
    runId: string,
    turnId: string,
    signal: AbortSignal,
  ): Promise<HarnessPreparedContext<HarnessContextContribution>> => {
    const contextRequest: HarnessContextPrepareRequest = {
      ...request,
      runId,
      turnId,
      signal,
    };
    const contextOptions: HarnessContextPreparationOptions<
      HarnessContextContribution,
      HarnessContextPrepareRequest
    > = options.onContextError ? { onError: options.onContextError } : {};
    return prepareHarnessContext(contextSources, contextRequest, contextOptions);
  };

  const runtime: HarnessRuntime = {
    async capabilities(adapterId) {
      return adapterFor(adapterId).capabilities();
    },

    profile(adapterId, request = {}) {
      const adapter = adapterFor(adapterId);
      return discover(adapterId, adapter.profile?.bind(adapter), request);
    },

    models(adapterId, request = {}) {
      const adapter = adapterFor(adapterId);
      return discover(adapterId, adapter.models?.bind(adapter), request);
    },

    limits(adapterId, request = {}) {
      const adapter = adapterFor(adapterId);
      return discover(adapterId, adapter.limits?.bind(adapter), request);
    },

    start(request, startOptions = {}) {
      if (closed) throw new HarnessRuntimeError("RUNTIME_CLOSED", "The harness runtime is closed.");
      if (startOptions.runId !== undefined && startOptions.runId.length === 0) {
        throw new Error("a host-supplied runId cannot be empty");
      }
      if (startOptions.turnId !== undefined && startOptions.turnId.length === 0) {
        throw new Error("a host-supplied turnId cannot be empty");
      }
      const adapter = adapterFor(request.adapterId);
      const sessionId = harnessSessionKey(request.session, adapter.id);
      const runId = startOptions.runId ?? createId();
      const turnId = startOptions.turnId ?? createId();
      const controller = startOptions.controller ?? new AbortController();
      const queue = new AsyncQueue<HarnessEvent>();
      let managed: ManagedSession | null = null;
      let opening: Promise<ManagedSession> | null = null;
      let ownsReservation = false;
      let phase: "opening" | "running" | "sealing" | "sealed" = "opening";
      let stopping = false;
      let cancellationWork: Promise<void> | null = null;
      let publicCancelWork: Promise<void> | null = null;
      let cancellationDispatch: Promise<void> | null = null;
      let controlTail: Promise<void> = Promise.resolve();
      let replacementInFlight: AbortController | null = null;
      let preserveReplacementOnAbort = false;
      /** Interactions the durable event stream still says this turn can answer. */
      const openInteractions = new Set<string>();
      const respondingInteractions = new Set<string>();

      const serializeControl = <T>(operation: () => Promise<T>): Promise<T> => {
        const result = controlTail.then(operation, operation);
        controlTail = result.then(() => undefined, () => undefined);
        return result;
      };

      const dispatchCancellation = (): Promise<void> => {
        cancellationDispatch ??= (async () => {
          if (managed?.session.cancel) await managed.session.cancel();
        })();
        return cancellationDispatch;
      };

      const onAbort = (): void => {
        stopping = true;
        if (!preserveReplacementOnAbort && replacementInFlight && !replacementInFlight.signal.aborted) {
          replacementInFlight.abort();
        }
        // An externally-owned controller follows the exact same adapter
        // cancellation path as `run.cancel()`. The public cancel method can
        // still observe a dispatch failure; the listener itself must not
        // create an unhandled rejection.
        void dispatchCancellation().catch(() => undefined);
      };
      controller.signal.addEventListener("abort", onAbort, { once: true });
      if (controller.signal.aborted) onAbort();

      const ensureActiveTurn = (expectedTurnId: string): ManagedSession => {
        if (expectedTurnId !== turnId) {
          throw new HarnessRuntimeError("STALE_TURN", "The active harness turn changed before the follow-up was sent.");
        }
        if (phase !== "running" || !managed?.active || controller.signal.aborted || stopping) {
          throw new HarnessRuntimeError("TURN_NOT_ACTIVE", "This harness turn is no longer accepting follow-ups.");
        }
        return managed;
      };

      const emit = async (payload: HarnessEventPayload): Promise<void> => {
        const event = await options.persistence.events.append({
          schemaVersion: 1,
          session: request.session,
          runId,
          turnId,
          adapterId: adapter.id,
          payload,
        });
        if (payload.kind === "interaction-requested") {
          openInteractions.add(payload.interaction.id);
        } else if (
          payload.kind === "interaction-resolved"
          || payload.kind === "interaction-invalidated"
        ) {
          openInteractions.delete(payload.interactionId);
          respondingInteractions.delete(payload.interactionId);
        }
        queue.push(event);
      };

      const done = (async (): Promise<HarnessTurnStatus> => {
        const startedAt = now().getTime();
        let status: HarnessTurnStatus = "completed";
        try {
          await emit({
            kind: "turn-started",
            ...(request.model ? { model: request.model } : {}),
            ...(request.accountId ? { accountId: request.accountId } : {}),
          });
          if (controller.signal.aborted) throw new HarnessAdapterInterruptedError();
          if (reserved.has(sessionId)) {
            throw new HarnessRuntimeError("SESSION_BUSY", "This harness session already has a running turn.");
          }
          reserved.add(sessionId);
          ownsReservation = true;
          opening = open(request.session, adapter);
          managed = await opening;
          if (controller.signal.aborted) {
            if (opened.get(sessionId) === opening) opened.delete(sessionId);
            try {
              await managed.session.close?.();
            } finally {
              managed = null;
            }
            throw new HarnessAdapterInterruptedError();
          }
          if (managed.active) throw new HarnessRuntimeError("SESSION_BUSY", "This harness session already has a running turn.");
          managed.active = true;
          const context = startOptions.context
            ?? await prepareContext(request, runId, turnId, controller.signal);
          if (controller.signal.aborted) throw new HarnessAdapterInterruptedError();
          const toolContext = {
            session: request.session,
            adapterId: adapter.id,
            runId,
            turnId,
            signal: controller.signal,
            context,
          };
          phase = "running";
          for await (const payload of managed.session.run({
            ...request,
            runId,
            turnId,
            signal: controller.signal,
            context,
            tools: bindToolHost(tools, toolContext),
          })) {
            // Cancellation asks the adapter to settle; it does not revoke
            // events the adapter has already produced. In particular, an
            // adapter may flush partial text and close an in-flight tool as
            // cancelled while unwinding. Persist those facts before sealing
            // the runtime turn as interrupted.
            await emit(payload);
          }
          // Provider output has drained. Do not accept new input while the
          // checkpoint and terminal envelope are still becoming durable.
          phase = "sealing";
          if (controller.signal.aborted) status = "interrupted";
          await persistCheckpoint(managed, request.session);
        } catch (error) {
          // The provider iterable has already settled on every catch path.
          // Close follow-up admission before persisting a public error.
          phase = "sealing";
          if (controller.signal.aborted || stopping || error instanceof HarnessAdapterInterruptedError) {
            status = "interrupted";
          }
          else {
            status = "error";
            const failure = safeError(error);
            await emit({ kind: "error", ...failure });
          }
        } finally {
          phase = "sealing";
          try {
            // A custom adapter may end without explicitly closing a deferred
            // interaction. Persist the loss of actionability before the
            // terminal seal; a replay must never offer a dead callback.
            for (const interactionId of [...openInteractions]) {
              await emit({
                kind: "interaction-invalidated",
                interactionId,
                reason: "turn-ended",
              });
            }
            await emit({
              kind: "turn-completed",
              status,
              usage: { durationMs: Math.max(0, now().getTime() - startedAt) },
            });
          } finally {
            // A failed event store must reject `done`, but never leave readers
            // waiting on a queue no producer can write to again.
            queue.close();
            if (managed) managed.active = false;
            if (ownsReservation) reserved.delete(sessionId);
            controller.signal.removeEventListener("abort", onAbort);
            phase = "sealed";
          }
        }
        return status;
      })();

      const performCancellation = (preserveReplacement = false): Promise<void> => {
        cancellationWork ??= (async () => {
          stopping = true;
          if (!controller.signal.aborted) {
            preserveReplacementOnAbort = preserveReplacement;
            try {
              controller.abort();
            } finally {
              preserveReplacementOnAbort = false;
            }
          }
          let cancellationError: unknown;
          try {
            await dispatchCancellation();
          } catch (error) {
            cancellationError = error;
          }
          // A cancellation dispatch failure cannot release the session
          // early. Wait for the provider iterable and terminal event to
          // drain before surfacing it to the caller.
          await done;
          if (cancellationError !== undefined) throw cancellationError;
        })();
        return cancellationWork;
      };

      const publicRun: HarnessRun = {
        runId,
        turnId,
        events: queue,
        done,
        cancel() {
          // Stop invalidates an in-flight follow-up immediately. Adapter
          // cancellation is still idempotent and the public promise waits for
          // the serialized operation plus the complete drain/seal barrier.
          stopping = true;
          if (replacementInFlight && !replacementInFlight.signal.aborted) {
            replacementInFlight.abort();
          }
          if (!controller.signal.aborted) controller.abort();
          publicCancelWork ??= serializeControl(performCancellation);
          return publicCancelWork;
        },
        followUp(followUpRequest, followUpOptions = {}) {
          return serializeControl(async () => {
            ensureActiveTurn(followUpRequest.expectedTurnId);
            let capabilities: HarnessCapabilities;
            try {
              capabilities = await adapter.capabilities();
            } catch {
              throw new HarnessRuntimeError("FOLLOW_UP_FAILED", "The adapter could not describe follow-up support.");
            }
            ensureActiveTurn(followUpRequest.expectedTurnId);
            const steering = capabilities.steering;
            const supported = steering?.support !== "unsupported" ? steering?.strategies ?? [] : [];
            const strategy = followUpOptions.strategy
              ?? (steering?.preferred && supported.includes(steering.preferred)
                ? steering.preferred
                : supported[0]);
            if (!strategy || !supported.includes(strategy)) {
              throw new HarnessRuntimeError("FOLLOW_UP_UNSUPPORTED", "This adapter cannot accept an active-turn follow-up.");
            }

            if (strategy === "same-turn") {
              const target = ensureActiveTurn(followUpRequest.expectedTurnId);
              if (!target.session.steer) {
                throw new HarnessRuntimeError("FOLLOW_UP_UNSUPPORTED", "This adapter cannot accept a same-turn follow-up.");
              }
              try {
                await target.session.steer({
                  expectedTurnId: followUpRequest.expectedTurnId,
                  runId,
                  turnId,
                  input: followUpRequest.input,
                  ...(followUpRequest.metadata ? { metadata: followUpRequest.metadata } : {}),
                  signal: controller.signal,
                });
              } catch (error) {
                if (error instanceof HarnessRuntimeError || error instanceof HarnessAdapterError) throw error;
                throw new HarnessRuntimeError("FOLLOW_UP_FAILED", "The adapter could not accept the follow-up.");
              }
              return { strategy, run: publicRun };
            }

            const replacement = followUpOptions.replacement ?? {};
            if (replacement.runId !== undefined && replacement.runId.length === 0) {
              throw new Error("a host-supplied replacement runId cannot be empty");
            }
            if (replacement.turnId !== undefined && replacement.turnId.length === 0) {
              throw new Error("a host-supplied replacement turnId cannot be empty");
            }
            if (replacement.runId === runId) {
              throw new Error("a replacement follow-up requires a fresh runId");
            }
            if (replacement.turnId === turnId) {
              throw new Error("a replacement follow-up requires a fresh turnId");
            }
            if (replacement.controller === controller) {
              throw new Error("a replacement follow-up requires a fresh AbortController");
            }
            const replacementRunId = replacement.runId ?? createId();
            const replacementTurnId = replacement.turnId ?? createId();
            const replacementController = replacement.controller ?? new AbortController();
            const replacementRequest: HarnessRunRequest = {
              ...request,
              input: followUpRequest.input,
              ...(followUpRequest.metadata ? { metadata: followUpRequest.metadata } : {}),
            };
            // Prepare first so a context failure leaves the active provider
            // turn untouched. Admission is rechecked after async preparation.
            replacementInFlight = replacementController;
            try {
              const replacementContext = replacement.context
                ?? await prepareContext(
                  replacementRequest,
                  replacementRunId,
                  replacementTurnId,
                  replacementController.signal,
                );
              if (replacementController.signal.aborted) {
                throw new HarnessRuntimeError(
                  "FOLLOW_UP_FAILED",
                  "The replacement follow-up was cancelled before dispatch.",
                );
              }
              ensureActiveTurn(followUpRequest.expectedTurnId);
              try {
                await performCancellation(true);
              } catch (error) {
                if (error instanceof HarnessRuntimeError || error instanceof HarnessAdapterError) throw error;
                throw new HarnessRuntimeError(
                  "FOLLOW_UP_FAILED",
                  "The adapter could not replace the active turn.",
                );
              }
              if (replacementController.signal.aborted) {
                throw new HarnessRuntimeError(
                  "FOLLOW_UP_FAILED",
                  "The replacement follow-up was cancelled before dispatch.",
                );
              }
              return {
                strategy,
                run: runtime.start(replacementRequest, {
                  runId: replacementRunId,
                  turnId: replacementTurnId,
                  controller: replacementController,
                  context: replacementContext,
                }),
              };
            } finally {
              if (replacementInFlight === replacementController) replacementInFlight = null;
            }
          });
        },
        respond(interactionId, response) {
          return serializeControl(async () => {
            if (
              phase !== "running"
              || controller.signal.aborted
              || stopping
              || !managed?.active
              || !openInteractions.has(interactionId)
              || respondingInteractions.has(interactionId)
            ) {
              throw new HarnessRuntimeError(
                "INTERACTION_NOT_ACTIVE",
                "This interaction is no longer open on the active harness turn.",
              );
            }
            if (!managed.session.respond) {
              throw new HarnessRuntimeError("INTERACTION_UNSUPPORTED", `${adapter.id} cannot answer interactions.`);
            }
            respondingInteractions.add(interactionId);
            try {
              await managed.session.respond(interactionId, response);
              // The adapter event is persisted by the run consumer and is the
              // only fact that closes the durable interaction. Keep the id in
              // `openInteractions` until that event arrives so a custom
              // adapter that acknowledges a response without resolving it is
              // invalidated before the terminal seal. `respondingInteractions`
              // still prevents a concurrent retry from reaching the provider.
            } catch (error) {
              respondingInteractions.delete(interactionId);
              if (
                error instanceof HarnessAdapterError
                && error.code === "INTERACTION_NOT_ACTIVE"
              ) {
                openInteractions.delete(interactionId);
              }
              throw error;
            }
          });
        },
      };
      return publicRun;
    },

    async close() {
      if (closed) return;
      closed = true;
      const sessions = await Promise.allSettled(opened.values());
      await Promise.all(sessions.flatMap((entry) =>
        entry.status === "fulfilled" && entry.value.session.close ? [entry.value.session.close()] : []));
      opened.clear();
    },
  };
  return runtime;
}
