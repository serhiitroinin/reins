/** Framework-neutral black-box checks for harness adapters. */

import {
  createHarness,
  HarnessAdapterError,
  HarnessRuntimeError,
  type HarnessAdapter,
  type HarnessAdapterEvent,
  type HarnessRun,
  type HarnessRuntime,
  type HarnessRuntimeOptions,
  type HarnessStartOptions,
} from "../runtime.js";
import {
  createMemoryPersistence,
} from "../stores.js";
import {
  harnessSubagentControls,
  type HarnessCapabilities,
  type HarnessEvent,
  type HarnessInlineContext,
  type HarnessInput,
  type HarnessInteraction,
  type HarnessInteractionResponse,
  type HarnessRunRequest,
  type HarnessSessionKey,
} from "../protocol.js";
import type { HarnessDiscovery, HarnessEngineProfile, HarnessLimitSnapshot, HarnessModelCatalog } from "../profile.js";
import { createToolHost } from "../tools.js";

export type AdapterConformanceScenario =
  | "basic"
  | "safe-error"
  | "unsafe-error"
  | "cancel"
  | "interaction"
  | "resume-initial"
  | "resume-restored"
  | "tools"
  | "context"
  | "typed-context"
  | "steering"
  | "subagent-stop"
  | "subagent-stop-false"
  | "subagent-stop-safe-error"
  | "subagent-stop-race"
  | "discovery";

export interface AdapterConformanceDiscovery {
  profile: HarnessDiscovery<HarnessEngineProfile>;
  models: HarnessDiscovery<HarnessModelCatalog>;
  limits: HarnessDiscovery<HarnessLimitSnapshot>;
}

export interface AdapterConformanceFixture {
  adapterId: string;
  /** The real adapter under test, constructed with a deterministic fake provider. */
  adapter: HarnessAdapter;
  /** Select provider traffic without replacing or wrapping the adapter. */
  useScenario(scenario: AdapterConformanceScenario): void;
  /** Count provider transport openings so rejected input can be proven pre-provider. */
  providerOpens(): number;
  /** Count provider-level subagent stop dispatches for race assertions. */
  subagentControls(): number;
  discovery: AdapterConformanceDiscovery;
}

export interface AdapterConformanceCase {
  name: string;
  status: "passed" | "failed" | "skipped";
  message?: string;
}

export interface AdapterConformanceReport {
  passed: boolean;
  cases: readonly AdapterConformanceCase[];
}

export interface AdapterConformanceOptions {
  fixture: AdapterConformanceFixture;
  timeoutMs?: number;
}

const TYPED_CONTEXT_INPUT = [
  {
    type: "context-reference",
    contextId: "conformance-context-second",
    referenceId: "conformance-reference-second",
  },
  { type: "text", text: "conformance-context-separator" },
  {
    type: "context-reference",
    contextId: "conformance-context-first",
    referenceId: "conformance-reference-first",
  },
] as const satisfies readonly HarnessInput[];

const TYPED_INLINE_CONTEXT = {
  version: 1,
  records: [
    {
      version: 1,
      id: "conformance-context-first",
      kind: "conformance:item",
      label: "First",
      payload: "first-context-value",
    },
    {
      version: 1,
      id: "conformance-context-second",
      kind: "conformance:item",
      label: "Second",
      payload: "second-context-value",
    },
  ],
} as const satisfies HarnessInlineContext;

export const CONFORMANCE = {
  text: "conformance-ok",
  waitingText: "conformance-waiting",
  resumedText: "conformance-resumed",
  toolName: "conformance_echo",
  toolInput: "tool-input",
  toolOutput: "tool-ok",
  contextSourceId: "conformance:context",
  contextText: "context-ok",
  typedContextInput: TYPED_CONTEXT_INPUT,
  typedInlineContext: TYPED_INLINE_CONTEXT,
  typedContextText: "typed-context-ok",
  followUpText: "conformance-follow-up",
  subagentTaskId: "conformance-subagent",
  resumeToken: "conformance-resume-token",
  interaction: {
    id: "conformance-interaction",
    kind: "question",
    title: "Conformance question",
    acceptsText: true,
  } satisfies HarnessInteraction,
  interactionResponse: {
    choiceId: "continue",
    text: "continue",
    labels: ["continue"],
  } satisfies HarnessInteractionResponse,
  safeError: {
    code: "CONFORMANCE_SAFE_ERROR",
    message: "The conformance provider is unavailable.",
  },
  unsafeSecret: "conformance-secret-must-not-persist",
} as const;

const SESSION: HarnessSessionKey = {
  tenantId: "conformance-tenant",
  actorId: "conformance-actor",
  threadId: "conformance-thread",
};

function request(adapterId: string, session: HarnessSessionKey = SESSION): HarnessRunRequest {
  return {
    session,
    adapterId,
    input: [{ type: "text", text: "Run the adapter conformance scenario." }],
  };
}

function typedContextRequest(adapterId: string): HarnessRunRequest {
  return {
    ...request(adapterId),
    input: CONFORMANCE.typedContextInput,
    inlineContext: CONFORMANCE.typedInlineContext,
  };
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function same(actual: unknown, expected: unknown, message: string): void {
  check(JSON.stringify(actual) === JSON.stringify(expected), message);
}

async function collect(stream: AsyncIterable<HarnessEvent>): Promise<HarnessEvent[]> {
  const events: HarnessEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

async function bounded<T>(promise: Promise<T>, timeoutMs: number, name: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${name} did not settle within ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

type Cleanup = () => Promise<void> | void;
type DeferCleanup = (cleanup: Cleanup) => void;

function scopedRuntime(
  defer: DeferCleanup,
  timeoutMs: number,
  options: HarnessRuntimeOptions,
): {
  runtime: HarnessRuntime;
  start: (request: HarnessRunRequest, options?: HarnessStartOptions) => HarnessRun;
} {
  const runtime = createHarness(options);
  const pending = new Set<HarnessRun>();
  defer(async () => {
    for (const run of pending) {
      await bounded(run.cancel(), timeoutMs, "run cleanup").catch(() => undefined);
    }
    await bounded(runtime.close(), timeoutMs, "runtime cleanup");
  });
  return {
    runtime,
    start(runRequest, startOptions?: HarnessStartOptions) {
      const run = runtime.start(runRequest, startOptions);
      pending.add(run);
      void run.done.then(
        () => pending.delete(run),
        () => pending.delete(run),
      );
      return run;
    },
  };
}

function validateCapabilities(value: HarnessCapabilities): void {
  for (const key of [
    "resume", "cancel", "interactions", "tools", "images", "thinking", "plans",
    "usage", "subagents", "shell", "filesystem", "network",
  ] as const) {
    check(["stable", "experimental", "unsupported"].includes(value[key].support), `invalid capability support: ${key}`);
  }
  for (const key of Object.keys(value.extensions ?? {})) {
    check(key.includes(":"), `capability extension must use a namespaced key: ${key}`);
  }
  if (value.interactions.recovery !== undefined) {
    check(
      value.interactions.recovery === "live-only"
        || value.interactions.recovery === "provider-replay",
      "invalid interaction recovery mode",
    );
  }
  if (value.steering) {
    check(
      ["stable", "experimental", "unsupported"].includes(value.steering.support),
      "invalid steering capability support",
    );
    check(new Set(value.steering.strategies).size === value.steering.strategies.length, "duplicate steering strategy");
    check(
      value.steering.strategies.every((strategy) => strategy === "same-turn" || strategy === "replacement-turn"),
      "invalid steering strategy",
    );
    if (value.steering.preferred) {
      check(value.steering.strategies.includes(value.steering.preferred), "preferred steering strategy is not declared");
    }
  }
  const subagentControls = value.subagents.controls ?? [];
  check(new Set(subagentControls).size === subagentControls.length, "duplicate subagent control");
  check(subagentControls.every((control) => control === "stop"), "invalid subagent control");
  if (value.subagents.support === "unsupported") {
    check(subagentControls.length === 0, "unsupported subagents cannot declare controls");
  }
}

function validateEnvelope(events: readonly HarnessEvent[], adapterId: string, session: HarnessSessionKey): void {
  check(events.length >= 2, "a run must emit start and completion events");
  check(events[0]?.payload.kind === "turn-started", "the first event must start the turn");
  check(events.at(-1)?.payload.kind === "turn-completed", "the final event must complete the turn");
  check(events.filter((event) => event.payload.kind === "turn-completed").length === 1, "a run must complete exactly once");
  for (const [index, event] of events.entries()) {
    check(event.schemaVersion === 1, "event schema version must be 1");
    if (index > 0) {
      check(event.sequence === events[index - 1]!.sequence + 1, "event sequences must be monotonic");
    }
    check(event.adapterId === adapterId, "event adapter identity changed");
    same(event.session, session, "event session identity changed");
    check(event.runId.length > 0 && event.turnId.length > 0 && event.eventId.length > 0, "event identifiers must not be empty");
  }
}

async function runAndCollect(
  defer: DeferCleanup,
  timeoutMs: number,
  adapter: HarnessAdapter,
  runRequest = request(adapter.id),
  startOptions?: HarnessStartOptions,
) {
  const harness = scopedRuntime(defer, timeoutMs, {
    adapters: [adapter],
    persistence: createMemoryPersistence(),
  });
  const run = harness.start(runRequest, startOptions);
  const events = await collect(run.events);
  const status = await run.done;
  return { events, status };
}

/**
 * Exercise an adapter through the public runtime. The fixture translates the
 * named scenarios into deterministic fake provider traffic.
 */
export async function runAdapterConformance(options: AdapterConformanceOptions): Promise<AdapterConformanceReport> {
  const { fixture } = options;
  const timeoutMs = options.timeoutMs ?? 2_000;
  const cases: AdapterConformanceCase[] = [];
  let capabilities: HarnessCapabilities | undefined;

  const runCase = async (name: string, execute: (defer: DeferCleanup) => Promise<void>): Promise<void> => {
    const cleanups: Cleanup[] = [];
    let failure: string | undefined;
    try {
      await bounded(execute((cleanup) => cleanups.push(cleanup)), timeoutMs, name);
    } catch (error) {
      failure = error instanceof Error ? error.message : "Unknown conformance failure.";
    } finally {
      for (const cleanup of cleanups.reverse()) {
        try {
          await bounded(Promise.resolve(cleanup()), timeoutMs, `${name} cleanup`);
        } catch (error) {
          failure ??= error instanceof Error ? error.message : "Unknown conformance cleanup failure.";
        }
      }
    }
    cases.push(failure ? { name, status: "failed", message: failure } : { name, status: "passed" });
  };
  const skip = (name: string, message: string): void => { cases.push({ name, status: "skipped", message }); };
  const adapter = (scenario: AdapterConformanceScenario): HarnessAdapter => {
    fixture.useScenario(scenario);
    check(fixture.adapter.id === fixture.adapterId, `adapter id changed in ${scenario}`);
    return fixture.adapter;
  };

  await runCase("identity and capabilities", async () => {
    check(fixture.adapterId.trim().length > 0, "adapter id must not be empty");
    capabilities = await adapter("basic").capabilities();
    validateCapabilities(capabilities);
    if (capabilities.resume.support !== "unsupported") {
      check(
        fixture.adapter.checkpoint?.format.trim().length,
        "a resumable adapter must declare a checkpoint format",
      );
    }
  });

  await runCase("host input policy", async (defer) => {
    const persistence = createMemoryPersistence();
    const harness = scopedRuntime(defer, timeoutMs, {
      adapters: [adapter("basic")],
      persistence,
    });
    const inputPolicy = {
      modalities: {
        text: { support: "stable" as const },
        image: { support: "unsupported" as const },
      },
    };
    const opensBeforeRejections = fixture.providerOpens();
    let failure: unknown;
    try {
      harness.start({
        ...request(fixture.adapterId),
        input: [{ type: "image", mediaType: "image/png", data: new Uint8Array([1]) }],
      }, { inputPolicy });
    } catch (error) {
      failure = error;
    }
    check(
      failure instanceof HarnessRuntimeError && failure.code === "INVALID_INPUT",
      "host input policy did not reject unsupported input",
    );
    same(
      await persistence.events.list(SESSION, fixture.adapterId),
      [],
      "rejected input wrote a lifecycle event",
    );

    let unsupportedContextFailure: unknown;
    try {
      harness.start(typedContextRequest(fixture.adapterId), {
        inputPolicy: {
          modalities: {
            text: { support: "stable" },
            "context-reference": { support: "unsupported" },
          },
        },
      });
    } catch (error) {
      unsupportedContextFailure = error;
    }
    check(
      unsupportedContextFailure instanceof HarnessRuntimeError
        && unsupportedContextFailure.code === "INVALID_INPUT",
      "host input policy did not reject unsupported context references before provider open",
    );

    let staleContextFailure: unknown;
    try {
      harness.start({
        ...typedContextRequest(fixture.adapterId),
        inlineContext: {
          version: 1,
          records: [CONFORMANCE.typedInlineContext.records[0]],
        },
      }, {
        inputPolicy: {
          modalities: {
            text: { support: "stable" },
            "context-reference": { support: "stable" },
          },
        },
      });
    } catch (error) {
      staleContextFailure = error;
    }
    check(
      staleContextFailure instanceof HarnessRuntimeError && staleContextFailure.code === "INVALID_INPUT",
      "stale context reference was not rejected before provider open",
    );
    same(
      await persistence.events.list(SESSION, fixture.adapterId),
      [],
      "rejected context input wrote a lifecycle event",
    );
    check(
      fixture.providerOpens() === opensBeforeRejections,
      "rejected input reached the provider",
    );

    const valid = harness.start(request(fixture.adapterId), { inputPolicy });
    const events = await collect(valid.events);
    check(await valid.done === "completed", "valid policy input did not complete");
    validateEnvelope(events, fixture.adapterId, SESSION);
  });

  const declaredContextPolicy = fixture.discovery.profile.status === "available"
    ? fixture.discovery.profile.value.inputPolicy
    : undefined;
  const declaredContextSupport = declaredContextPolicy?.modalities?.["context-reference"]?.support;
  if (!declaredContextPolicy || declaredContextSupport === undefined || declaredContextSupport === "unsupported") {
    skip("ordered typed context", "adapter profile does not report context-reference input support");
  } else await runCase("ordered typed context", async (defer) => {
    const result = await runAndCollect(
      defer,
      timeoutMs,
      adapter("typed-context"),
      typedContextRequest(fixture.adapterId),
      { inputPolicy: declaredContextPolicy },
    );
    check(result.status === "completed", "typed context turn did not complete");
    validateEnvelope(result.events, fixture.adapterId, SESSION);
    same(
      result.events.slice(1, -1).map((event) => event.payload),
      [{ kind: "assistant-text", text: CONFORMANCE.typedContextText }],
      "ordered typed context changed at the adapter boundary",
    );
  });

  await runCase("host execution admission", async (defer) => {
    const persistence = createMemoryPersistence();
    const harness = scopedRuntime(defer, timeoutMs, {
      adapters: [adapter("basic")],
      persistence,
    });
    const admittedRequest: HarnessRunRequest = {
      ...request(fixture.adapterId),
      settings: { controls: { "conformance:fast": true } },
    };
    const admission = {
      adapterId: fixture.adapterId,
      accountId: null,
      model: null,
      effort: null,
      settings: {
        permission: null,
        controls: { "conformance:fast": true },
      },
      inputPolicy: {
        modalities: { text: { support: "stable" as const } },
      },
      sessionBinding: "conformance-binding",
    };
    let mismatch: unknown;
    try {
      harness.start(admittedRequest, {
        admission: {
          ...admission,
          settings: { ...admission.settings, controls: { "conformance:fast": false } },
        },
      });
    } catch (error) {
      mismatch = error;
    }
    check(
      mismatch instanceof HarnessRuntimeError && mismatch.code === "ADMISSION_MISMATCH",
      "host admission did not reject control drift",
    );
    same(
      await persistence.events.list(SESSION, fixture.adapterId),
      [],
      "rejected admission wrote a lifecycle event",
    );

    const valid = harness.start(admittedRequest, { admission });
    admission.settings.controls["conformance:fast"] = false;
    const events = await collect(valid.events);
    check(await valid.done === "completed", "valid admitted execution did not complete");
    validateEnvelope(events, fixture.adapterId, SESSION);
    const eventCount = events.length;

    let bindingMismatch: unknown;
    try {
      harness.start(admittedRequest, {
        admission: {
          ...admission,
          settings: { ...admission.settings, controls: { "conformance:fast": true } },
          sessionBinding: "changed-binding",
        },
      });
    } catch (error) {
      bindingMismatch = error;
    }
    check(
      bindingMismatch instanceof HarnessRuntimeError && bindingMismatch.code === "ADMISSION_MISMATCH",
      "host admission did not reject session-binding drift",
    );
    check(
      (await persistence.events.list(SESSION, fixture.adapterId)).length === eventCount,
      "session-binding drift wrote a lifecycle event",
    );
  });

  await runCase("event lifecycle", async (defer) => {
    const result = await runAndCollect(defer, timeoutMs, adapter("basic"));
    check(result.status === "completed", "basic turn did not complete");
    validateEnvelope(result.events, fixture.adapterId, SESSION);
    const body = result.events.slice(1, -1).map((event) => event.payload);
    same(body, [{ kind: "assistant-text", text: CONFORMANCE.text }], "basic adapter events changed");
  });

  await runCase("unsafe error redaction", async (defer) => {
    const result = await runAndCollect(defer, timeoutMs, adapter("unsafe-error"));
    check(result.status === "error", "unsafe provider failure did not fail the turn");
    const failure = result.events.find((event) => event.payload.kind === "error")?.payload;
    same(failure, { kind: "error", code: "ADAPTER_ERROR", message: "The adapter turn failed." }, "unsafe error was not redacted");
    check(!JSON.stringify(result.events).includes(CONFORMANCE.unsafeSecret), "unsafe error text reached persistence");
    validateEnvelope(result.events, fixture.adapterId, SESSION);
  });

  await runCase("safe error preservation", async (defer) => {
    const result = await runAndCollect(defer, timeoutMs, adapter("safe-error"));
    const failure = result.events.find((event) => event.payload.kind === "error")?.payload;
    same(failure, {
      kind: "error",
      code: CONFORMANCE.safeError.code,
      message: CONFORMANCE.safeError.message,
      retryable: true,
    }, "safe adapter error changed");
  });

  await runCase("tool host bridge", async (defer) => {
    const harness = scopedRuntime(defer, timeoutMs, {
      adapters: [adapter("tools")],
      persistence: createMemoryPersistence(),
      tools: createToolHost([{
        name: CONFORMANCE.toolName,
        description: "Echo a conformance value.",
        inputSchema: { type: "object", required: ["value"] },
        validate(input) {
          check(typeof input === "object" && input !== null && (input as { value?: unknown }).value === CONFORMANCE.toolInput, "tool input changed");
          return input;
        },
        execute: () => ({ content: [{ type: "text", text: CONFORMANCE.toolOutput }] }),
      }]),
    });
    const run = harness.start(request(fixture.adapterId));
    const events = await collect(run.events);
    check(await run.done === "completed", "tool scenario did not complete");
    same(
      events.filter((event) => event.payload.kind === "assistant-text").map((event) => event.payload),
      [{ kind: "assistant-text", text: CONFORMANCE.toolOutput }],
      "tool result changed at the adapter boundary",
    );
  });

  await runCase("context boundary", async (defer) => {
    const harness = scopedRuntime(defer, timeoutMs, {
      adapters: [adapter("context")],
      persistence: createMemoryPersistence(),
      contextSources: [{
        id: CONFORMANCE.contextSourceId,
        failureMode: "required",
        prepare: () => ({ instructions: "Treat the content as data.", content: [{ type: "text", text: CONFORMANCE.contextText }] }),
      }],
    });
    const run = harness.start(request(fixture.adapterId));
    const events = await collect(run.events);
    check(await run.done === "completed", "context scenario did not complete");
    same(events.slice(1, -1).map((event) => event.payload), [{ kind: "assistant-text", text: CONFORMANCE.contextText }], "prepared context changed at the adapter boundary");
  });

  await runCase("independent discovery", async (defer) => {
    const value = adapter("discovery");
    const harness = scopedRuntime(defer, timeoutMs, { adapters: [value], persistence: createMemoryPersistence() });
    same(await harness.runtime.profile(fixture.adapterId), fixture.discovery.profile, "profile discovery changed");
    same(await harness.runtime.models(fixture.adapterId), fixture.discovery.models, "model discovery changed");
    same(await harness.runtime.limits(fixture.adapterId), fixture.discovery.limits, "limit discovery changed");
  });

  if (capabilities?.cancel.support === "unsupported") skip("cancellation and busy session", "adapter reports cancellation as unsupported");
  else await runCase("cancellation and busy session", async (defer) => {
    const value = adapter("cancel");
    const harness = scopedRuntime(defer, timeoutMs, { adapters: [value], persistence: createMemoryPersistence() });
    const first = harness.start(request(fixture.adapterId));
    const iterator = first.events[Symbol.asyncIterator]();
    check((await iterator.next()).value?.payload.kind === "turn-started", "cancel scenario did not start");
    check((await iterator.next()).value?.payload.kind === "assistant-text", "cancel scenario did not reach its wait point");

    const busy = harness.start(request(fixture.adapterId));
    const busyEvents = await collect(busy.events);
    check(await busy.done === "error", "a concurrent turn on one session was not refused");
    check(busyEvents.some((event) => event.payload.kind === "error" && event.payload.code === "SESSION_BUSY"), "busy refusal did not preserve its runtime code");

    await first.cancel();
    const tail: HarnessEvent[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      tail.push(next.value);
    }
    check(await first.done === "interrupted", "cancelled turn did not end as interrupted");
    check(tail.at(-1)?.payload.kind === "turn-completed", "cancelled turn did not seal its stream");
    await first.cancel();
  });

  const supportsSubagentStop = capabilities !== undefined
    && harnessSubagentControls(capabilities.subagents).includes("stop");
  if (supportsSubagentStop) {
    skip("active subagent stop unsupported", "adapter reports active subagent stop support");
  } else await runCase("active subagent stop unsupported", async (defer) => {
    const harness = scopedRuntime(defer, timeoutMs, {
      adapters: [adapter("cancel")],
      persistence: createMemoryPersistence(),
    });
    const run = harness.start(request(fixture.adapterId));
    const iterator = run.events[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.next();
    let failure: unknown;
    try {
      await run.stopSubagent(CONFORMANCE.subagentTaskId);
    } catch (error) {
      failure = error;
    }
    check(
      failure instanceof HarnessRuntimeError && failure.code === "SUBAGENT_CONTROL_UNSUPPORTED",
      "an undeclared subagent stop reached the provider",
    );
    check(fixture.subagentControls() === 0, "an unsupported subagent stop mutated the provider");
    await run.cancel();
  });

  if (!supportsSubagentStop) {
    skip("active subagent stop accepted", "adapter reports active subagent stop as unsupported");
    skip("active subagent stop false", "adapter reports active subagent stop as unsupported");
    skip("active subagent stop safe error", "adapter reports active subagent stop as unsupported");
    skip("active subagent stop cancellation race", "adapter reports active subagent stop as unsupported");
  } else {
    await runCase("active subagent stop accepted", async (defer) => {
      const harness = scopedRuntime(defer, timeoutMs, {
        adapters: [adapter("subagent-stop")],
        persistence: createMemoryPersistence(),
      });
      const run = harness.start(request(fixture.adapterId));
      const iterator = run.events[Symbol.asyncIterator]();
      await iterator.next();
      await iterator.next();
      check(await run.stopSubagent(CONFORMANCE.subagentTaskId), "the adapter refused a supported subagent stop");
      for (;;) {
        if ((await iterator.next()).done) break;
      }
      check(await run.done === "completed", "the parent turn did not remain valid after subagent stop");
      let endedFailure: unknown;
      try {
        await run.stopSubagent(CONFORMANCE.subagentTaskId);
      } catch (error) {
        endedFailure = error;
      }
      check(
        endedFailure instanceof HarnessRuntimeError && endedFailure.code === "TURN_NOT_ACTIVE",
        "an ended turn accepted a stale subagent stop",
      );
    });

    await runCase("active subagent stop false", async (defer) => {
      const harness = scopedRuntime(defer, timeoutMs, {
        adapters: [adapter("subagent-stop-false")],
        persistence: createMemoryPersistence(),
      });
      const run = harness.start(request(fixture.adapterId));
      const iterator = run.events[Symbol.asyncIterator]();
      await iterator.next();
      await iterator.next();
      check(
        await run.stopSubagent("stale-subagent") === false,
        "the adapter did not preserve a safe false subagent-stop result",
      );
      await run.cancel();
    });

    await runCase("active subagent stop safe error", async (defer) => {
      const harness = scopedRuntime(defer, timeoutMs, {
        adapters: [adapter("subagent-stop-safe-error")],
        persistence: createMemoryPersistence(),
      });
      const run = harness.start(request(fixture.adapterId));
      const iterator = run.events[Symbol.asyncIterator]();
      await iterator.next();
      await iterator.next();
      let failure: unknown;
      try {
        await run.stopSubagent(CONFORMANCE.subagentTaskId);
      } catch (error) {
        failure = error;
      }
      check(
        failure instanceof HarnessAdapterError
          && failure.code === CONFORMANCE.safeError.code
          && failure.message === CONFORMANCE.safeError.message,
        "a safe subagent-stop error changed at the runtime boundary",
      );
      await run.cancel();
    });

    await runCase("active subagent stop cancellation race", async (defer) => {
      const harness = scopedRuntime(defer, timeoutMs, {
        adapters: [adapter("subagent-stop-race")],
        persistence: createMemoryPersistence(),
      });
      const run = harness.start(request(fixture.adapterId));
      const iterator = run.events[Symbol.asyncIterator]();
      await iterator.next();
      await iterator.next();
      const controlsBefore = fixture.subagentControls();
      const stopping = run.stopSubagent(CONFORMANCE.subagentTaskId).catch((error) => error);
      while (fixture.subagentControls() === controlsBefore) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      await run.cancel();
      const failure = await stopping;
      check(
        failure instanceof HarnessRuntimeError && failure.code === "TURN_NOT_ACTIVE",
        "cancellation did not retire an in-flight subagent stop",
      );
      check(await run.done === "interrupted", "the cancellation race did not interrupt the parent turn");
    });
  }

  if (
    !capabilities?.steering
    || capabilities.steering.support === "unsupported"
    || capabilities.steering.strategies.length === 0
  ) skip("active-turn follow-up", "adapter reports active-turn follow-ups as unsupported");
  else await runCase("active-turn follow-up", async (defer) => {
    const value = adapter("steering");
    const harness = scopedRuntime(defer, timeoutMs, {
      adapters: [value],
      persistence: createMemoryPersistence(),
    });
    const first = harness.start(request(fixture.adapterId), {
      admission: {
        adapterId: fixture.adapterId,
        accountId: null,
        model: null,
        effort: null,
        settings: { permission: null, controls: {} },
        sessionBinding: "conformance-steering-binding",
        inputPolicy: {
          modalities: {
            text: { support: "stable", maxTextCharacters: 256 },
          },
        },
      },
    });
    const iterator = first.events[Symbol.asyncIterator]();
    check((await iterator.next()).value?.payload.kind === "turn-started", "steering scenario did not start");
    const waiting = await iterator.next();
    check(
      waiting.value?.payload.kind === "assistant-text" && waiting.value.payload.text === CONFORMANCE.waitingText,
      "steering scenario did not reach its wait point",
    );
    let invalidFailure: unknown;
    try {
      await first.followUp({
        expectedTurnId: first.turnId,
        input: [{ type: "text", text: "x".repeat(257) }],
      });
    } catch (error) {
      invalidFailure = error;
    }
    check(
      invalidFailure instanceof HarnessRuntimeError && invalidFailure.code === "INVALID_INPUT",
      "active-turn input policy did not reject unsupported follow-up input",
    );
    const result = await first.followUp({
      expectedTurnId: first.turnId,
      input: [{ type: "text", text: CONFORMANCE.followUpText }],
    });

    if (result.strategy === "same-turn") {
      check(result.run === first, "same-turn steering replaced the public run");
      const tail: HarnessEvent[] = [];
      for (;;) {
        const next = await iterator.next();
        if (next.done) break;
        tail.push(next.value);
      }
      check(await first.done === "completed", "same-turn steering did not complete");
      check(tail.at(-1)?.payload.kind === "turn-completed", "same-turn steering did not seal once");
      check(
        tail.flatMap((event) => event.payload.kind === "assistant-text" ? [event.payload.text] : [])
          .join("")
          .includes(CONFORMANCE.followUpText),
        "same-turn follow-up output was missing",
      );
    } else {
      check(result.run !== first, "replacement steering reused the public run");
      const firstTail: HarnessEvent[] = [];
      for (;;) {
        const next = await iterator.next();
        if (next.done) break;
        firstTail.push(next.value);
      }
      check(await first.done === "interrupted", "replaced turn did not end as interrupted");
      check(firstTail.at(-1)?.payload.kind === "turn-completed", "replaced turn did not seal before admission");
      const replacementEvents = await collect(result.run.events);
      check(await result.run.done === "completed", "replacement follow-up did not complete");
      check(result.run.turnId !== first.turnId, "replacement follow-up reused the old turn id");
      check(
        replacementEvents.some((event) => event.payload.kind === "assistant-text"
          && event.payload.text.includes(CONFORMANCE.followUpText)),
        "replacement follow-up output was missing",
      );
      validateEnvelope(replacementEvents, fixture.adapterId, SESSION);
    }
  });

  if (capabilities?.interactions.support === "unsupported") skip("interaction round trip", "adapter reports interactions as unsupported");
  else await runCase("interaction round trip", async (defer) => {
    const harness = scopedRuntime(defer, timeoutMs, { adapters: [adapter("interaction")], persistence: createMemoryPersistence() });
    const run = harness.start(request(fixture.adapterId));
    const iterator = run.events[Symbol.asyncIterator]();
    await iterator.next();
    const asked = await iterator.next();
    check(asked.value?.payload.kind === "interaction-requested", "adapter did not request an interaction");
    same(asked.value.payload.interaction, CONFORMANCE.interaction, "interaction request changed");
    await run.respond(CONFORMANCE.interaction.id, CONFORMANCE.interactionResponse);
    const rest: HarnessEvent[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      rest.push(next.value);
    }
    check(await run.done === "completed", "answered interaction did not complete");
    const resolved = rest.find((event) => event.payload.kind === "interaction-resolved")?.payload;
    check(resolved?.kind === "interaction-resolved", "interaction resolution was not emitted");
    same(resolved.response, CONFORMANCE.interactionResponse, "interaction response changed");
  });

  if (capabilities?.resume.support === "unsupported") skip("resume checkpoint", "adapter reports resume as unsupported");
  else await runCase("resume checkpoint", async (defer) => {
    const persistence = createMemoryPersistence();
    const initial = scopedRuntime(defer, timeoutMs, { adapters: [adapter("resume-initial")], persistence });
    const admission = { sessionBinding: "conformance:session-binding@1" };
    const first = initial.start(request(fixture.adapterId), { admission });
    await collect(first.events);
    check(await first.done === "completed", "initial resumable turn did not complete");
    const saved = await persistence.sessions.load(SESSION, fixture.adapterId);
    check(saved?.checkpoint?.schemaVersion === 1, "resume checkpoint schema was not persisted");
    check(saved.checkpoint.format === fixture.adapter.checkpoint?.format, "adapter checkpoint format changed in persistence");
    check(saved.checkpoint.token === CONFORMANCE.resumeToken, "adapter checkpoint token changed in persistence");
    check(saved.sessionBinding === admission.sessionBinding, "host session binding was not persisted");
    await initial.runtime.close();

    const restored = scopedRuntime(defer, timeoutMs, { adapters: [adapter("resume-restored")], persistence });
    const second = restored.start(request(fixture.adapterId), { admission });
    const events = await collect(second.events);
    check(await second.done === "completed", "restored turn did not complete");
    check(events.some((event) => event.payload.kind === "assistant-text" && event.payload.text === CONFORMANCE.resumedText), "stored resume token did not reach the reopened adapter");
  });

  return { passed: cases.every((entry) => entry.status !== "failed"), cases };
}

/** Error used by fixture adapters for the suite's safe-failure scenario. */
export function conformanceSafeError(): HarnessAdapterError {
  return new HarnessAdapterError(CONFORMANCE.safeError.code, CONFORMANCE.safeError.message, true);
}

/** Event yielded by the suite's required basic scenario. */
export const conformanceTextEvent: HarnessAdapterEvent = { kind: "assistant-text", text: CONFORMANCE.text };
