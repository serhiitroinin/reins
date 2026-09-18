import { describe, expect, test } from "bun:test";
import type { HarnessAdapterEvent } from "../src/runtime.ts";
import {
  CLAUDE_AGENT_SDK_NAMESPACE,
  claudeAgentSdkLimitSnapshot,
  claudeAgentSdkModelCatalog,
  claudeAgentSdkUsageLimitSnapshot,
  createClaudeAgentSdkEventConsumer,
  type ClaudeAgentSdkTurnOutcome,
} from "../src/adapters/claude-agent-sdk-events.ts";
import { createClaudeAgentSdkDiscoveryFixture } from "../src/testing/index.ts";

describe("Claude Agent SDK event consumer", () => {
  test("normalizes a complete turn without retaining SDK types", () => {
    const events: HarnessAdapterEvent[] = [];
    const checkpoints: string[] = [];
    const limits: unknown[] = [];
    const outcomes: ClaudeAgentSdkTurnOutcome[] = [];
    const consumer = createClaudeAgentSdkEventConsumer({
      emit: (event) => events.push(event),
      onCheckpoint: (checkpoint) => checkpoints.push(checkpoint),
      onLimits: (snapshot) => limits.push(snapshot),
      onTurnEnded: (outcome) => outcomes.push(outcome),
      presentTool: (tool) => ({
        toolKind: tool.name === "Bash" ? "command" : "tool",
        title: tool.name,
        ...(typeof tool.input.command === "string" ? { command: tool.input.command } : {}),
      }),
      redactToolOutput: (_tool, output) => output.toUpperCase(),
    });

    consumer.message({ type: "system", subtype: "init", session_id: "session-1" });
    consumer.message({
      type: "assistant",
      message: {
        model: "claude-test",
        usage: { input_tokens: 3, cache_read_input_tokens: 7 },
        content: [
          { type: "text", text: "Hello" },
          { type: "thinking", thinking: "Consider it" },
          { type: "tool_use", id: "plan-1", name: "TodoWrite", input: { todos: [{ content: "Do it", status: "in_progress" }] } },
          { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "pwd" } },
        ],
      },
    });
    consumer.message({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: "ok" }] },
    });
    consumer.message({
      type: "rate_limit_event",
      rate_limit_info: { rateLimitType: "five_hour", utilization: 31.4, resetsAt: 1_800_000_000 },
    });
    consumer.message({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 250,
      usage: { input_tokens: 5, cache_read_input_tokens: 11, cache_creation_input_tokens: 2, output_tokens: 4 },
      modelUsage: { "claude-test": { contextWindow: 200_000 } },
    });

    expect(checkpoints).toEqual(["session-1"]);
    expect(limits).toEqual([{
      limits: [{
        id: "five_hour",
        label: "5-hour",
        kind: "rate",
        scope: "account",
        unit: "%",
        usedPercent: 31,
        resetsAt: "2027-01-15T08:00:00.000Z",
        windowDurationMs: 18_000_000,
      }],
    }]);
    expect(events).toEqual([
      { kind: "assistant-text", text: "Hello" },
      { kind: "thinking", text: "Consider it" },
      { kind: "plan-updated", steps: [{ text: "Do it", status: "active" }] },
      { kind: "tool-started", toolId: "tool-1", toolKind: "command", title: "Bash", command: "pwd" },
      { kind: "tool-completed", toolId: "tool-1", status: "completed", toolKind: "command", title: "Bash", outputAppend: "OK" },
      {
        kind: "extension",
        namespace: CLAUDE_AGENT_SDK_NAMESPACE,
        name: "context",
        payload: { usedTokens: 10, maxTokens: 200_000 },
      },
      {
        kind: "usage",
        usage: {
          inputTokens: 18,
          outputTokens: 4,
          cachedInputTokens: 11,
          totalTokens: 22,
          durationMs: 250,
        },
      },
    ]);
    expect(outcomes).toEqual([{
      status: "completed",
      usage: {
        inputTokens: 18,
        outputTokens: 4,
        cachedInputTokens: 11,
        totalTokens: 22,
        durationMs: 250,
      },
    }]);
  });

  test("keeps tool input and output private by default", () => {
    const events: HarnessAdapterEvent[] = [];
    const consumer = createClaudeAgentSdkEventConsumer({ emit: (event) => events.push(event) });
    consumer.message({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "secret-tool", name: "Read", input: { file_path: "/secret" } }] },
    });
    consumer.message({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "secret-tool", content: "secret output" }] },
    });
    consumer.message({ type: "result", subtype: "success", is_error: false });

    expect(events).toEqual([
      { kind: "tool-started", toolId: "secret-tool", toolKind: "tool", title: "Read" },
      { kind: "tool-completed", toolId: "secret-tool", status: "completed", toolKind: "tool", title: "Read" },
    ]);
    expect(JSON.stringify(events)).not.toContain("/secret");
    expect(JSON.stringify(events)).not.toContain("secret output");
  });

  test("keeps subagent errors private unless the host explicitly redacts them", () => {
    const privateEvents: HarnessAdapterEvent[] = [];
    const privateConsumer = createClaudeAgentSdkEventConsumer({ emit: (event) => privateEvents.push(event) });
    privateConsumer.message({
      type: "system",
      subtype: "task_updated",
      task_id: "agent-1",
      patch: { status: "failed", description: "Inspect", error: "private stack and token" },
    });

    expect(JSON.stringify(privateEvents)).not.toContain("private stack and token");
    expect(privateEvents).toEqual([{
      kind: "extension",
      namespace: CLAUDE_AGENT_SDK_NAMESPACE,
      name: "subagent",
      payload: { taskId: "agent-1", phase: "done", description: "Inspect", status: "failed" },
    }]);

    const publicEvents: HarnessAdapterEvent[] = [];
    const publicConsumer = createClaudeAgentSdkEventConsumer({
      emit: (event) => publicEvents.push(event),
      redactSubagentError: () => "The subagent failed safely.",
    });
    publicConsumer.message({
      type: "system",
      subtype: "task_updated",
      task_id: "agent-1",
      patch: { status: "failed", error: "private stack and token" },
    });

    expect(JSON.stringify(publicEvents)).not.toContain("private stack and token");
    expect(publicEvents).toEqual([{
      kind: "extension",
      namespace: CLAUDE_AGENT_SDK_NAMESPACE,
      name: "subagent",
      payload: {
        taskId: "agent-1",
        phase: "done",
        description: "subagent",
        status: "failed",
        error: "The subagent failed safely.",
      },
    }]);
  });

  test("maps public failures and closes unfinished tools without false success", () => {
    const events: HarnessAdapterEvent[] = [];
    const outcomes: ClaudeAgentSdkTurnOutcome[] = [];
    const consumer = createClaudeAgentSdkEventConsumer({
      emit: (event) => events.push(event),
      onTurnEnded: (outcome) => outcomes.push(outcome),
      publicError: () => ({ code: "SAFE_FAILURE", message: "The provider refused this turn.", retryable: true }),
    });
    consumer.message({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "open", name: "Write", input: { content: "secret" } }] },
    });
    consumer.message({ type: "result", subtype: "error_during_execution", is_error: true, error: "private" });

    expect(events).toEqual([
      { kind: "tool-started", toolId: "open", toolKind: "tool", title: "Write" },
      { kind: "error", code: "SAFE_FAILURE", message: "The provider refused this turn.", retryable: true },
      { kind: "tool-completed", toolId: "open", status: "failed", toolKind: "tool", title: "Write" },
    ]);
    expect(outcomes).toEqual([{ status: "error", usage: {} }]);
    expect(JSON.stringify(events)).not.toContain("private");
    expect(JSON.stringify(events)).not.toContain("secret");
  });

  test("treats an interrupted provider result as cancellation without a public error", () => {
    const events: HarnessAdapterEvent[] = [];
    const outcomes: ClaudeAgentSdkTurnOutcome[] = [];
    const consumer = createClaudeAgentSdkEventConsumer({
      emit: (event) => events.push(event),
      onTurnEnded: (outcome) => outcomes.push(outcome),
    });

    consumer.message({ type: "result", subtype: "interrupted", is_error: true, error: "private" });

    expect(events).toEqual([]);
    expect(outcomes).toEqual([{ status: "interrupted", usage: {} }]);
  });

  test("ignores malformed result messages and accepts the next valid terminal", () => {
    const events: HarnessAdapterEvent[] = [];
    const outcomes: ClaudeAgentSdkTurnOutcome[] = [];
    const consumer = createClaudeAgentSdkEventConsumer({
      emit: (event) => events.push(event),
      onTurnEnded: (outcome) => outcomes.push(outcome),
    });

    consumer.message({ type: "result", subtype: "", is_error: false, error: "private-empty-subtype" });
    consumer.message({ type: "result", subtype: "success", is_error: "false", error: "private-invalid-flag" });
    consumer.message({ type: "unsupported", payload: "private-unknown-message" });
    expect(events).toEqual([]);
    expect(outcomes).toEqual([]);

    consumer.message({
      type: "assistant",
      message: { content: [{ type: "text", text: "valid" }] },
    });
    consumer.message({ type: "result", subtype: "success", is_error: false });
    consumer.message({
      type: "assistant",
      message: { content: [{ type: "text", text: "private-post-terminal" }] },
    });

    expect(events).toEqual([{ kind: "assistant-text", text: "valid" }]);
    expect(outcomes).toEqual([{ status: "completed", usage: {} }]);
    expect(JSON.stringify(events)).not.toContain("private");
  });

  test("normalizes compaction and nested subagent activity as namespaced extensions", () => {
    const events: HarnessAdapterEvent[] = [];
    let summary: string | null = "kept summary";
    const consumer = createClaudeAgentSdkEventConsumer({
      emit: (event) => events.push(event),
      takeCompactSummary: () => {
        const value = summary;
        summary = null;
        return value;
      },
      presentTool: (tool) => ({ toolKind: "tool", title: tool.name }),
      redactToolOutput: (_tool, output) => output,
    });

    consumer.message({ type: "system", subtype: "status", status: "compacting" });
    consumer.message({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "auto", pre_tokens: 90_000, post_tokens: 12_000 },
    });
    consumer.message({ type: "system", subtype: "status", status: null, compact_result: "success" });
    consumer.message({
      type: "system",
      subtype: "task_started",
      task_id: "agent-1",
      tool_use_id: "spawn-1",
      description: "Inspect the project",
      subagent_type: "Explore",
    });
    consumer.message({
      type: "assistant",
      parent_tool_use_id: "spawn-1",
      message: { content: [{ type: "text", text: "Nested answer" }, { type: "tool_use", id: "nested-tool", name: "Grep", input: {} }] },
    });
    consumer.message({
      type: "user",
      parent_tool_use_id: "spawn-1",
      message: { content: [{ type: "tool_result", tool_use_id: "nested-tool", content: "one hit" }] },
    });
    consumer.message({
      type: "system",
      subtype: "task_notification",
      task_id: "agent-1",
      status: "completed",
      summary: "Done",
      usage: { total_tokens: 30, tool_uses: 1, duration_ms: 80 },
    });
    consumer.message({ type: "result", subtype: "success", is_error: false });

    expect(events).toContainEqual({
      kind: "extension",
      namespace: CLAUDE_AGENT_SDK_NAMESPACE,
      name: "compaction",
      payload: { trigger: "auto", preTokens: 90_000, postTokens: 12_000, summary: "kept summary" },
    });
    expect(events).toContainEqual({
      kind: "extension",
      namespace: CLAUDE_AGENT_SDK_NAMESPACE,
      name: "subagent-event",
      payload: { agentId: "agent-1", event: { kind: "assistant-text", text: "Nested answer" } },
    });
    expect(events).toContainEqual({
      kind: "extension",
      namespace: CLAUDE_AGENT_SDK_NAMESPACE,
      name: "subagent-event",
      payload: {
        agentId: "agent-1",
        event: { kind: "tool-completed", toolId: "nested-tool", status: "completed", toolKind: "tool", title: "Grep", outputAppend: "one hit" },
      },
    });
    expect(events).toContainEqual({
      kind: "extension",
      namespace: CLAUDE_AGENT_SDK_NAMESPACE,
      name: "subagent",
      payload: {
        taskId: "agent-1",
        phase: "done",
        description: "Inspect the project",
        status: "completed",
        summary: "Done",
        usage: { totalTokens: 30, toolUses: 1, durationMs: 80 },
      },
    });
  });

  test("keeps hidden subagents trackable and compaction errors private unless redacted", () => {
    const privateEvents: HarnessAdapterEvent[] = [];
    const privateConsumer = createClaudeAgentSdkEventConsumer({
      emit: (event) => privateEvents.push(event),
    });
    privateConsumer.message({
      type: "system",
      subtype: "task_started",
      task_id: "hidden-1",
      description: "Internal task",
      skip_transcript: true,
    });
    privateConsumer.message({ type: "system", subtype: "status", status: "compacting" });
    privateConsumer.message({
      type: "system",
      subtype: "status",
      status: null,
      compact_result: "failed",
      compact_error: "private transcript path and token",
    });

    expect(privateEvents).toContainEqual({
      kind: "extension",
      namespace: CLAUDE_AGENT_SDK_NAMESPACE,
      name: "subagent",
      payload: {
        taskId: "hidden-1",
        phase: "started",
        description: "Internal task",
        skipTranscript: true,
      },
    });
    expect(privateEvents).toContainEqual({
      kind: "extension",
      namespace: CLAUDE_AGENT_SDK_NAMESPACE,
      name: "status",
      payload: { status: "working", compactionFailed: true },
    });
    expect(JSON.stringify(privateEvents)).not.toContain("private transcript path and token");

    const publicEvents: HarnessAdapterEvent[] = [];
    const publicConsumer = createClaudeAgentSdkEventConsumer({
      emit: (event) => publicEvents.push(event),
      redactCompactionError: () => "The context was too small to compact.",
    });
    publicConsumer.message({ type: "system", subtype: "status", status: "compacting" });
    publicConsumer.message({
      type: "system",
      subtype: "status",
      status: null,
      compact_result: "failed",
      compact_error: "private transcript path and token",
    });
    expect(publicEvents).toContainEqual({
      kind: "extension",
      namespace: CLAUDE_AGENT_SDK_NAMESPACE,
      name: "status",
      payload: {
        status: "working",
        compactionFailed: true,
        error: "The context was too small to compact.",
      },
    });
    expect(JSON.stringify(publicEvents)).not.toContain("private transcript path and token");
  });

  test("maps unknown limit names and rejects malformed snapshots", () => {
    expect(claudeAgentSdkLimitSnapshot({ rate_limit_type: "monthly_team", utilization: 8 })).toEqual({
      limits: [{
        id: "monthly_team",
        label: "Monthly Team",
        kind: "rate",
        scope: "account",
        unit: "%",
        usedPercent: 8,
      }],
    });
    expect(claudeAgentSdkLimitSnapshot({ utilization: "8" })).toBeNull();
    expect(claudeAgentSdkLimitSnapshot(null)).toBeNull();
    expect(claudeAgentSdkLimitSnapshot({
      rate_limit_type: "huge_window",
      utilization: 8,
      resets_at: Number.MAX_VALUE,
    })).toEqual({
      limits: [{
        id: "huge_window",
        label: "Huge Window",
        kind: "rate",
        scope: "account",
        unit: "%",
        usedPercent: 8,
      }],
    });
  });

  test("reads the windows a live update carries without a named utilization", () => {
    expect(claudeAgentSdkLimitSnapshot({
      status: "allowed",
      resetsAt: 1_789_747_200,
      rateLimitType: "five_hour",
      unifiedWindows: {
        five_hour: { utilization: 0, resetsAt: 1_789_747_200 },
        seven_day: { utilization: 0.68, resetsAt: 1_789_884_000 },
      },
    })).toEqual({
      limits: [
        {
          id: "five_hour",
          label: "5-hour",
          kind: "rate",
          scope: "account",
          unit: "%",
          usedPercent: 0,
          resetsAt: "2026-09-18T16:00:00.000Z",
          windowDurationMs: 18_000_000,
        },
        {
          id: "seven_day",
          label: "Weekly",
          kind: "rate",
          scope: "account",
          unit: "%",
          usedPercent: 68,
          resetsAt: "2026-09-20T06:00:00.000Z",
          windowDurationMs: 604_800_000,
        },
      ],
    });
    expect(claudeAgentSdkLimitSnapshot({
      rateLimitType: "seven_day",
      utilization: 0.91,
      unifiedWindows: { seven_day: { utilization: 0.9 } },
    })).toMatchObject({ limits: [{ id: "seven_day", usedPercent: 91 }] });
    expect(claudeAgentSdkLimitSnapshot({ status: "allowed", rateLimitType: "five_hour" })).toBeNull();
  });

  test("converts the usage response and skips accounts without plan limits", () => {
    const fixture = createClaudeAgentSdkDiscoveryFixture();
    expect(claudeAgentSdkUsageLimitSnapshot(fixture.responses.usage)).toEqual({
      planLabel: "Max",
      limits: [
        {
          id: "five_hour",
          label: "5-hour",
          kind: "rate",
          scope: "account",
          unit: "%",
          usedPercent: 12,
          resetsAt: "2026-09-18T16:00:00.000Z",
          windowDurationMs: 18_000_000,
        },
        {
          id: "seven_day",
          label: "Weekly",
          kind: "rate",
          scope: "account",
          unit: "%",
          usedPercent: 68,
          resetsAt: "2026-09-20T06:00:00.000Z",
          windowDurationMs: 604_800_000,
        },
        {
          id: "seven_day_model:fable",
          label: "Weekly · Fable",
          kind: "rate",
          scope: "model",
          unit: "%",
          usedPercent: 100,
          windowDurationMs: 604_800_000,
        },
      ],
    });
    expect(claudeAgentSdkUsageLimitSnapshot({
      subscription_type: null,
      rate_limits_available: false,
      rate_limits: null,
    })).toBeNull();
    expect(claudeAgentSdkUsageLimitSnapshot(undefined)).toBeNull();
  });

  test("converts supported models with labels, effort, and a default", () => {
    const fixture = createClaudeAgentSdkDiscoveryFixture();
    expect(claudeAgentSdkModelCatalog(fixture.responses.models)).toEqual({
      selection: "optional",
      defaultModelId: "default",
      models: [
        {
          id: "default",
          label: "Default (recommended)",
          description: "Opus 5 with 1M context",
          effort: {
            options: [
              { id: "low", label: "Low" },
              { id: "medium", label: "Medium" },
              { id: "high", label: "High" },
              { id: "xhigh", label: "Extra high" },
              { id: "max", label: "Max" },
            ],
          },
          extensions: {
            [CLAUDE_AGENT_SDK_NAMESPACE]: {
              resolvedModel: "claude-opus-5[1m]",
              adaptiveThinking: true,
              fastMode: true,
            },
          },
        },
        {
          id: "sonnet",
          label: "Sonnet",
          description: "Sonnet 5",
          effort: {
            options: [
              { id: "low", label: "Low" },
              { id: "medium", label: "Medium" },
              { id: "high", label: "High" },
            ],
          },
          extensions: { [CLAUDE_AGENT_SDK_NAMESPACE]: { resolvedModel: "claude-sonnet-5" } },
        },
        { id: "haiku", label: "Haiku", description: "Haiku 4.5" },
      ],
    });
    expect(claudeAgentSdkModelCatalog([{ value: "sonnet" }, { value: "sonnet" }, { displayName: "Nameless" }]))
      .toEqual({ selection: "optional", defaultModelId: "sonnet", models: [{ id: "sonnet", label: "Sonnet" }] });
    expect(claudeAgentSdkModelCatalog(null)).toEqual({ selection: "optional", models: [] });
  });
});
