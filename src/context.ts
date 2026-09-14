/** Turn-scoped context supplied by the host application. */

import type { HarnessInput, HarnessRunRequest } from "./protocol.js";

export type HarnessContextFailureMode = "required" | "optional";

/**
 * Provider-neutral context an adapter can add to a turn.
 *
 * `instructions` are trusted, application-authored rules. `content` is
 * external/domain data and adapters must preserve that distinction when they
 * render a provider request. `state` is application-owned turn state shared
 * with tools; the runtime never persists it.
 */
export interface HarnessContextContribution {
  instructions?: string;
  content: readonly HarnessInput[];
  state?: unknown;
}

export interface HarnessContextPrepareRequest extends HarnessRunRequest {
  runId: string;
  turnId: string;
  signal: AbortSignal;
}

export interface HarnessContextSource<TValue = HarnessContextContribution, TRequest = HarnessContextPrepareRequest> {
  /** Stable, application-owned identifier such as `acme:knowledge-base`. */
  id: string;
  failureMode: HarnessContextFailureMode;
  prepare(request: TRequest): Promise<TValue | null> | TValue | null;
  /** Classifies application errors that mean this source is unavailable. */
  isUnavailableError?: (error: unknown) => boolean;
}

export interface HarnessPreparedContextSource<TValue = HarnessContextContribution> {
  sourceId: string;
  value: TValue;
}

export interface HarnessUnavailableContextSource {
  sourceId: string;
  code: string;
  message: string;
  retryable?: boolean;
}

export interface HarnessPreparedContext<TValue = HarnessContextContribution> {
  /** Ready sources, in registration order. */
  sources: readonly HarnessPreparedContextSource<TValue>[];
  /** Optional sources that could not contribute to this turn. */
  unavailable: readonly HarnessUnavailableContextSource[];
}

export interface HarnessContextPreparationOptions<TValue, TRequest> {
  /** Receives raw failures for host diagnostics. The runtime never persists them. */
  onError?: (error: unknown, source: HarnessContextSource<TValue, TRequest>, request: TRequest) => void;
}

/** A source failure whose details are explicitly safe to expose to an adapter. */
export class HarnessContextSourceError extends Error {
  constructor(
    readonly code: string,
    readonly publicMessage: string,
    readonly retryable = false,
  ) {
    super(publicMessage);
    this.name = "HarnessContextSourceError";
  }
}

/** A required source prevented the turn from starting. */
export class HarnessContextPreparationError extends Error {
  constructor(
    readonly sourceId: string,
    readonly code: string,
    readonly publicMessage: string,
    readonly retryable = false,
  ) {
    super(publicMessage);
    this.name = "HarnessContextPreparationError";
  }
}

function validateSources<TValue, TRequest>(sources: readonly HarnessContextSource<TValue, TRequest>[]): void {
  const ids = new Set<string>();
  for (const source of sources) {
    if (source.id.trim() === "") throw new Error("context source identifiers cannot be empty");
    if (ids.has(source.id)) throw new Error(`duplicate context source: ${source.id}`);
    if (source.failureMode !== "required" && source.failureMode !== "optional") {
      throw new Error(`invalid failure mode for context source: ${source.id}`);
    }
    ids.add(source.id);
  }
}

function safeFailure<TValue, TRequest>(
  source: HarnessContextSource<TValue, TRequest>,
  error?: unknown,
): HarnessUnavailableContextSource {
  if (error instanceof HarnessContextSourceError) {
    return {
      sourceId: source.id,
      code: error.code,
      message: error.publicMessage,
      ...(error.retryable ? { retryable: true } : {}),
    };
  }
  return {
    sourceId: source.id,
    code: "CONTEXT_SOURCE_UNAVAILABLE",
    message: `Context source "${source.id}" is unavailable.`,
  };
}

function unavailable<TValue, TRequest>(
  source: HarnessContextSource<TValue, TRequest>,
  error?: unknown,
): HarnessUnavailableContextSource {
  const failure = safeFailure(source, error);
  if (source.failureMode === "required") {
    throw new HarnessContextPreparationError(
      failure.sourceId,
      failure.code,
      failure.message,
      failure.retryable ?? false,
    );
  }
  return failure;
}

function recognized<TValue, TRequest>(
  source: HarnessContextSource<TValue, TRequest>,
  error: unknown,
): boolean {
  return error instanceof HarnessContextSourceError || source.isUnavailableError?.(error) === true;
}

function recordFailure<TValue, TRequest>(
  error: unknown,
  source: HarnessContextSource<TValue, TRequest>,
  request: TRequest,
  options: HarnessContextPreparationOptions<TValue, TRequest>,
): HarnessUnavailableContextSource {
  options.onError?.(error, source, request);
  if (!recognized(source, error)) throw error;
  return unavailable(source, error);
}

/** Prepare all sources concurrently while preserving their registration order. */
export async function prepareHarnessContext<TValue, TRequest>(
  sources: readonly HarnessContextSource<TValue, TRequest>[],
  request: TRequest,
  options: HarnessContextPreparationOptions<TValue, TRequest> = {},
): Promise<HarnessPreparedContext<TValue>> {
  validateSources(sources);
  const settled = await Promise.all(sources.map(async (source) => {
    try {
      const value = await source.prepare(request);
      return value === null
        ? { unavailable: unavailable(source) }
        : { ready: { sourceId: source.id, value } };
    } catch (error) {
      return { unavailable: recordFailure(error, source, request, options) };
    }
  }));
  return {
    sources: settled.flatMap((result) => result.ready ? [result.ready] : []),
    unavailable: settled.flatMap((result) => result.unavailable ? [result.unavailable] : []),
  };
}

/**
 * Synchronous preparation for hosts whose existing turn setup is synchronous.
 * A Promise returned by a source is a programming error and is never treated
 * as source unavailability.
 */
export function prepareHarnessContextSync<TValue, TRequest>(
  sources: readonly HarnessContextSource<TValue, TRequest>[],
  request: TRequest,
  options: HarnessContextPreparationOptions<TValue, TRequest> = {},
): HarnessPreparedContext<TValue> {
  validateSources(sources);
  const ready: HarnessPreparedContextSource<TValue>[] = [];
  const failures: HarnessUnavailableContextSource[] = [];
  for (const source of sources) {
    let value: Promise<TValue | null> | TValue | null;
    try {
      value = source.prepare(request);
    } catch (error) {
      failures.push(recordFailure(error, source, request, options));
      continue;
    }
    if (value !== null && typeof value === "object" && "then" in value) {
      throw new TypeError(`context source "${source.id}" returned a Promise during synchronous preparation`);
    }
    if (value === null) failures.push(unavailable(source));
    else ready.push({ sourceId: source.id, value });
  }
  return { sources: ready, unavailable: failures };
}
