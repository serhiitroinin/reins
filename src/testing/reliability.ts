/** Optional black-box reliability checks for adapters with fault-injectable transports. */

import type { HarnessEvent, HarnessSessionKey } from "../protocol.js";
import {
  createHarness,
  type HarnessAdapter,
  type HarnessRun,
} from "../runtime.js";
import { createMemoryPersistence } from "../stores.js";
import type { AdapterConformanceCase, AdapterConformanceReport } from "./conformance.js";

export type AdapterReliabilityScenario =
  | "provider-death"
  | "malformed-traffic"
  | "cancel-after-partial"
  | "resume-rejected";

export interface AdapterReliabilityFixture {
  readonly adapterId: string;
  readonly adapter: HarnessAdapter;
  useReliabilityScenario(scenario: AdapterReliabilityScenario): void;
  providerOpens(): number;
  providerCloses(): number;
}

export interface AdapterReliabilityOptions {
  fixture: AdapterReliabilityFixture;
  timeoutMs?: number;
}

export const RELIABILITY = {
  partialText: "reliability-partial",
  recoveredText: "reliability-recovered",
  resumeToken: "reliability-resume-token",
  unsafeSecret: "reliability-secret-must-not-persist",
} as const;

const SESSION: HarnessSessionKey = {
  tenantId: "reliability-tenant",
  actorId: "reliability-actor",
  threadId: "reliability-thread",
};

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function same(actual: unknown, expected: unknown, message: string): void {
  check(JSON.stringify(actual) === JSON.stringify(expected), message);
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

async function collect(stream: AsyncIterable<HarnessEvent>): Promise<HarnessEvent[]> {
  const events: HarnessEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function request(adapterId: string) {
  return {
    session: SESSION,
    adapterId,
    input: [{ type: "text" as const, text: "Run the reliability scenario." }],
  };
}

function assertTerminal(events: readonly HarnessEvent[], status: "completed" | "error" | "interrupted"): void {
  const terminal = events.filter((event) => event.payload.kind === "turn-completed");
  check(terminal.length === 1, "the run did not persist exactly one terminal event");
  check(
    terminal[0]?.payload.kind === "turn-completed" && terminal[0].payload.status === status,
    "the terminal status changed",
  );
  check(events.at(-1) === terminal[0], "the terminal event was not last");
}

function assertSafe(events: readonly HarnessEvent[]): void {
  const encoded = JSON.stringify(events);
  check(!encoded.includes(RELIABILITY.unsafeSecret), "raw provider failure data reached events");
  check(!encoded.includes(RELIABILITY.resumeToken), "a provider checkpoint reached events");
}

async function waitForPartial(
  run: HarnessRun,
  list: () => Promise<readonly HarnessEvent[]>,
  timeoutMs: number,
): Promise<void> {
  await bounded((async () => {
    for (;;) {
      const events = await list();
      if (
        events.some((event) => event.payload.kind === "assistant-text"
          && event.payload.text.includes(RELIABILITY.partialText))
        && events.some((event) => event.payload.kind === "tool-started")
      ) return;
      const status = await Promise.race([run.done, new Promise<null>((resolve) => setTimeout(() => resolve(null), 0))]);
      if (status !== null) throw new Error("the provider settled before reaching the cancellation boundary");
    }
  })(), timeoutMs, "cancel-after-partial readiness");
}

/** Run deterministic failure semantics through a real adapter and the public runtime. */
export async function runAdapterReliabilityConformance(
  options: AdapterReliabilityOptions,
): Promise<AdapterConformanceReport> {
  const { fixture } = options;
  const timeoutMs = options.timeoutMs ?? 2_000;
  const cases: AdapterConformanceCase[] = [];

  type Cleanup = () => Promise<void> | void;
  type DeferCleanup = (cleanup: Cleanup) => void;

  const runCase = async (
    name: string,
    execute: (defer: DeferCleanup) => Promise<void>,
  ): Promise<void> => {
    const cleanups: Cleanup[] = [];
    let failure: string | undefined;
    const execution = execute((cleanup) => cleanups.push(cleanup));
    try {
      await bounded(execution, timeoutMs, name);
    } catch (error) {
      failure = error instanceof Error ? error.message : "Unknown reliability failure.";
    } finally {
      for (const cleanup of cleanups.reverse()) {
        try {
          await bounded(Promise.resolve(cleanup()), timeoutMs, `${name} cleanup`);
        } catch (error) {
          failure ??= error instanceof Error ? error.message : "Unknown reliability cleanup failure.";
        }
      }
      try {
        await bounded(execution.catch(() => undefined), timeoutMs, `${name} drain`);
      } catch (error) {
        failure ??= error instanceof Error ? error.message : "Unknown reliability drain failure.";
      }
    }
    cases.push(failure ? { name, status: "failed", message: failure } : { name, status: "passed" });
  };

  const runScenario = async (scenario: AdapterReliabilityScenario, defer: DeferCleanup) => {
    fixture.useReliabilityScenario(scenario);
    const persistence = createMemoryPersistence();
    const runtime = createHarness({ adapters: [fixture.adapter], persistence });
    defer(() => runtime.close());
    try {
      const run = runtime.start(request(fixture.adapterId));
      const live = await collect(run.events);
      const status = await run.done;
      const durable = await persistence.events.list(SESSION, fixture.adapterId);
      same(live, durable, "live events differed from durable replay");
      return { live, status, providerCloses: fixture.providerCloses() };
    } finally {
      await runtime.close();
    }
  };

  await runCase("provider death", async (defer) => {
    const closes = fixture.providerCloses();
    const { live, status, providerCloses } = await runScenario("provider-death", defer);
    check(status === "error", "provider death did not fail the run");
    check(live.some((event) => event.payload.kind === "assistant-text"
      && event.payload.text.includes(RELIABILITY.partialText)), "partial provider output was lost");
    check(live.some((event) => event.payload.kind === "tool-completed"
      && event.payload.status === "failed"), "the open tool was not failed on provider death");
    same(
      live.find((event) => event.payload.kind === "error")?.payload,
      { kind: "error", code: "ADAPTER_ERROR", message: "The adapter turn failed." },
      "provider death did not use the safe runtime error",
    );
    assertTerminal(live, "error");
    assertSafe(live);
    check(providerCloses > closes, "the dead provider resource was not closed before runtime shutdown");
  });

  await runCase("malformed traffic recovery", async (defer) => {
    const { live, status } = await runScenario("malformed-traffic", defer);
    check(status === "completed", "malformed traffic poisoned a valid turn");
    check(
      live.flatMap((event) => event.payload.kind === "assistant-text" ? [event.payload.text] : []).join("")
        === RELIABILITY.recoveredText,
      "valid output after malformed traffic was lost",
    );
    check(!live.some((event) => event.payload.kind === "error"), "malformed traffic invented an error event");
    assertTerminal(live, "completed");
    assertSafe(live);
  });

  await runCase("cancellation after partial output", async (defer) => {
    fixture.useReliabilityScenario("cancel-after-partial");
    const persistence = createMemoryPersistence();
    const runtime = createHarness({ adapters: [fixture.adapter], persistence });
    defer(() => runtime.close());
    try {
      const run = runtime.start(request(fixture.adapterId));
      const livePromise = collect(run.events);
      await waitForPartial(
        run,
        () => persistence.events.list(SESSION, fixture.adapterId),
        timeoutMs,
      );
      await Promise.all([run.cancel(), run.cancel()]);
      const live = await livePromise;
      check(await run.done === "interrupted", "cancelled provider turn did not interrupt");
      const durable = await persistence.events.list(SESSION, fixture.adapterId);
      same(live, durable, "cancelled live events differed from durable replay");
      check(live.some((event) => event.payload.kind === "tool-completed"
        && event.payload.status === "cancelled"), "the open tool was not cancelled");
      check(!live.some((event) => event.payload.kind === "error"), "cancellation invented an error event");
      assertTerminal(live, "interrupted");
      assertSafe(live);
    } finally {
      await runtime.close();
    }
  });

  const checkpointFormat = fixture.adapter.checkpoint?.format;
  if (checkpointFormat) {
    await runCase("incompatible checkpoint rejection", async (defer) => {
      fixture.useReliabilityScenario("resume-rejected");
      const persistence = createMemoryPersistence();
      await persistence.sessions.save({
        key: SESSION,
        adapterId: fixture.adapterId,
        checkpoint: { schemaVersion: 1, format: `${checkpointFormat}:incompatible`, token: RELIABILITY.resumeToken },
        updatedAt: new Date(0).toISOString(),
      });
      const opens = fixture.providerOpens();
      const runtime = createHarness({ adapters: [fixture.adapter], persistence });
      defer(() => runtime.close());
      try {
        const run = runtime.start(request(fixture.adapterId));
        const live = await collect(run.events);
        check(await run.done === "error", "an incompatible checkpoint did not fail");
        same(
          live,
          await persistence.events.list(SESSION, fixture.adapterId),
          "checkpoint-refusal live events differed from durable replay",
        );
        check(fixture.providerOpens() === opens, "an incompatible checkpoint reached the provider");
        check(live.some((event) => event.payload.kind === "error"
          && event.payload.code === "SESSION_CHECKPOINT_INCOMPATIBLE"), "the checkpoint error code changed");
        assertTerminal(live, "error");
        assertSafe(live);
        await runtime.resetSession(SESSION, fixture.adapterId);
        const fresh = runtime.start(request(fixture.adapterId));
        const freshEvents = await collect(fresh.events);
        check(await fresh.done === "completed", "explicit reset did not permit a fresh provider turn");
        same(
          freshEvents,
          await persistence.events.list(SESSION, fixture.adapterId, live.at(-1)?.sequence ?? 0),
          "post-reset live events differed from durable replay",
        );
        assertTerminal(freshEvents, "completed");
      } finally {
        await runtime.close();
      }
    });

    await runCase("provider checkpoint rejection", async (defer) => {
      fixture.useReliabilityScenario("resume-rejected");
      const persistence = createMemoryPersistence();
      await persistence.sessions.save({
        key: SESSION,
        adapterId: fixture.adapterId,
        checkpoint: { schemaVersion: 1, format: checkpointFormat, token: RELIABILITY.resumeToken },
        updatedAt: new Date(0).toISOString(),
      });
      const runtime = createHarness({ adapters: [fixture.adapter], persistence });
      defer(() => runtime.close());
      try {
        const run = runtime.start(request(fixture.adapterId));
        const live = await collect(run.events);
        check(await run.done === "error", "a provider-rejected checkpoint did not fail");
        same(
          live,
          await persistence.events.list(SESSION, fixture.adapterId),
          "resume-refusal live events differed from durable replay",
        );
        assertTerminal(live, "error");
        assertSafe(live);
        const stored = await persistence.sessions.load(SESSION, fixture.adapterId);
        check(stored?.checkpoint?.token === RELIABILITY.resumeToken, "provider rejection changed the stored checkpoint");
        await runtime.resetSession(SESSION, fixture.adapterId);
        const fresh = runtime.start(request(fixture.adapterId));
        const freshEvents = await collect(fresh.events);
        check(await fresh.done === "completed", "checkpoint reset did not recover the adapter");
        same(
          freshEvents,
          await persistence.events.list(SESSION, fixture.adapterId, live.at(-1)?.sequence ?? 0),
          "post-reset live events differed from durable replay",
        );
        assertTerminal(freshEvents, "completed");
      } finally {
        await runtime.close();
      }
    });
  }

  return { passed: cases.every((entry) => entry.status !== "failed"), cases };
}
