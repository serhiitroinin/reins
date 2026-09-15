import { describe, expect, test } from "bun:test";
import {
  decodeHarnessRunRequest,
  encodeHarnessRunRequest,
  HARNESS_WIRE_SCHEMA_VERSION,
  type HarnessWireRunRequest,
} from "../src/wire.ts";
import type { HarnessRunRequest } from "../src/protocol.ts";

describe("JSON wire protocol", () => {
  test("round-trips binary image input through canonical base64", () => {
    const request: HarnessRunRequest = {
      session: { tenantId: "tenant", actorId: "actor", threadId: "thread" },
      adapterId: "openai:codex",
      input: [
        { type: "text", text: "inspect this" },
        {
          type: "image",
          mediaType: "image/png",
          data: new Uint8Array([0, 1, 2, 253, 254, 255]),
          name: "",
        },
      ],
      model: "",
      settings: {
        permission: { modeId: "workspace-write", consentVersion: "shell-v3" },
        controls: { "openai:service-tier": "fast" },
      },
      configuration: { endpoint: "local", nested: [true, null, 3] },
      metadata: { source: "native-client" },
    };

    const wire = encodeHarnessRunRequest(request);
    expect(wire).toMatchObject({
      schemaVersion: HARNESS_WIRE_SCHEMA_VERSION,
      model: "",
      input: [{ type: "text" }, { type: "image", data: "AAEC/f7/", encoding: "base64", name: "" }],
    });
    expect(JSON.parse(JSON.stringify(wire))).toEqual(wire);
    expect(decodeHarnessRunRequest(wire)).toEqual(request);
  });

  test("rejects invalid encodings and unsupported schema versions", () => {
    const request: HarnessWireRunRequest = {
      schemaVersion: 1,
      session: { tenantId: "tenant", actorId: "actor", threadId: "thread" },
      adapterId: "example",
      input: [{ type: "image", mediaType: "image/png", data: "not-base64", encoding: "base64" }],
    };
    expect(() => decodeHarnessRunRequest(request)).toThrow("canonical base64");
    expect(() => decodeHarnessRunRequest({
      ...request,
      input: [{ type: "image", mediaType: "image/png", data: "AB==", encoding: "base64" }],
    })).toThrow("canonical base64");
    expect(() => decodeHarnessRunRequest({ ...request, schemaVersion: 2 } as unknown as HarnessWireRunRequest))
      .toThrow("unsupported harness wire schema version");
  });

  test("refuses values JSON would silently coerce or discard", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const base: HarnessRunRequest = {
      session: { tenantId: "tenant", actorId: "actor", threadId: "thread" },
      adapterId: "example",
      input: [],
    };
    expect(() => encodeHarnessRunRequest({ ...base, metadata: cyclic })).toThrow("cycle");
    expect(() => encodeHarnessRunRequest({ ...base, metadata: { date: new Date() } })).toThrow("plain JSON objects");
    expect(() => encodeHarnessRunRequest({
      ...base,
      settings: { controls: { temperature: Number.POSITIVE_INFINITY } },
    })).toThrow("finite JSON numbers");
  });
});
