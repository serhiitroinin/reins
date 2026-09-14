import { describe, expect, test } from "bun:test";
import {
  codexLimitSnapshot,
  createCodexAppServerEventConsumer,
  type CodexAppServerEventConsumerOptions,
  type CodexAppServerTurnOutcome,
} from "../src/adapters/codex-app-server-events.ts";
import type { HarnessLimitSnapshot } from "../src/profile.ts";
import type { HarnessAdapterEvent } from "../src/runtime.ts";

function fixture(overrides: Partial<CodexAppServerEventConsumerOptions> = {}) {
  const events: HarnessAdapterEvent[] = [];
  const outcomes: CodexAppServerTurnOutcome[] = [];
  const limits: HarnessLimitSnapshot[] = [];
  const consumer = createCodexAppServerEventConsumer({
    emit: (event) => events.push(event),
    onTurnEnded: (outcome) => outcomes.push(outcome),
    onLimits: (snapshot) => limits.push(snapshot),
    assistantTextChunkChars: 8,
    eventContentChunkChars: 8,
    ...overrides,
  });
  return { consumer, events, outcomes, limits };
}

describe("Codex App Server event consumer", () => {
  test("reconciles streamed assistant deltas with the authoritative completion", () => {
    const fx = fixture();
    const whole = "The week is tidy, and here is why.";
    fx.consumer.notification("item/started", {
      item: { type: "agentMessage", id: "message-1", text: "" },
    });
    fx.consumer.notification("item/agentMessage/delta", {
      itemId: "message-1",
      delta: "The week is ",
    });
    fx.consumer.notification("error", {
      willRetry: true,
      error: { message: "transient details must not end or flush the message" },
    });
    fx.consumer.notification("item/agentMessage/delta", {
      itemId: "message-1",
      delta: "tidy, and here is why it is.",
    });
    fx.consumer.notification("item/completed", {
      item: { type: "agentMessage", id: "message-1", text: whole },
    });
    fx.consumer.notification("turn/completed", {
      turn: { status: "completed" },
    });

    expect(fx.events.filter((event) => event.kind === "error")).toEqual([]);
    expect(fx.events
      .filter((event) => event.kind === "assistant-text")
      .map((event) => event.text)
      .join("")).toBe(whole);
    expect(fx.outcomes).toEqual([{ status: "completed", usage: {} }]);
  });

  test("emits reasoning summaries and provider-neutral plans", () => {
    const fx = fixture();
    fx.consumer.notification("item/completed", {
      item: {
        type: "reasoning",
        id: "reasoning-1",
        summary: ["Inspect", "Decide"],
        content: ["private raw reasoning"],
      },
    });
    fx.consumer.notification("turn/plan/updated", {
      explanation: null,
      plan: [
        { step: "Read", status: "completed" },
        { step: "Write", status: "inProgress" },
        { step: "Test", status: "pending" },
        { status: "pending" },
      ],
    });

    expect(fx.events.filter((event) => event.kind === "thinking")
      .map((event) => event.text).join("")).toBe("Inspect\n\nDecide");
    expect(fx.events.at(-1)).toEqual({
      kind: "plan-updated",
      steps: [
        { text: "Read", status: "done" },
        { text: "Write", status: "active" },
        { text: "Test", status: "pending" },
      ],
    });
  });

  test("normalizes tool starts, bounded output, outcomes, and completion-only items", () => {
    const fx = fixture({ toolOutputMaxChars: 10 });
    fx.consumer.notification("item/started", {
      item: {
        type: "commandExecution",
        id: "command-1",
        command: "printf hello",
        status: "inProgress",
      },
    });
    fx.consumer.notification("item/completed", {
      item: {
        type: "commandExecution",
        id: "command-1",
        command: "printf hello",
        aggregatedOutput: "0123456789more",
        exitCode: 7,
        status: "failed",
      },
    });
    fx.consumer.notification("item/completed", {
      item: {
        type: "fileChange",
        id: "patch-1",
        changes: [{ path: "notes/a.md" }],
        status: "declined",
      },
    });

    expect(fx.events[0]).toEqual({
      kind: "tool-started",
      toolId: "command-1",
      toolKind: "command",
      title: "printf hello",
      command: "printf hello",
    });
    expect(fx.events.slice(1, 3)).toEqual([
      {
        kind: "tool-updated",
        toolId: "command-1",
        toolKind: "command",
        title: "printf hello",
        outputAppend: "01234567",
      },
      {
        kind: "tool-completed",
        toolId: "command-1",
        toolKind: "command",
        title: "printf hello",
        status: "failed",
        outputAppend: "89",
        exitCode: 7,
        truncated: true,
      },
    ]);
    expect(fx.events[3]).toEqual({
      kind: "tool-completed",
      toolId: "patch-1",
      toolKind: "file-change",
      title: "notes/a.md",
      status: "declined",
    });
  });

  test("lets the host classify and redact a domain tool without receiving an SDK type", () => {
    const presented: unknown[] = [];
    const fx = fixture({
      presentTool: (tool) => {
        presented.push(tool);
        return {
          toolKind: "workspace-operation",
          title: "Update note",
          extensions: { "example:review": "required" },
        };
      },
      redactToolOutput: (_tool, output) => output.replace("secret", "[redacted]"),
    });
    const item = {
      type: "mcpToolCall",
      id: "tool-1",
      server: "domain-tools",
      tool: "note_update",
      arguments: { body: "private note" },
      status: "inProgress",
    };
    fx.consumer.notification("item/started", { item });
    fx.consumer.notification("item/completed", {
      item: {
        ...item,
        status: "completed",
        result: { content: [{ type: "text", text: "saved secret" }] },
      },
    });

    expect(presented[0]).toEqual({
      id: "tool-1",
      kind: "mcp",
      server: "domain-tools",
      name: "note_update",
      input: { body: "private note" },
    });
    expect(fx.events).toEqual([
      {
        kind: "tool-started",
        toolId: "tool-1",
        toolKind: "workspace-operation",
        title: "Update note",
        extensions: { "example:review": "required" },
      },
      {
        kind: "tool-updated",
        toolId: "tool-1",
        toolKind: "workspace-operation",
        title: "Update note",
        outputAppend: "saved [r",
        extensions: { "example:review": "required" },
      },
      {
        kind: "tool-completed",
        toolId: "tool-1",
        toolKind: "workspace-operation",
        title: "Update note",
        status: "completed",
        outputAppend: "edacted]",
        extensions: { "example:review": "required" },
      },
    ]);
  });

  test("redacts provider failures by default and seals on the first terminal fact", () => {
    const fx = fixture();
    fx.consumer.notification("item/started", {
      item: { type: "webSearch", id: "search-1", query: "private", status: "inProgress" },
    });
    fx.consumer.notification("error", {
      willRetry: false,
      error: { code: "raw_code", message: "token sk-secret at /Users/private" },
    });
    fx.consumer.notification("turn/completed", {
      turn: { status: "completed" },
    });

    expect(fx.events).toEqual([
      {
        kind: "tool-started",
        toolId: "search-1",
        toolKind: "web-search",
        title: "private",
        detail: "private",
      },
      {
        kind: "tool-completed",
        toolId: "search-1",
        toolKind: "web-search",
        title: "private",
        status: "failed",
      },
      {
        kind: "error",
        code: "CODEX_PROVIDER_ERROR",
        message: "Codex could not complete the turn.",
      },
    ]);
    expect(JSON.stringify(fx.events)).not.toContain("sk-secret");
    expect(JSON.stringify(fx.events)).not.toContain("/Users/private");
    expect(fx.outcomes).toEqual([{ status: "error", usage: {} }]);
  });

  test("allows an explicit public error mapper", () => {
    const fx = fixture({
      publicError: (error) => ({
        code: error.code ? `codex:${error.code}` : "codex:error",
        message: error.message?.slice(0, 20) || "Codex failed.",
        retryable: true,
      }),
    });
    fx.consumer.notification("turn/completed", {
      turn: { status: "failed", error: { code: "overloaded", message: "Please retry." } },
    });

    expect(fx.events).toEqual([{
      kind: "error",
      code: "codex:overloaded",
      message: "Please retry.",
      retryable: true,
    }]);
    expect(fx.outcomes).toEqual([{ status: "error", usage: {} }]);
  });

  test("measures this turn from cumulative token updates", () => {
    const fx = fixture();
    fx.consumer.notification("thread/tokenUsage/updated", {
      tokenUsage: {
        total: { inputTokens: 109_000, outputTokens: 10_554, cachedInputTokens: 50_100 },
        last: { inputTokens: 9_000, outputTokens: 554, cachedInputTokens: 100 },
      },
    });
    fx.consumer.notification("thread/tokenUsage/updated", {
      tokenUsage: {
        total: { inputTokens: 118_000, outputTokens: 11_239, cachedInputTokens: 50_200 },
        last: { inputTokens: 9_000, outputTokens: 685, cachedInputTokens: 100 },
      },
    });
    fx.consumer.notification("thread/tokenUsage/updated", {
      tokenUsage: {
        total: { inputTokens: 127_000, outputTokens: 11_973, cachedInputTokens: 50_300 },
        last: { inputTokens: 9_000, outputTokens: 734, cachedInputTokens: 100 },
      },
    });
    fx.consumer.notification("turn/completed", { turn: { status: "completed" } });

    expect(fx.outcomes).toEqual([{
      status: "completed",
      usage: {
        inputTokens: 27_000,
        outputTokens: 1_973,
        cachedInputTokens: 300,
        totalTokens: 28_973,
      },
    }]);
    expect(fx.events.filter((event) => event.kind === "usage")).toEqual([]);
  });

  test("keeps account limits separate from turn usage", () => {
    const fx = fixture();
    fx.consumer.notification("account/rateLimits/updated", {
      rateLimits: {
        limitId: "codex",
        limitName: null,
        normalModelSlug: "gpt-5.6-sol",
        primary: { usedPercent: 61, windowDurationMins: 300, resetsAt: 1_789_416_000 },
        secondary: { usedPercent: 20, windowDurationMins: 10_080, resetsAt: null },
        planType: "plus",
        rateLimitReachedType: null,
      },
    });

    expect(fx.events).toEqual([]);
    expect(fx.limits).toEqual([{
      planLabel: "Plus",
      limits: [
        {
          id: "codex:primary",
          label: "5-hour",
          kind: "rate",
          scope: "model",
          unit: "%",
          usedPercent: 61,
          resetsAt: "2026-09-14T20:00:00.000Z",
          windowDurationMs: 18_000_000,
          modelIds: ["gpt-5.6-sol"],
        },
        {
          id: "codex:secondary",
          label: "Weekly",
          kind: "rate",
          scope: "model",
          unit: "%",
          usedPercent: 20,
          windowDurationMs: 604_800_000,
          modelIds: ["gpt-5.6-sol"],
        },
      ],
    }]);
  });

  test("maps credits and spend from camelCase and snake_case snapshots", () => {
    expect(codexLimitSnapshot({
      limit_id: "team",
      plan_type: "enterprise",
      primary: { used_percent: 4, window_minutes: 60, resets_at: 1_789_416_000 },
      credits: { has_credits: true, unlimited: false, balance: "12.50" },
      individual_limit: { limit: "100", used: "25", remaining_percent: 75, resets_at: 1_789_416_000 },
      spend_control_reached: false,
    })).toEqual({
      planLabel: "Enterprise",
      limits: [
        {
          id: "team:primary",
          label: "1-hour",
          kind: "rate",
          scope: "account",
          unit: "%",
          usedPercent: 4,
          resetsAt: "2026-09-14T20:00:00.000Z",
          windowDurationMs: 3_600_000,
        },
        {
          id: "team:credits",
          label: "Credits",
          kind: "credits",
          scope: "account",
          unit: "credits",
          remaining: 12.5,
          extensions: { "openai:has-credits": true, "openai:unlimited": false },
        },
        {
          id: "team:spend",
          label: "Spend",
          kind: "spend",
          scope: "account",
          unit: "currency",
          limit: 100,
          used: 25,
          usedPercent: 25,
          resetsAt: "2026-09-14T20:00:00.000Z",
        },
      ],
      extensions: { "openai:spend-control-reached": false },
    });
    expect(codexLimitSnapshot(null)).toBeNull();
    expect(codexLimitSnapshot({ limitId: "empty" })).toBeNull();
  });

  test("flushes partial prose and closes open tools when the transport ends", () => {
    const fx = fixture();
    fx.consumer.notification("item/agentMessage/delta", { itemId: "m1", delta: "partial" });
    fx.consumer.notification("item/started", {
      item: { type: "mcpToolCall", id: "tool-1", server: "work", tool: "read", arguments: {} },
    });
    fx.consumer.notification("item/agentMessage/delta", { itemId: "m2", delta: "tail" });
    fx.consumer.end("cancelled");

    expect(fx.events).toEqual([
      { kind: "assistant-text", text: "partial" },
      { kind: "tool-started", toolId: "tool-1", toolKind: "mcp", title: "work/read" },
      { kind: "assistant-text", text: "tail" },
      {
        kind: "tool-completed",
        toolId: "tool-1",
        toolKind: "mcp",
        title: "work/read",
        status: "cancelled",
      },
    ]);
    expect(fx.outcomes).toEqual([]);
  });

  test("ignores malformed, unsupported, and post-terminal notifications", () => {
    const fx = fixture();
    fx.consumer.notification("item/started", { item: null });
    fx.consumer.notification("item/completed", { item: { type: "futureThing", id: "future-1" } });
    fx.consumer.notification("account/rateLimits/updated", { rateLimits: { primary: { usedPercent: "bad" } } });
    fx.consumer.notification("turn/completed", { turn: { status: "inProgress" } });
    fx.consumer.notification("turn/completed", { turn: { status: "interrupted" } });
    fx.consumer.notification("item/completed", {
      item: { type: "agentMessage", id: "late", text: "must be ignored" },
    });

    expect(fx.events).toEqual([]);
    expect(fx.limits).toEqual([]);
    expect(fx.outcomes).toEqual([{ status: "interrupted", usage: {} }]);
  });

  test("validates event buffer limits", () => {
    expect(() => fixture({ assistantTextChunkChars: 1 })).toThrow("assistantTextChunkChars");
    expect(() => fixture({ eventContentChunkChars: 1 })).toThrow("eventContentChunkChars");
    expect(() => fixture({ toolOutputMaxChars: 1 })).toThrow("toolOutputMaxChars");
  });
});
