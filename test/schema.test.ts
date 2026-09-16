import { describe, expect, test } from "bun:test";
import Ajv2020, { type AnySchema, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { HarnessCapabilities, HarnessEvent, HarnessEventPayload } from "../src/protocol.ts";
import type {
  HarnessDiscovery,
  HarnessEngineProfile,
  HarnessLimitSnapshot,
  HarnessModelCatalog,
} from "../src/profile.ts";
import { encodeHarnessRunRequest } from "../src/wire.ts";

const protocolSchema = await Bun.file(new URL("../schema/v1/protocol.schema.json", import.meta.url)).json() as AnySchema;
const discoverySchema = await Bun.file(new URL("../schema/v1/discovery.schema.json", import.meta.url)).json() as AnySchema;
const bindingsSchema = await Bun.file(new URL("../scripts/bindings-v1.schema.json", import.meta.url)).json() as AnySchema;
const nativeFixture = await Bun.file(new URL("../schema/v1/fixtures/native-v1.json", import.meta.url)).json() as unknown;

function validator(schema: AnySchema, root: string): ValidateFunction {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  ajv.addSchema(schema);
  const validate = ajv.getSchema(root);
  if (!validate) throw new Error(`schema root was not registered: ${root}`);
  return validate;
}

const event = (payload: HarnessEventPayload): HarnessEvent => ({
  schemaVersion: 1,
  eventId: "event-1",
  sequence: 1,
  timestamp: "2026-09-15T09:00:00.000Z",
  session: { tenantId: "tenant", actorId: "actor", threadId: "thread" },
  runId: "run-1",
  turnId: "turn-1",
  adapterId: "example:adapter",
  payload,
});

const payloads: readonly HarnessEventPayload[] = [
  { kind: "turn-started", model: "grok-4", accountId: "account" },
  { kind: "assistant-text", text: "hello" },
  { kind: "thinking", text: "considering" },
  { kind: "plan-updated", steps: [{ text: "Inspect", status: "in_progress" }] },
  { kind: "tool-started", toolId: "tool-1", toolKind: "shell", title: "Run", paths: ["/workspace"] },
  { kind: "tool-updated", toolId: "tool-1", toolKind: "shell", title: "Run", outputAppend: "partial" },
  { kind: "tool-completed", toolId: "tool-1", toolKind: "shell", title: "Run", status: "completed", exitCode: 0 },
  {
    kind: "interaction-requested",
    interaction: {
      id: "question-1",
      kind: "question",
      title: "Choose",
      choices: [{ id: "alpha", label: "Alpha" }],
      acceptsText: true,
    },
  },
  { kind: "interaction-resolved", interactionId: "question-1", response: { text: "custom", labels: ["alpha"] } },
  { kind: "interaction-invalidated", interactionId: "question-2", reason: "runtime-restarted", message: "Restart the turn." },
  { kind: "usage", usage: { inputTokens: 10, outputTokens: 4, provider: { cached: true } } },
  { kind: "error", code: "PROVIDER_UNAVAILABLE", message: "Try again.", retryable: true },
  { kind: "turn-completed", status: "completed", usage: { totalTokens: 14 } },
  { kind: "extension", namespace: "xai:grok", name: "citation", payload: { uri: "https://example.com" } },
];

const capabilities: HarnessCapabilities = {
  resume: { support: "stable" },
  cancel: { support: "stable" },
  interactions: { support: "experimental", recovery: "provider-replay" },
  tools: { support: "stable" },
  images: { support: "stable" },
  thinking: { support: "stable" },
  plans: { support: "experimental" },
  usage: { support: "stable" },
  subagents: { support: "unsupported" },
  shell: { support: "unsupported" },
  filesystem: { support: "unsupported" },
  network: { support: "unsupported" },
  steering: {
    support: "stable",
    strategies: ["same-turn", "replacement-turn"],
    preferred: "same-turn",
  },
  extensions: { "opencode:multi-provider": { support: "stable", constraints: { count: 3 } } },
};

const profile: HarnessEngineProfile = {
  id: "opencode:acp",
  label: "OpenCode",
  permissions: {
    kind: "provider-policy",
    selectable: true,
    defaultModeId: "ask",
    modes: [
      { id: "ask", label: "Ask", posture: "standard" },
      {
        id: "allow-all",
        label: "Allow all",
        posture: "vendor:autonomous",
        consent: { version: "grant-v1", title: "Allow provider actions", description: "Provider actions may run." },
      },
    ],
  },
  controls: [{ id: "opencode:loop-budget", label: "Loop budget", kind: "number", scope: "turn", min: 1, defaultValue: 8 }],
  inputPolicy: {
    maxItems: 20,
    modalities: {
      text: { support: "stable", maxTextCharacters: 100_000 },
      image: { support: "experimental", maxCount: 4, mediaTypes: ["image/png"] },
      resource: { support: "unsupported" },
    },
  },
  extensions: { "opencode:transport": "acp" },
};

const models: HarnessModelCatalog = {
  selection: "required",
  defaultModelId: "gpt-5.6-luna",
  models: [
    {
      id: "gpt-5.6-luna",
      label: "GPT-5.6 Luna",
      group: { id: "openai", label: "OpenAI" },
      inputPolicy: { modalities: { image: { support: "stable", maxItemBytes: 3_000_000 } } },
      controls: [{
        id: "openai:service-tier",
        label: "Speed",
        kind: "select",
        scope: "turn",
        options: [
          { id: "default", label: "Standard" },
          { id: "fast", label: "Fast", description: "1.5x speed, increased usage" },
        ],
        defaultValue: "default",
      }],
    },
    { id: "grok-4", label: "Grok 4", group: { id: "xai", label: "xAI" }, extensions: { "xai:live-search": true } },
  ],
};

const limits: HarnessLimitSnapshot = {
  planLabel: "Developer",
  limits: [{
    id: "xai:requests",
    label: "Requests",
    kind: "vendor:request-rate",
    scope: "account",
    unit: "requests",
    used: 3,
    limit: 100,
    resetsAt: "2026-09-15T10:00:00.000Z",
    modelIds: ["grok-4"],
  }],
};

describe("versioned JSON Schema", () => {
  test("publishes valid draft 2020-12 documents", () => {
    const ajv = new Ajv2020({ strict: true });
    addFormats(ajv);
    expect(ajv.validateSchema(protocolSchema)).toBe(true);
    expect(ajv.validateSchema(discoverySchema)).toBe(true);
  });

  test("the native generation fixture conforms to every reachable contract", () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    ajv.addSchema(protocolSchema);
    ajv.addSchema(discoverySchema);
    const validate = ajv.compile(bindingsSchema);
    expect(validate(nativeFixture), JSON.stringify(validate.errors)).toBe(true);
  });

  test("validates every core event payload and additive future kinds", () => {
    const validate = validator(protocolSchema, "https://github.com/serhiitroinin/fold-harness/schema/v1/protocol.schema.json#/$defs/HarnessEvent");
    for (const payload of payloads) {
      expect(validate(event(payload)), JSON.stringify(validate.errors)).toBe(true);
    }
    expect(validate(event({ kind: "provider-summary", summary: "future" } as unknown as HarnessEventPayload))).toBe(true);
    expect(validate(event({ kind: "assistant-text" } as HarnessEventPayload))).toBe(false);
    expect(validate({ ...event(payloads[0]!), schemaVersion: 2 })).toBe(false);
    expect(validate({ ...event(payloads[0]!), sequence: 0 })).toBe(false);
  });

  test("validates portable run, capability, interaction, and tool roots", () => {
    const roots: ReadonlyArray<readonly [string, unknown]> = [
      ["HarnessCapabilities", capabilities],
      ["HarnessInteractionResponse", { choiceId: "allow", text: "because", labels: ["reviewed"] }],
      ["HarnessToolDescriptor", { name: "lookup", description: "Lookup", inputSchema: { type: "object" } }],
      ["HarnessToolResult", { content: [{ type: "text", text: "ready" }], metadata: { cached: false } }],
      ["HarnessWireRunRequest", encodeHarnessRunRequest({
        session: { tenantId: "tenant", actorId: "actor", threadId: "thread" },
        adapterId: "openai:codex",
        input: [
          { type: "context-reference", contextId: "future-1" },
          { type: "image", id: "image-1", mediaType: "image/png", data: new Uint8Array([1, 2, 3]) },
        ],
        inlineContext: {
          version: 1,
          records: [{
            version: 1,
            id: "future-1",
            kind: "future:record",
            label: "Future record",
            payload: { retained: true },
            binding: { type: "attachment", inputId: "image-1", sizeBytes: 3 },
          }],
        },
        settings: { controls: { "openai:service-tier": "fast" } },
      })],
    ];
    for (const [root, value] of roots) {
      const validate = validator(protocolSchema, `https://github.com/serhiitroinin/fold-harness/schema/v1/protocol.schema.json#/$defs/${root}`);
      expect(validate(value), `${root}: ${JSON.stringify(validate.errors)}`).toBe(true);
    }
    const validateRun = validator(protocolSchema, "https://github.com/serhiitroinin/fold-harness/schema/v1/protocol.schema.json#/$defs/HarnessWireRunRequest");
    expect(validateRun({ schemaVersion: 1, session: {}, adapterId: "", input: [] })).toBe(false);
    expect(validateRun({
      schemaVersion: 1,
      session: { tenantId: "tenant", actorId: "actor", threadId: "thread" },
      adapterId: "example",
      input: [{ type: "image", mediaType: "image/png", data: "AB==", encoding: "base64" }],
    })).toBe(false);
    const validateCapabilities = validator(
      protocolSchema,
      "https://github.com/serhiitroinin/fold-harness/schema/v1/protocol.schema.json#/$defs/HarnessCapabilities",
    );
    expect(validateCapabilities({
      ...capabilities,
      steering: { support: "stable", strategies: ["wait"] },
    })).toBe(false);
  });

  test("keeps provider-specific models, controls, permissions, and limits as data", () => {
    const cases: ReadonlyArray<readonly [string, unknown]> = [
      ["HarnessEngineProfile", profile],
      ["HarnessModelCatalog", models],
      ["HarnessLimitSnapshot", limits],
      ["HarnessEngineProfileDiscovery", { status: "available", value: profile, fetchedAt: "2026-09-15T09:00:00.000Z" } satisfies HarnessDiscovery<HarnessEngineProfile>],
      ["HarnessModelCatalogDiscovery", { status: "available", value: models } satisfies HarnessDiscovery<HarnessModelCatalog>],
      ["HarnessLimitSnapshotDiscovery", { status: "available", value: limits } satisfies HarnessDiscovery<HarnessLimitSnapshot>],
      ["HarnessEngineProfileDiscovery", { status: "unavailable", message: "Sign in.", retryable: true } satisfies HarnessDiscovery<HarnessEngineProfile>],
      ["HarnessModelCatalogDiscovery", { status: "unsupported", message: "Static model." } satisfies HarnessDiscovery<HarnessModelCatalog>],
    ];
    for (const [root, value] of cases) {
      const validate = validator(discoverySchema, `https://github.com/serhiitroinin/fold-harness/schema/v1/discovery.schema.json#/$defs/${root}`);
      expect(validate(value), `${root}: ${JSON.stringify(validate.errors)}`).toBe(true);
    }
  });

  test("rejects malformed discovery states and closed control kinds", () => {
    const validateDiscovery = validator(
      discoverySchema,
      "https://github.com/serhiitroinin/fold-harness/schema/v1/discovery.schema.json#/$defs/HarnessEngineProfileDiscovery",
    );
    expect(validateDiscovery({ status: "available" })).toBe(false);
    expect(validateDiscovery({ status: "unavailable", message: "later", value: profile })).toBe(false);
    expect(validateDiscovery({ status: "future" })).toBe(false);

    const validateProfile = validator(discoverySchema, "https://github.com/serhiitroinin/fold-harness/schema/v1/discovery.schema.json#/$defs/HarnessEngineProfile");
    expect(validateProfile({
      ...profile,
      controls: [{ id: "future", label: "Future", kind: "slider", scope: "turn" }],
    })).toBe(false);
  });
});
