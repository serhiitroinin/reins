/**
 * Session lifecycle shared by every provider adapter.
 *
 * The runtime owns identity, event envelopes, persistence, cancellation, and
 * terminal-event sealing. An adapter owns only provider communication.
 */

import {
  harnessSessionKey,
  type HarnessCapabilities,
  type HarnessContextValue,
  type HarnessEvent,
  type HarnessEventInput,
  type HarnessEventPayload,
  type HarnessInteractionResponse,
  type HarnessInput,
  type HarnessInlineContext,
  type HarnessRunRequest,
  type HarnessSessionKey,
  type HarnessSteeringStrategy,
  type HarnessTurnStatus,
} from "./protocol.js";
import { validateHarnessInlineContext, validateHarnessInput } from "./input.js";
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
  HarnessControlValue,
  HarnessDiscovery,
  HarnessDiscoveryRequest,
  HarnessEngineProfile,
  HarnessInputPolicy,
  HarnessLimitSnapshot,
  HarnessModelCatalog,
  HarnessPermissionSelection,
  HarnessRunSettings,
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
  inlineContext?: HarnessInlineContext;
  metadata?: Readonly<Record<string, unknown>>;
  signal: AbortSignal;
}

export interface HarnessAdapterSubagentControlRequest {
  taskId: string;
  runId: string;
  turnId: string;
  /** Aborted when the parent turn ends, is cancelled, or the runtime closes. */
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
  /** Stop one active provider subagent without cancelling its parent turn. */
  stopSubagent?(request: HarnessAdapterSubagentControlRequest): Promise<boolean>;
  checkpoint?(): Promise<string | null> | string | null;
  close?(): Promise<void>;
}

/**
 * Versioned, private provider state used only to resume one logical session.
 *
 * `format` is adapter-owned and open-ended. It identifies the meaning of the
 * opaque token, not the package or provider release. Tokens may be sensitive;
 * checkpoints never enter events or diagnostics.
 */
export interface HarnessSessionCheckpoint {
  schemaVersion: 1;
  format: string;
  token: string;
}

/** Declares which persisted checkpoint formats an adapter can safely open. */
export interface HarnessAdapterCheckpointContract {
  /** Format written for every new checkpoint. */
  format: string;
  /** Older formats this adapter can still open. The current format is implicit. */
  compatibleFormats?: readonly string[];
}

export interface HarnessAdapterOpenRequest {
  session: HarnessSessionKey;
  resumeToken: string | null;
  /** Aborted when the owning turn or runtime retires this open attempt. */
  signal: AbortSignal;
  /** Runtime-owned durable write for provider checkpoints announced mid-turn. */
  persistCheckpoint?(resumeToken: string | null): Promise<void>;
}

export interface HarnessAdapter {
  readonly id: string;
  /** Required whenever an adapter session can return a resume checkpoint. */
  readonly checkpoint?: HarnessAdapterCheckpointContract;
  capabilities(): Promise<HarnessCapabilities> | HarnessCapabilities;
  profile?(request: HarnessDiscoveryRequest): Promise<HarnessDiscovery<HarnessEngineProfile>> | HarnessDiscovery<HarnessEngineProfile>;
  models?(request: HarnessDiscoveryRequest): Promise<HarnessDiscovery<HarnessModelCatalog>> | HarnessDiscovery<HarnessModelCatalog>;
  limits?(request: HarnessDiscoveryRequest): Promise<HarnessDiscovery<HarnessLimitSnapshot>> | HarnessDiscovery<HarnessLimitSnapshot>;
  open(request: HarnessAdapterOpenRequest): Promise<HarnessAdapterSession>;
}

export interface StoredHarnessSession {
  key: HarnessSessionKey;
  adapterId: string;
  checkpoint: HarnessSessionCheckpoint | null;
  /** Opaque, non-secret host fingerprint that must remain stable on resume. */
  sessionBinding?: string;
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
  /** Stop one active subagent while leaving this run open. */
  stopSubagent(taskId: string): Promise<boolean>;
}

export interface HarnessFollowUpRequest {
  /** Refuse rather than mutating a turn that changed under the caller. */
  expectedTurnId: string;
  input: readonly HarnessInput[];
  inlineContext?: HarnessInlineContext;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface HarnessFollowUpOptions {
  /** Omit to use the adapter-declared preferred strategy. */
  strategy?: HarnessSteeringStrategy;
  /** Host identity and prepared context for a replacement turn. */
  replacement?: HarnessReplacementOptions;
}

/** Complete execution fields for a replacement turn; omitted fields are cleared. */
export interface HarnessReplacementExecution {
  accountId?: string;
  model?: string;
  effort?: string;
  settings?: HarnessRunSettings;
  configuration?: Readonly<Record<string, unknown>>;
}

export interface HarnessReplacementOptions extends HarnessStartOptions {
  /** Requires an explicit newly admitted snapshot. */
  execution?: HarnessReplacementExecution;
}

export interface HarnessFollowUpResult {
  strategy: HarnessSteeringStrategy;
  /** Same run for same-turn steering; a fresh run for replacement steering. */
  run: HarnessRun;
}

/**
 * Host-resolved execution values admitted before a turn reaches the runtime.
 *
 * Properties are optional so a host can adopt admission incrementally. For
 * nullable selections, `null` explicitly admits an omitted request value while
 * an absent property leaves that dimension unenforced.
 */
export interface HarnessAdmission {
  adapterId?: string;
  accountId?: string | null;
  model?: string | null;
  effort?: string | null;
  settings?: {
    permission?: HarnessPermissionSelection | null;
    /** Exact resolved control set. An empty object admits no controls. */
    controls?: Readonly<Record<string, HarnessControlValue>>;
  };
  inputPolicy?: HarnessInputPolicy;
  /** Opaque, non-secret fingerprint for values that must remain session-stable. */
  sessionBinding?: string;
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
  /** Complete host-resolved execution snapshot admitted for this run. */
  admission?: HarnessAdmission;
  /** @deprecated Prefer `admission.inputPolicy`; retained for compatibility. */
  inputPolicy?: HarnessInputPolicy;
}

export interface HarnessRuntime {
  capabilities(adapterId: string): Promise<HarnessCapabilities>;
  profile(adapterId: string, request?: HarnessDiscoveryRequest): Promise<HarnessDiscovery<HarnessEngineProfile>>;
  models(adapterId: string, request?: HarnessDiscoveryRequest): Promise<HarnessDiscovery<HarnessModelCatalog>>;
  limits(adapterId: string, request?: HarnessDiscoveryRequest): Promise<HarnessDiscovery<HarnessLimitSnapshot>>;
  start(request: HarnessRunRequest, options?: HarnessStartOptions): HarnessRun;
  /** Close and forget an inactive provider session and its durable checkpoint. */
  resetSession(session: HarnessSessionKey, adapterId: string): Promise<void>;
  close(): Promise<void>;
}

export type HarnessDiagnosticPhase =
  | "discovery"
  | "event-store"
  | "session-load"
  | "session-open"
  | "context"
  | "turn"
  | "checkpoint"
  | "cancellation"
  | "follow-up"
  | "interaction"
  | "subagent"
  | "session-reset"
  | "session-close";

/** Sanitized, process-local operational information. Never persisted by the runtime. */
export interface HarnessDiagnostic {
  schemaVersion: 1;
  timestamp: string;
  severity: "warning" | "error";
  phase: HarnessDiagnosticPhase;
  code: string;
  message: string;
  adapterId: string;
  session?: HarnessSessionKey;
  runId?: string;
  turnId?: string;
  retryable?: boolean;
}

export interface HarnessRuntimeOptions {
  adapters: readonly HarnessAdapter[];
  persistence: HarnessPersistence;
  tools?: HarnessToolHost;
  contextSources?: readonly HarnessContextSource<HarnessContextContribution, HarnessContextPrepareRequest>[];
  onContextError?: HarnessContextPreparationOptions<HarnessContextContribution, HarnessContextPrepareRequest>["onError"];
  /** Best-effort and sanitized; callback failures never affect runtime work. */
  onDiagnostic?: (diagnostic: HarnessDiagnostic) => void | Promise<void>;
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
      | "INVALID_SUBAGENT_ID"
      | "SUBAGENT_CONTROL_UNSUPPORTED"
      | "SUBAGENT_CONTROL_FAILED"
      | "FOLLOW_UP_UNSUPPORTED"
      | "FOLLOW_UP_FAILED"
      | "STALE_TURN"
      | "TURN_NOT_ACTIVE"
      | "ADMISSION_MISMATCH"
      | "INVALID_INPUT"
      | "SESSION_CHECKPOINT_INVALID"
      | "SESSION_CHECKPOINT_INCOMPATIBLE"
      | "SESSION_CHECKPOINT_STALE"
      | "SESSION_BINDING_MISMATCH"
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
  key: HarnessSessionKey;
  session: HarnessAdapterSession;
  sessionBinding?: string;
  generation: number;
  active: boolean;
}

interface ManagedSessionOpening {
  promise: Promise<ManagedSession>;
  status: "pending" | "fulfilled" | "rejected";
  managed?: ManagedSession;
}

/** Keep admission stable even if a discovery cache mutates after `start()`. */
function snapshotInputPolicy(policy: HarnessInputPolicy | undefined): HarnessInputPolicy | undefined {
  if (policy === undefined) return undefined;
  return {
    ...policy,
    ...(policy.modalities ? {
      modalities: Object.fromEntries(Object.entries(policy.modalities).map(([id, constraint]) => [id, {
        ...constraint,
        ...(constraint.mediaTypes ? { mediaTypes: [...constraint.mediaTypes] } : {}),
        ...(constraint.extensions ? { extensions: { ...constraint.extensions } } : {}),
      }])),
    } : {}),
    ...(policy.extensions ? { extensions: { ...policy.extensions } } : {}),
  };
}

function snapshotAdmission(
  admission: HarnessAdmission | undefined,
  legacyInputPolicy?: HarnessInputPolicy,
): HarnessAdmission | undefined {
  if (admission === undefined && legacyInputPolicy === undefined) return undefined;
  const inputPolicy = snapshotInputPolicy(admission?.inputPolicy ?? legacyInputPolicy);
  return {
    ...admission,
    ...(admission?.settings ? {
      settings: {
        ...(admission.settings.permission !== undefined ? {
          permission: admission.settings.permission === null
            ? null
            : { ...admission.settings.permission },
        } : {}),
        ...(admission.settings.controls !== undefined ? {
          controls: { ...admission.settings.controls },
        } : {}),
      },
    } : {}),
    ...(inputPolicy ? { inputPolicy } : {}),
  };
}

function snapshotContextValue(value: HarnessContextValue): HarnessContextValue {
  if (Array.isArray(value)) return value.map(snapshotContextValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, snapshotContextValue(entry)]),
    );
  }
  return value;
}

function snapshotInput(input: readonly HarnessInput[]): readonly HarnessInput[] {
  return input.map((part) => part.type === "image"
    ? { ...part, data: new Uint8Array(part.data) }
    : { ...part });
}

function snapshotInlineContext(context: HarnessInlineContext | undefined): HarnessInlineContext | undefined {
  if (!context) return undefined;
  return {
    version: context.version,
    records: context.records.map((record) => ({
      ...record,
      payload: snapshotContextValue(record.payload),
      ...(record.binding ? { binding: { ...record.binding } } : {}),
    })),
  };
}

function snapshotSettings(settings: HarnessRunSettings | undefined): HarnessRunSettings | undefined {
  if (!settings) return undefined;
  return {
    ...(settings.permission ? { permission: { ...settings.permission } } : {}),
    ...(settings.controls ? { controls: { ...settings.controls } } : {}),
  };
}

function snapshotUnknown(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
  if (value === null || typeof value !== "object") return value;
  const known = seen.get(value);
  if (known !== undefined) return known;
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value, copy);
    for (const entry of value) copy.push(snapshotUnknown(entry, seen));
    return copy;
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) return value;
  const copy: Record<string, unknown> = {};
  seen.set(value, copy);
  for (const [key, entry] of Object.entries(value)) copy[key] = snapshotUnknown(entry, seen);
  return copy;
}

function snapshotRecord(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return snapshotUnknown(value) as Readonly<Record<string, unknown>>;
}

function snapshotRunRequest(request: HarnessRunRequest): HarnessRunRequest {
  const inlineContext = snapshotInlineContext(request.inlineContext);
  const settings = snapshotSettings(request.settings);
  return {
    ...request,
    session: { ...request.session },
    input: snapshotInput(request.input),
    ...(inlineContext ? { inlineContext } : {}),
    ...(settings ? { settings } : {}),
    ...(request.configuration ? { configuration: snapshotRecord(request.configuration) } : {}),
    ...(request.metadata ? { metadata: snapshotRecord(request.metadata) } : {}),
  };
}

function snapshotFollowUpRequest(request: HarnessFollowUpRequest): HarnessFollowUpRequest {
  const inlineContext = snapshotInlineContext(request.inlineContext);
  return {
    ...request,
    input: snapshotInput(request.input),
    ...(inlineContext ? { inlineContext } : {}),
    ...(request.metadata ? { metadata: snapshotRecord(request.metadata) } : {}),
  };
}

function snapshotReplacementExecution(
  execution: HarnessReplacementExecution | undefined,
): HarnessReplacementExecution | undefined {
  if (!execution) return undefined;
  const settings = snapshotSettings(execution.settings);
  return {
    ...execution,
    ...(settings ? { settings } : {}),
    ...(execution.configuration ? { configuration: snapshotRecord(execution.configuration) } : {}),
  };
}

function admissionMismatch(message: string): never {
  throw new HarnessRuntimeError("ADMISSION_MISMATCH", message);
}

function validateAdmission(request: HarnessRunRequest, admission: HarnessAdmission | undefined): void {
  if (!admission) return;
  if (admission.sessionBinding !== undefined && admission.sessionBinding.length === 0) {
    admissionMismatch("The admitted session binding is invalid.");
  }
  if (admission.adapterId !== undefined && admission.adapterId !== request.adapterId) {
    admissionMismatch("The request adapter does not match its admitted execution.");
  }
  if (admission.accountId !== undefined && admission.accountId !== (request.accountId ?? null)) {
    admissionMismatch("The request account does not match its admitted execution.");
  }
  if (admission.model !== undefined && admission.model !== (request.model ?? null)) {
    admissionMismatch("The request model does not match its admitted execution.");
  }
  if (admission.effort !== undefined && admission.effort !== (request.effort ?? null)) {
    admissionMismatch("The request effort does not match its admitted execution.");
  }

  const admittedPermission = admission.settings?.permission;
  if (admittedPermission !== undefined) {
    const requestedPermission = request.settings?.permission ?? null;
    const matches = admittedPermission === null
      ? requestedPermission === null
      : requestedPermission !== null
        && admittedPermission.modeId === requestedPermission.modeId
        && admittedPermission.consentVersion === requestedPermission.consentVersion;
    if (!matches) admissionMismatch("The request permission does not match its admitted execution.");
  }

  const admittedControls = admission.settings?.controls;
  if (admittedControls !== undefined) {
    const requestedControls = request.settings?.controls ?? {};
    const admittedIds = Object.keys(admittedControls);
    const requestedIds = Object.keys(requestedControls);
    const matches = admittedIds.length === requestedIds.length
      && admittedIds.every((id) => Object.hasOwn(requestedControls, id)
        && Object.is(admittedControls[id], requestedControls[id]));
    if (!matches) admissionMismatch("The request controls do not match its admitted execution.");
  }
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

function safeDiagnosticError(
  error: unknown,
  fallback: { code: string; message: string },
): { code: string; message: string; retryable?: boolean } {
  if (
    error instanceof HarnessRuntimeError
    || error instanceof HarnessAdapterError
    || error instanceof HarnessContextPreparationError
  ) return safeError(error);
  return fallback;
}

interface NormalizedCheckpointContract {
  format: string;
  compatibleFormats: ReadonlySet<string>;
}

function checkpointContract(adapter: HarnessAdapter): NormalizedCheckpointContract | null {
  if (!adapter.checkpoint) return null;
  const format = adapter.checkpoint.format;
  if (format.trim().length === 0) throw new Error(`${adapter.id} checkpoint format cannot be empty`);
  const compatibleFormats = new Set([format]);
  for (const compatible of adapter.checkpoint.compatibleFormats ?? []) {
    if (compatible.trim().length === 0) {
      throw new Error(`${adapter.id} compatible checkpoint format cannot be empty`);
    }
    compatibleFormats.add(compatible);
  }
  return { format, compatibleFormats };
}

function assertStoredCheckpoint(checkpoint: HarnessSessionCheckpoint): void {
  if (
    checkpoint.schemaVersion !== 1
    || typeof checkpoint.format !== "string"
    || checkpoint.format.trim().length === 0
    || typeof checkpoint.token !== "string"
    || checkpoint.token.length === 0
  ) {
    throw new HarnessRuntimeError(
      "SESSION_CHECKPOINT_INVALID",
      "The saved harness session checkpoint is invalid. Reset the session before retrying.",
    );
  }
}

export function createHarness(options: HarnessRuntimeOptions): HarnessRuntime {
  const adapters = new Map(options.adapters.map((adapter) => [adapter.id, adapter]));
  if (adapters.size !== options.adapters.length) throw new Error("adapter identifiers must be unique");
  const checkpointContracts = new Map(
    options.adapters.map((adapter) => [adapter.id, checkpointContract(adapter)]),
  );
  const createId = options.createId ?? (() => crypto.randomUUID());
  const now = options.now ?? (() => new Date());
  const tools = options.tools ?? emptyToolHost;
  const contextSources = options.contextSources ?? [];
  const opened = new Map<string, ManagedSessionOpening>();
  const reserved = new Set<string>();
  const sessionBindings = new Map<string, string>();
  const sessionGenerations = new Map<string, number>();
  const sessionMutationTails = new Map<string, Promise<void>>();
  const sessionCloseWork = new WeakMap<HarnessAdapterSession, Promise<void>>();
  const activeRuns = new Set<{
    sessionId: string;
    controller: AbortController;
    done: Promise<HarnessTurnStatus>;
  }>();
  const reportedFailures = new WeakSet<object>();
  let closed = false;
  let closeWork: Promise<void> | null = null;

  const closeAdapterSession = (session: HarnessAdapterSession): Promise<void> => {
    const known = sessionCloseWork.get(session);
    if (known) return known;
    if (!session.close) return Promise.resolve();
    const work = Promise.resolve().then(() => session.close!());
    sessionCloseWork.set(session, work);
    return work;
  };

  const reportDiagnostic = (diagnostic: Omit<HarnessDiagnostic, "schemaVersion" | "timestamp">): void => {
    if (!options.onDiagnostic) return;
    const value: HarnessDiagnostic = Object.freeze({
      schemaVersion: 1,
      timestamp: now().toISOString(),
      ...diagnostic,
      ...(diagnostic.session ? { session: Object.freeze({ ...diagnostic.session }) } : {}),
    });
    try {
      void Promise.resolve(options.onDiagnostic(value)).catch(() => undefined);
    } catch {
      // Diagnostics are observational. A host callback cannot affect a turn.
    }
  };

  const reportFailure = (
    error: unknown,
    context: Pick<HarnessDiagnostic, "phase" | "adapterId"> &
      Partial<Pick<HarnessDiagnostic, "session" | "runId" | "turnId">>,
    fallback: { code: string; message: string },
  ): void => {
    if (typeof error === "object" && error !== null) {
      if (reportedFailures.has(error)) return;
      reportedFailures.add(error);
    }
    const failure = safeDiagnosticError(error, fallback);
    reportDiagnostic({
      severity: "error",
      ...context,
      ...failure,
    });
  };

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
      reportFailure(error, { phase: "discovery", adapterId }, {
        code: "DISCOVERY_FAILED",
        message: `${adapterId} discovery failed.`,
      });
      if (error instanceof HarnessAdapterError) {
        return {
          status: "unavailable",
          message: error.publicMessage,
          code: error.code,
          ...(error.retryable ? { retryable: true } : {}),
        };
      }
      return { status: "unavailable", message: `${adapterId} discovery failed.` };
    }
  };

  const serializeSessionMutation = <T>(id: string, operation: () => Promise<T>): Promise<T> => {
    const previous = sessionMutationTails.get(id) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(() => undefined, () => undefined);
    sessionMutationTails.set(id, tail);
    void tail.then(() => {
      if (sessionMutationTails.get(id) === tail) sessionMutationTails.delete(id);
    });
    return result;
  };

  const saveCheckpointRecord = async (
    adapter: HarnessAdapter,
    key: HarnessSessionKey,
    sessionBinding: string | undefined,
    resumeToken: string | null,
  ): Promise<void> => {
    const contract = checkpointContracts.get(adapter.id) ?? null;
    if (resumeToken !== null && resumeToken.length === 0) {
      throw new HarnessRuntimeError("SESSION_CHECKPOINT_INVALID", "The adapter returned an empty session checkpoint.");
    }
    if (resumeToken !== null && contract === null) {
      throw new HarnessRuntimeError(
        "SESSION_CHECKPOINT_INVALID",
        `${adapter.id} returned a checkpoint without declaring its format.`,
      );
    }
    await options.persistence.sessions.save({
      key,
      adapterId: adapter.id,
      checkpoint: resumeToken === null ? null : {
        schemaVersion: 1,
        format: contract!.format,
        token: resumeToken,
      },
      ...(sessionBinding !== undefined ? { sessionBinding } : {}),
      updatedAt: now().toISOString(),
    });
  };

  const saveCheckpoint = (
    id: string,
    generation: number,
    adapter: HarnessAdapter,
    key: HarnessSessionKey,
    sessionBinding: string | undefined,
    resumeToken: string | null,
  ): Promise<void> => serializeSessionMutation(id, async () => {
    if (sessionGenerations.get(id) !== generation || closed) {
      throw new HarnessRuntimeError(
        "SESSION_CHECKPOINT_STALE",
        "The adapter checkpoint belongs to a session that is no longer active.",
      );
    }
    await saveCheckpointRecord(adapter, key, sessionBinding, resumeToken);
  });

  const open = (
    key: HarnessSessionKey,
    adapter: HarnessAdapter,
    requestedBinding: string | undefined,
    signal: AbortSignal,
  ): Promise<ManagedSession> => {
    const id = harnessSessionKey(key, adapter.id);
    const known = opened.get(id);
    if (known) return known.promise;
    const generation = (sessionGenerations.get(id) ?? 0) + 1;
    sessionGenerations.set(id, generation);
    const created = (async (): Promise<ManagedSession> => {
      let stored: StoredHarnessSession | null;
      try {
        stored = await options.persistence.sessions.load(key, adapter.id);
      } catch (error) {
        reportFailure(error, { phase: "session-load", adapterId: adapter.id, session: key }, {
          code: "SESSION_LOAD_FAILED",
          message: "The saved harness session could not be loaded.",
        });
        throw error;
      }
      if (stored?.sessionBinding !== undefined) {
        if (stored.sessionBinding.length === 0) {
          throw new HarnessRuntimeError(
            "SESSION_CHECKPOINT_INVALID",
            "The saved harness session binding is invalid. Reset the session before retrying.",
          );
        }
        if (stored.sessionBinding !== requestedBinding) {
          throw new HarnessRuntimeError(
            "SESSION_BINDING_MISMATCH",
            "The admitted execution does not match the saved harness session. Reset the session before retrying.",
          );
        }
      }
      let resumeToken: string | null = null;
      if (stored?.checkpoint) {
        assertStoredCheckpoint(stored.checkpoint);
        const contract = checkpointContracts.get(adapter.id) ?? null;
        if (!contract?.compatibleFormats.has(stored.checkpoint.format)) {
          throw new HarnessRuntimeError(
            "SESSION_CHECKPOINT_INCOMPATIBLE",
            "The saved harness session is incompatible with this adapter version. Reset the session before retrying.",
          );
        }
        resumeToken = stored.checkpoint.token;
      }
      try {
        if (signal.aborted) throw new HarnessAdapterInterruptedError();
        const persistCheckpoint = async (resumeToken: string | null): Promise<void> => {
          try {
            await saveCheckpoint(
              id,
              generation,
              adapter,
              key,
              sessionBindings.get(id) ?? requestedBinding ?? stored?.sessionBinding,
              resumeToken,
            );
          } catch (error) {
            reportFailure(error, { phase: "checkpoint", adapterId: adapter.id, session: key }, {
              code: "CHECKPOINT_SAVE_FAILED",
              message: "The harness session checkpoint could not be saved.",
            });
            throw error;
          }
        };
        const providerOpening = Promise.resolve(adapter.open({
          session: key,
          resumeToken,
          signal,
          persistCheckpoint,
        }));
        const session = await new Promise<HarnessAdapterSession>((resolve, reject) => {
          let retired = false;
          const abort = (): void => {
            if (retired) return;
            retired = true;
            reject(new HarnessAdapterInterruptedError());
          };
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
          void providerOpening.then(
            (value) => {
              signal.removeEventListener("abort", abort);
              if (retired || signal.aborted) {
                void closeAdapterSession(value).catch((error) => {
                  reportFailure(error, { phase: "session-close", adapterId: adapter.id, session: key }, {
                    code: "SESSION_CLOSE_FAILED",
                    message: "A retired harness session could not be closed.",
                  });
                });
                return;
              }
              retired = true;
              resolve(value);
            },
            (error) => {
              signal.removeEventListener("abort", abort);
              if (retired) return;
              retired = true;
              reject(error);
            },
          );
        });
        return {
          adapter,
          key: { ...key },
          session,
          ...(requestedBinding !== undefined
            ? { sessionBinding: requestedBinding }
              : stored?.sessionBinding !== undefined
              ? { sessionBinding: stored.sessionBinding }
              : {}),
          generation,
          active: false,
        };
      } catch (error) {
        if (!(error instanceof HarnessAdapterInterruptedError)) {
          reportFailure(error, { phase: "session-open", adapterId: adapter.id, session: key }, {
            code: "SESSION_OPEN_FAILED",
            message: `${adapter.id} session could not be opened.`,
          });
        }
        throw error;
      }
    })();
    const entry: ManagedSessionOpening = { promise: created, status: "pending" };
    opened.set(id, entry);
    void created.then(
      (managed) => {
        entry.status = "fulfilled";
        entry.managed = managed;
      },
      (error) => {
        entry.status = "rejected";
        if (!(error instanceof HarnessAdapterInterruptedError)) {
          reportFailure(error, { phase: "session-load", adapterId: adapter.id, session: key }, {
            code: "SESSION_RECOVERY_FAILED",
            message: "The saved harness session could not be recovered.",
          });
        }
        if (opened.get(id) === entry) opened.delete(id);
      },
    );
    return created;
  };

  const persistCheckpoint = async (managed: ManagedSession, key: HarnessSessionKey): Promise<void> => {
    const resumeToken = await managed.session.checkpoint?.() ?? null;
    const id = harnessSessionKey(key, managed.adapter.id);
    await saveCheckpoint(id, managed.generation, managed.adapter, key, managed.sessionBinding, resumeToken);
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
      const admission = snapshotAdmission(startOptions.admission, startOptions.inputPolicy);
      validateAdmission(request, admission);
      const adapter = adapterFor(request.adapterId);
      const inputPolicy = admission?.inputPolicy;
      const inputValidation = validateHarnessInput(request.input, inputPolicy, request.inlineContext);
      if (!inputValidation.valid) {
        throw new HarnessRuntimeError(
          "INVALID_INPUT",
          inputValidation.issues[0]?.message ?? "The harness input is invalid.",
        );
      }
      const runRequest = snapshotRunRequest(request);
      const sessionId = harnessSessionKey(runRequest.session, adapter.id);
      const knownSessionBinding = sessionBindings.get(sessionId);
      if (
        knownSessionBinding !== undefined
        && admission !== undefined
        && admission.sessionBinding !== knownSessionBinding
      ) {
        admissionMismatch("The admitted execution does not match this harness session.");
      }
      const runId = startOptions.runId ?? createId();
      const turnId = startOptions.turnId ?? createId();
      const controller = startOptions.controller ?? new AbortController();
      const suppliedContext = startOptions.context;
      // Reserve before the first event-store await. Otherwise close/reset can
      // observe no work, return, and let this run open a provider session
      // afterwards. A competing run still gets its durable SESSION_BUSY
      // terminal envelope instead of throwing synchronously from start().
      const ownsReservation = !reserved.has(sessionId);
      if (ownsReservation) reserved.add(sessionId);
      const queue = new AsyncQueue<HarnessEvent>();
      let managed: ManagedSession | null = null;
      let opening: Promise<ManagedSession> | null = null;
      let phase: "opening" | "running" | "sealing" | "sealed" = "opening";
      let stopping = false;
      let cancellationWork: Promise<void> | null = null;
      let publicCancelWork: Promise<void> | null = null;
      let cancellationDispatch: Promise<void> | null = null;
      let controlTail: Promise<void> = Promise.resolve();
      const controlLifetime = new AbortController();
      let replacementInFlight: AbortController | null = null;
      let preserveReplacementOnAbort = false;
      /** Interactions the durable event stream still says this turn can answer. */
      const openInteractions = new Set<string>();
      const respondingInteractions = new Set<string>();
      let eventTail: Promise<void> = Promise.resolve();

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
        if (!controlLifetime.signal.aborted) controlLifetime.abort();
        if (!preserveReplacementOnAbort && replacementInFlight && !replacementInFlight.signal.aborted) {
          replacementInFlight.abort();
        }
        // An externally-owned controller follows the exact same adapter
        // cancellation path as `run.cancel()`. The public cancel method can
        // still observe a dispatch failure; the listener itself must not
        // create an unhandled rejection.
        void dispatchCancellation().catch((error) => {
          reportFailure(error, {
            phase: "cancellation",
            adapterId: adapter.id,
            session: runRequest.session,
            runId,
            turnId,
          }, {
            code: "CANCELLATION_FAILED",
            message: "The adapter could not cancel the active turn.",
          });
        });
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

      const emit = (payload: HarnessEventPayload): Promise<void> => {
        const operation = eventTail.then(async () => {
          if (
            (payload.kind === "interaction-resolved" || payload.kind === "interaction-invalidated")
            && !openInteractions.has(payload.interactionId)
          ) return;
          let event: HarnessEvent;
          try {
            event = await options.persistence.events.append({
              schemaVersion: 1,
              session: runRequest.session,
              runId,
              turnId,
              adapterId: adapter.id,
              payload,
            });
          } catch (error) {
            reportFailure(error, {
              phase: "event-store",
              adapterId: adapter.id,
              session: runRequest.session,
              runId,
              turnId,
            }, {
              code: "EVENT_STORE_FAILED",
              message: "The harness event could not be persisted.",
            });
            throw error;
          }
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
        });
        eventTail = operation.then(() => undefined, () => undefined);
        return operation;
      };

      const done = (async (): Promise<HarnessTurnStatus> => {
        const startedAt = now().getTime();
        let status: HarnessTurnStatus = "completed";
        try {
          await emit({
            kind: "turn-started",
            ...(runRequest.model ? { model: runRequest.model } : {}),
            ...(runRequest.accountId ? { accountId: runRequest.accountId } : {}),
          });
          if (controller.signal.aborted) throw new HarnessAdapterInterruptedError();
          if (!ownsReservation) {
            throw new HarnessRuntimeError("SESSION_BUSY", "This harness session already has a running turn.");
          }
          opening = open(runRequest.session, adapter, admission?.sessionBinding, controller.signal);
          managed = await opening;
          if (managed.sessionBinding === undefined && admission?.sessionBinding !== undefined) {
            managed.sessionBinding = admission.sessionBinding;
          }
          if (managed.sessionBinding !== undefined) {
            sessionBindings.set(sessionId, managed.sessionBinding);
          }
          if (controller.signal.aborted) {
            if (opened.get(sessionId)?.promise === opening) opened.delete(sessionId);
            try {
              await closeAdapterSession(managed.session);
            } finally {
              managed = null;
            }
            throw new HarnessAdapterInterruptedError();
          }
          if (managed.active) throw new HarnessRuntimeError("SESSION_BUSY", "This harness session already has a running turn.");
          managed.active = true;
          let context: HarnessPreparedContext<HarnessContextContribution>;
          try {
            context = suppliedContext
              ?? await prepareContext(runRequest, runId, turnId, controller.signal);
          } catch (error) {
            reportFailure(error, {
              phase: "context",
              adapterId: adapter.id,
              session: runRequest.session,
              runId,
              turnId,
            }, {
              code: "CONTEXT_PREPARATION_FAILED",
              message: "Harness context preparation failed.",
            });
            throw error;
          }
          if (controller.signal.aborted) throw new HarnessAdapterInterruptedError();
          const toolContext = {
            session: runRequest.session,
            adapterId: adapter.id,
            runId,
            turnId,
            signal: controller.signal,
            context,
          };
          phase = "running";
          for await (const payload of managed.session.run({
            ...runRequest,
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
          if (!controlLifetime.signal.aborted) controlLifetime.abort();
          // Provider output has drained. Do not accept new input while the
          // checkpoint and terminal envelope are still becoming durable.
          phase = "sealing";
          if (controller.signal.aborted) status = "interrupted";
          try {
            await persistCheckpoint(managed, runRequest.session);
          } catch (error) {
            reportFailure(error, {
              phase: "checkpoint",
              adapterId: adapter.id,
              session: runRequest.session,
              runId,
              turnId,
            }, {
              code: "CHECKPOINT_SAVE_FAILED",
              message: "The harness session checkpoint could not be saved.",
            });
            throw error;
          }
        } catch (error) {
          // The provider iterable has already settled on every catch path.
          // Close follow-up admission before persisting a public error.
          if (!controlLifetime.signal.aborted) controlLifetime.abort();
          phase = "sealing";
          if (controller.signal.aborted || stopping || error instanceof HarnessAdapterInterruptedError) {
            status = "interrupted";
          }
          else {
            status = "error";
            reportFailure(error, {
              phase: "turn",
              adapterId: adapter.id,
              session: runRequest.session,
              runId,
              turnId,
            }, {
              code: "ADAPTER_ERROR",
              message: "The adapter turn failed.",
            });
            const failure = safeError(error);
            await emit({ kind: "error", ...failure });
          }
        } finally {
          if (!controlLifetime.signal.aborted) controlLifetime.abort();
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

      const trackedRun = { sessionId, controller, done };
      activeRuns.add(trackedRun);
      void done.then(
        () => activeRuns.delete(trackedRun),
        () => activeRuns.delete(trackedRun),
      );

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
            reportFailure(error, {
              phase: "cancellation",
              adapterId: adapter.id,
              session: runRequest.session,
              runId,
              turnId,
            }, {
              code: "CANCELLATION_FAILED",
              message: "The adapter could not cancel the active turn.",
            });
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
          const requestedStrategy = followUpOptions.strategy;
          const inputValidation = validateHarnessInlineContext(
            followUpRequest.inlineContext,
            followUpRequest.input,
          );
          if (!inputValidation.valid) {
            return Promise.reject(new HarnessRuntimeError(
              "INVALID_INPUT",
              inputValidation.issues[0]?.message ?? "The harness input is invalid.",
            ));
          }
          const admittedFollowUp = snapshotFollowUpRequest(followUpRequest);
          const replacementAdmissionProvided = followUpOptions.replacement?.admission !== undefined
            || followUpOptions.replacement?.inputPolicy !== undefined;
          const replacementAdmission = snapshotAdmission(
            followUpOptions.replacement?.admission,
            followUpOptions.replacement?.inputPolicy,
          );
          const replacementExecution = snapshotReplacementExecution(
            followUpOptions.replacement?.execution,
          );
          const replacement: HarnessReplacementOptions = followUpOptions.replacement
            ? {
              ...(followUpOptions.replacement.runId !== undefined ? { runId: followUpOptions.replacement.runId } : {}),
              ...(followUpOptions.replacement.turnId !== undefined ? { turnId: followUpOptions.replacement.turnId } : {}),
              ...(followUpOptions.replacement.controller ? { controller: followUpOptions.replacement.controller } : {}),
              ...(followUpOptions.replacement.context ? { context: followUpOptions.replacement.context } : {}),
              ...(replacementAdmission ? { admission: replacementAdmission } : {}),
              ...(replacementExecution ? { execution: replacementExecution } : {}),
            }
            : {};
          return serializeControl(async () => {
            ensureActiveTurn(admittedFollowUp.expectedTurnId);
            let capabilities: HarnessCapabilities;
            try {
              capabilities = await adapter.capabilities();
            } catch (error) {
              reportFailure(error, {
                phase: "follow-up",
                adapterId: adapter.id,
                session: runRequest.session,
                runId,
                turnId,
              }, {
                code: "FOLLOW_UP_CAPABILITIES_FAILED",
                message: "The adapter could not describe follow-up support.",
              });
              throw new HarnessRuntimeError("FOLLOW_UP_FAILED", "The adapter could not describe follow-up support.");
            }
            ensureActiveTurn(admittedFollowUp.expectedTurnId);
            const steering = capabilities.steering;
            const supported = steering?.support !== "unsupported" ? steering?.strategies ?? [] : [];
            const strategy = requestedStrategy
              ?? (steering?.preferred && supported.includes(steering.preferred)
                ? steering.preferred
                : supported[0]);
            if (!strategy || !supported.includes(strategy)) {
              throw new HarnessRuntimeError("FOLLOW_UP_UNSUPPORTED", "This adapter cannot accept an active-turn follow-up.");
            }
            const followUpAdmission = strategy === "replacement-turn" && replacementAdmissionProvided
              ? replacementAdmission
              : admission;
            const followUpInputPolicy = followUpAdmission?.inputPolicy;
            const policyValidation = validateHarnessInput(
              admittedFollowUp.input,
              followUpInputPolicy,
              admittedFollowUp.inlineContext,
            );
            if (!policyValidation.valid) {
              throw new HarnessRuntimeError(
                "INVALID_INPUT",
                policyValidation.issues[0]?.message ?? "The harness input is invalid.",
              );
            }

            if (strategy === "same-turn") {
              const target = ensureActiveTurn(admittedFollowUp.expectedTurnId);
              if (!target.session.steer) {
                throw new HarnessRuntimeError("FOLLOW_UP_UNSUPPORTED", "This adapter cannot accept a same-turn follow-up.");
              }
              try {
                await target.session.steer({
                  expectedTurnId: admittedFollowUp.expectedTurnId,
                  runId,
                  turnId,
                  input: admittedFollowUp.input,
                  ...(admittedFollowUp.inlineContext ? { inlineContext: admittedFollowUp.inlineContext } : {}),
                  ...(admittedFollowUp.metadata ? { metadata: admittedFollowUp.metadata } : {}),
                  signal: controller.signal,
                });
              } catch (error) {
                reportFailure(error, {
                  phase: "follow-up",
                  adapterId: adapter.id,
                  session: runRequest.session,
                  runId,
                  turnId,
                }, {
                  code: "FOLLOW_UP_FAILED",
                  message: "The adapter could not accept the follow-up.",
                });
                if (error instanceof HarnessRuntimeError || error instanceof HarnessAdapterError) throw error;
                throw new HarnessRuntimeError("FOLLOW_UP_FAILED", "The adapter could not accept the follow-up.");
              }
              return { strategy, run: publicRun };
            }

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
            if (replacementExecution !== undefined && !replacementAdmissionProvided) {
              admissionMismatch("Replacement execution changes require a newly admitted snapshot.");
            }
            const { inlineContext: _previousInlineContext, ...inheritedBase } = runRequest;
            let replacementBase = inheritedBase;
            if (replacementExecution !== undefined) {
              const {
                accountId: _previousAccountId,
                model: _previousModel,
                effort: _previousEffort,
                settings: _previousSettings,
                configuration: _previousConfiguration,
                ...stableBase
              } = inheritedBase;
              replacementBase = { ...stableBase, ...replacementExecution };
            }
            const replacementRequest: HarnessRunRequest = {
              ...replacementBase,
              input: admittedFollowUp.input,
              ...(admittedFollowUp.inlineContext ? { inlineContext: admittedFollowUp.inlineContext } : {}),
              ...(admittedFollowUp.metadata ? { metadata: admittedFollowUp.metadata } : {}),
            };
            validateAdmission(replacementRequest, followUpAdmission);
            const replacementSessionBinding = sessionBindings.get(sessionId);
            if (
              replacementSessionBinding !== undefined
              && followUpAdmission !== undefined
              && followUpAdmission.sessionBinding !== replacementSessionBinding
            ) {
              admissionMismatch("The admitted execution does not match this harness session.");
            }
            const replacementRunId = replacement.runId ?? createId();
            const replacementTurnId = replacement.turnId ?? createId();
            const replacementController = replacement.controller ?? new AbortController();
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
              validateAdmission(replacementRequest, followUpAdmission);
              const currentSessionBinding = sessionBindings.get(sessionId);
              if (
                currentSessionBinding !== undefined
                && followUpAdmission !== undefined
                && followUpAdmission.sessionBinding !== currentSessionBinding
              ) {
                admissionMismatch("The admitted execution does not match this harness session.");
              }
              ensureActiveTurn(admittedFollowUp.expectedTurnId);
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
                  ...(followUpAdmission ? { admission: followUpAdmission } : {}),
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
              reportFailure(error, {
                phase: "interaction",
                adapterId: adapter.id,
                session: runRequest.session,
                runId,
                turnId,
              }, {
                code: "INTERACTION_FAILED",
                message: "The adapter could not answer the interaction.",
              });
              if (
                error instanceof HarnessAdapterError
                && error.code === "INTERACTION_NOT_ACTIVE"
                && !controller.signal.aborted
                && !stopping
                && openInteractions.has(interactionId)
              ) {
                await emit({
                  kind: "interaction-invalidated",
                  interactionId,
                  reason: "provider-lost-request",
                });
              }
              throw error;
            }
          });
        },
        stopSubagent(taskId) {
          if (taskId.trim().length === 0) {
            return Promise.reject(new HarnessRuntimeError(
              "INVALID_SUBAGENT_ID",
              "A subagent task id cannot be empty.",
            ));
          }
          return serializeControl(async () => {
            const target = ensureActiveTurn(turnId);
            if (!target.session.stopSubagent) {
              throw new HarnessRuntimeError(
                "SUBAGENT_CONTROL_UNSUPPORTED",
                `${adapter.id} cannot stop active subagents.`,
              );
            }
            try {
              const operation = Promise.resolve(target.session.stopSubagent({
                taskId,
                runId,
                turnId,
                signal: controlLifetime.signal,
              }));
              return await new Promise<boolean>((resolve, reject) => {
                let settled = false;
                const retire = (): void => {
                  if (settled) return;
                  settled = true;
                  reject(new HarnessAdapterInterruptedError());
                };
                controlLifetime.signal.addEventListener("abort", retire, { once: true });
                if (controlLifetime.signal.aborted) retire();
                void operation.then(
                  (value) => {
                    controlLifetime.signal.removeEventListener("abort", retire);
                    if (settled) return;
                    settled = true;
                    resolve(value);
                  },
                  (error) => {
                    controlLifetime.signal.removeEventListener("abort", retire);
                    if (settled) return;
                    settled = true;
                    reject(error);
                  },
                );
              });
            } catch (error) {
              if (error instanceof HarnessAdapterInterruptedError && controlLifetime.signal.aborted) {
                throw new HarnessRuntimeError(
                  "TURN_NOT_ACTIVE",
                  "This harness turn is no longer accepting subagent controls.",
                );
              }
              reportFailure(error, {
                phase: "subagent",
                adapterId: adapter.id,
                session: runRequest.session,
                runId,
                turnId,
              }, {
                code: "SUBAGENT_CONTROL_FAILED",
                message: "The adapter could not stop the active subagent.",
              });
              if (error instanceof HarnessRuntimeError || error instanceof HarnessAdapterError) throw error;
              throw new HarnessRuntimeError(
                "SUBAGENT_CONTROL_FAILED",
                "The adapter could not stop the active subagent.",
              );
            }
          });
        },
      };
      return publicRun;
    },

    async resetSession(session, adapterId) {
      if (closed) throw new HarnessRuntimeError("RUNTIME_CLOSED", "The harness runtime is closed.");
      adapterFor(adapterId);
      const id = harnessSessionKey(session, adapterId);
      if (reserved.has(id)) {
        throw new HarnessRuntimeError("SESSION_BUSY", "This harness session already has a running turn.");
      }
      reserved.add(id);
      try {
        sessionGenerations.set(id, (sessionGenerations.get(id) ?? 0) + 1);
        let closeError: unknown;
        let closeFailed = false;
        const known = opened.get(id);
        if (known) {
          let managed: ManagedSession | null = null;
          try {
            managed = await known.promise;
          } catch {
            if (opened.get(id) === known) opened.delete(id);
          }
          if (managed) {
            if (managed.active) {
              throw new HarnessRuntimeError("SESSION_BUSY", "This harness session already has a running turn.");
            }
            // Retire the cached object before close. Once reset begins, a
            // close failure leaves the provider session's state uncertain and
            // it must never be reused by a later turn.
            if (opened.get(id) === known) opened.delete(id);
            try {
              await closeAdapterSession(managed.session);
            } catch (error) {
              closeFailed = true;
              reportFailure(error, { phase: "session-reset", adapterId, session }, {
                code: "SESSION_CLOSE_FAILED",
                message: "The harness session could not be closed for reset.",
              });
              closeError = error;
            }
          }
        }
        try {
          // Removal follows every earlier checkpoint write for this session.
          // The generation was retired above, so a late writer queued during
          // close is refused before it can run.
          await serializeSessionMutation(
            id,
            () => options.persistence.sessions.remove(session, adapterId),
          );
        } catch (error) {
          reportFailure(error, { phase: "session-reset", adapterId, session }, {
            code: "SESSION_RESET_FAILED",
            message: "The saved harness session could not be reset.",
          });
          throw error;
        }
        sessionBindings.delete(id);
        if (closeFailed) throw closeError;
      } finally {
        reserved.delete(id);
      }
    },

    close() {
      if (closeWork) return closeWork;
      closed = true;
      closeWork = (async () => {
        const runs = [...activeRuns];
        const retiringIds = new Set([
          ...opened.keys(),
          ...sessionMutationTails.keys(),
          ...runs.map((run) => run.sessionId),
        ]);
        for (const id of retiringIds) {
          sessionGenerations.set(id, (sessionGenerations.get(id) ?? 0) + 1);
        }
        for (const run of runs) {
          if (!run.controller.signal.aborted) run.controller.abort();
        }

        const closeSessions = async (
          sessions: readonly ManagedSessionOpening[],
        ): Promise<PromiseSettledResult<void>[]> => {
          return Promise.allSettled(sessions.flatMap((entry) => {
            if (entry.status !== "fulfilled" || !entry.managed?.session.close) return [];
            const managed = entry.managed;
            return [closeAdapterSession(managed.session).catch((error) => {
              reportFailure(error, {
                phase: "session-close",
                adapterId: managed.adapter.id,
                session: managed.key,
              }, {
                code: "SESSION_CLOSE_FAILED",
                message: "The harness session could not be closed.",
              });
              throw error;
            })];
          }));
        };

        // Closing starts before the run barrier. Some adapters can only drain
        // an active iterator by closing its provider session, particularly
        // when turn cancellation is unsupported.
        const initialCloseResults = closeSessions([...opened.values()]);
        try {
          const [, firstCloseResults] = await Promise.all([
            Promise.allSettled(runs.map((run) => run.done)),
            initialCloseResults,
          ]);

          // A run registered before close may have entered `opened` while its
          // turn-start event was settling. Retire that late cache entry too;
          // closeAdapterSession makes the operation idempotent per session.
          for (const id of opened.keys()) {
            if (!retiringIds.has(id)) {
              sessionGenerations.set(id, (sessionGenerations.get(id) ?? 0) + 1);
            }
          }
          const lateCloseResults = await closeSessions([...opened.values()]);
          await Promise.allSettled([...sessionMutationTails.values()]);
          const failedClose = [...firstCloseResults, ...lateCloseResults]
            .find((result) => result.status === "rejected");
          if (failedClose?.status === "rejected") throw failedClose.reason;
        } finally {
          opened.clear();
          sessionBindings.clear();
          sessionGenerations.clear();
          sessionMutationTails.clear();
          activeRuns.clear();
        }
      })();
      return closeWork;
    },
  };
  return runtime;
}
