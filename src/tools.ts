/** Application-owned tool definitions and policy, independent of provider SDKs. */

import type { HarnessSessionKey } from "./protocol.js";

export type JsonSchema = Readonly<Record<string, unknown>>;

export type HarnessToolContent =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: string; data: string }
  | { type: "resource"; uri: string; mediaType?: string; text?: string };

export interface HarnessToolResult {
  content: readonly HarnessToolContent[];
  isError?: boolean;
  code?: string;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface HarnessToolDescriptor {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface HarnessToolContext {
  session: HarnessSessionKey;
  adapterId: string;
  runId: string;
  turnId: string;
  signal: AbortSignal;
}

export interface HarnessToolDefinition<TInput = unknown> extends HarnessToolDescriptor {
  /** Convert untrusted provider input to the value the implementation accepts. */
  validate?: (input: unknown) => TInput;
  execute(input: TInput, context: HarnessToolContext): Promise<HarnessToolResult> | HarnessToolResult;
}

export type HarnessToolPolicyDecision =
  | { decision: "allow" }
  | { decision: "deny"; reason: string; code?: string };

export type HarnessToolPolicy = (
  tool: HarnessToolDescriptor,
  input: unknown,
  context: HarnessToolContext,
) => Promise<HarnessToolPolicyDecision> | HarnessToolPolicyDecision;

export interface HarnessTurnTools {
  list(): readonly HarnessToolDescriptor[];
  call(name: string, input: unknown): Promise<HarnessToolResult>;
}

export interface HarnessToolHost {
  list(context: HarnessToolContext): readonly HarnessToolDescriptor[];
  call(name: string, input: unknown, context: HarnessToolContext): Promise<HarnessToolResult>;
}

export interface HarnessToolHostOptions {
  policy?: HarnessToolPolicy;
  onError?: (error: unknown, tool: HarnessToolDescriptor, context: HarnessToolContext) => void;
}

const failure = (code: string, text: string): HarnessToolResult => ({
  content: [{ type: "text", text }],
  isError: true,
  code,
});

export const emptyToolHost: HarnessToolHost = {
  list: () => [],
  call: async (name) => failure("TOOL_NOT_FOUND", `Unknown tool: ${name}`),
};

export function createToolHost(
  definitions: readonly HarnessToolDefinition[],
  options: HarnessToolHostOptions = {},
): HarnessToolHost {
  const tools = new Map<string, HarnessToolDefinition>();
  for (const definition of definitions) {
    if (definition.name.trim() === "") throw new Error("tool names cannot be empty");
    if (tools.has(definition.name)) throw new Error(`duplicate tool: ${definition.name}`);
    tools.set(definition.name, definition);
  }

  const list = (): HarnessToolDescriptor[] => [...tools.values()].map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    ...(tool.metadata ? { metadata: tool.metadata } : {}),
  }));

  return {
    list,
    async call(name, input, context) {
      const tool = tools.get(name);
      if (!tool) return failure("TOOL_NOT_FOUND", `Unknown tool: ${name}`);
      if (context.signal.aborted) return failure("TOOL_CANCELLED", `Tool cancelled: ${name}`);
      const decision = await options.policy?.(tool, input, context) ?? { decision: "allow" };
      if (decision.decision === "deny") {
        return failure(decision.code ?? "TOOL_DENIED", decision.reason);
      }
      let validated: unknown = input;
      try {
        validated = tool.validate?.(input) ?? input;
      } catch {
        return failure("TOOL_INPUT_INVALID", `Invalid input for tool: ${name}`);
      }
      try {
        return await tool.execute(validated, context);
      } catch (error) {
        options.onError?.(error, tool, context);
        return failure("TOOL_EXECUTION_FAILED", `Tool failed: ${name}`);
      }
    },
  };
}

