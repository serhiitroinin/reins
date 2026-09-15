import { describe, expect, test } from "bun:test";
import {
  HARNESS_CONTEXT_MAX_PAYLOAD_CHARACTERS,
  harnessContextReferenceText,
  validateHarnessInlineContext,
  validateHarnessInput,
} from "../src/input.ts";
import type { HarnessInlineContext, HarnessInput } from "../src/protocol.ts";

const input: readonly HarnessInput[] = [
  { type: "text", text: "Compare " },
  { type: "context-reference", contextId: "task-1", referenceId: "mention-1" },
  { type: "text", text: " with " },
  { type: "context-reference", contextId: "future-1", referenceId: "mention-2" },
];

const inlineContext: HarnessInlineContext = {
  version: 1,
  records: [
    { version: 1, id: "task-1", kind: "task", label: "Ship parity", payload: { status: "open" } },
    { version: 1, id: "future-1", kind: "future:crm-record", label: "Acme", payload: { id: 42 } },
  ],
};

describe("typed harness input", () => {
  test("retains open future kinds and resolves occurrences in input order", () => {
    const result = validateHarnessInlineContext(inlineContext, input);
    expect(result.valid).toBe(true);
    expect(result.references.map(({ inputIndex, referenceId, record }) => ({
      inputIndex,
      referenceId,
      id: record.id,
      kind: record.kind,
    }))).toEqual([
      { inputIndex: 1, referenceId: "mention-1", id: "task-1", kind: "task" },
      { inputIndex: 3, referenceId: "mention-2", id: "future-1", kind: "future:crm-record" },
    ]);
    expect(harnessContextReferenceText(input[1] as Extract<HarnessInput, { type: "context-reference" }>, inlineContext))
      .toBe("[task: Ship parity]\n{\"status\":\"open\"}");
  });

  test("fails closed for duplicate ids, stale references, malformed payloads, and oversized payloads", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const result = validateHarnessInlineContext({
      version: 1,
      records: [
        inlineContext.records[0],
        { ...inlineContext.records[0], label: "duplicate" },
        { version: 1, id: "cycle", kind: "note", label: "Cycle", payload: cyclic },
        {
          version: 1,
          id: "large",
          kind: "note",
          label: "Large",
          payload: "x".repeat(HARNESS_CONTEXT_MAX_PAYLOAD_CHARACTERS + 1),
        },
      ],
    }, [
      { type: "context-reference", contextId: "missing" },
    ]);
    expect(result.valid).toBe(false);
    expect(result.issues.map(({ code }) => code)).toEqual(expect.arrayContaining([
      "duplicate-context-id",
      "invalid-context-payload",
      "context-payload-too-large",
      "stale-context-reference",
    ]));
  });

  test("keeps attachment bytes in ordinary inputs and validates byte-free bindings", () => {
    const image = new Uint8Array([1, 2, 3]);
    const boundInput: readonly HarnessInput[] = [
      { type: "context-reference", contextId: "image-context" },
      { type: "image", id: "image-1", mediaType: "image/png", data: image, name: "pixel.png" },
    ];
    const boundContext: HarnessInlineContext = {
      version: 1,
      records: [{
        version: 1,
        id: "image-context",
        kind: "attachment",
        label: "pixel.png",
        payload: { caption: "Pixel" },
        binding: {
          type: "attachment",
          inputId: "image-1",
          name: "pixel.png",
          mediaType: "image/png",
          sizeBytes: 3,
        },
      }],
    };
    expect(validateHarnessInlineContext(boundContext, boundInput).valid).toBe(true);
    expect(JSON.stringify(boundContext)).not.toContain("AQID");
    expect(validateHarnessInlineContext({
      ...boundContext,
      records: [{
        ...boundContext.records[0]!,
        binding: { type: "resource", inputId: "image-1" },
      }],
    }, boundInput).issues.map(({ code }) => code)).toContain("mismatched-context-binding");
  });

  test("validates modalities and declared limits without provider-name branches", () => {
    const result = validateHarnessInput([
      { type: "text", text: "four" },
      { type: "image", mediaType: "image/gif", data: new Uint8Array([1, 2, 3]) },
      { type: "resource", uri: "fold://note/1" },
    ], {
      maxItems: 2,
      maxTotalBytes: 4,
      modalities: {
        text: { support: "stable", maxTextCharacters: 3 },
        image: { support: "experimental", maxItemBytes: 2, mediaTypes: ["image/png"] },
        resource: { support: "unsupported" },
      },
    });
    expect(result.valid).toBe(false);
    expect(result.issues.map(({ code }) => code)).toEqual(expect.arrayContaining([
      "input-count-exceeded",
      "input-bytes-exceeded",
      "input-item-bytes-exceeded",
      "text-length-exceeded",
      "media-type-unsupported",
      "unsupported-modality",
    ]));
  });

  test("treats absent policy constraints as unknown, not unsupported", () => {
    expect(validateHarnessInput([
      { type: "resource", uri: "future://record/1", mediaType: "application/x-future" },
    ], { modalities: {} }).issues).toEqual([]);
    expect(validateHarnessInput([{ type: "text", text: "hello" }], undefined).valid).toBe(true);
  });
});
