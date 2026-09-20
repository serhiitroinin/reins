import { describe, expect, test } from "bun:test";
import {
  HARNESS_EXTENSION_PAYLOAD_MAX_BYTES,
  isHarnessRedactedExtensionPayload,
  projectHarnessEventPayloadForPersistence,
  type HarnessExtensionEvent,
  type HarnessToolExtensionEvent,
} from "../src/event-projection.ts";

const extension = (payload: unknown): HarnessExtensionEvent => ({
  kind: "extension",
  namespace: "example:provider",
  name: "activity",
  payload,
});

describe("durable event projection", () => {
  test("redacts an extension payload unless its adapter explicitly approves it", () => {
    const raw = { secret: "must-not-persist" };
    const projected = projectHarnessEventPayloadForPersistence({
      ...extension(raw),
      rawProviderResponse: "must-not-persist-outside-payload",
    } as HarnessExtensionEvent, undefined);

    expect(projected.issue?.code).toBe("EXTENSION_NOT_APPROVED");
    expect(projected.payload?.kind).toBe("extension");
    if (projected.payload?.kind !== "extension") throw new Error("extension was not retained");
    expect(isHarnessRedactedExtensionPayload(projected.payload.payload)).toBe(true);
    expect(JSON.stringify(projected.payload)).not.toContain(raw.secret);
    expect(JSON.stringify(projected.payload)).not.toContain("must-not-persist-outside-payload");
  });

  test("detaches explicitly approved JSON without mutating the adapter value", () => {
    const raw = { rows: [{ status: "working" }] };
    const event = extension(raw);
    const projected = projectHarnessEventPayloadForPersistence(event, {
      projectExtension: (event) => event.payload,
    });

    expect(projected.issue).toBeUndefined();
    expect(projected.payload).toEqual(extension(raw));
    expect(projected.payload).not.toBe(event);
    if (projected.payload?.kind !== "extension") throw new Error("extension was not retained");
    expect(projected.payload.payload).not.toBe(raw);
    raw.rows[0]!.status = "changed";
    expect(projected.payload.payload).toEqual({ rows: [{ status: "working" }] });
  });

  test("rejects excessive depth and collection members before persistence", () => {
    let deep: unknown = "leaf";
    for (let index = 0; index < 14; index += 1) deep = { next: deep };
    const many = Array.from({ length: 257 }, (_, index) => index);

    for (const value of [deep, many]) {
      const projected = projectHarnessEventPayloadForPersistence(extension(value), {
        projectExtension: (event) => event.payload,
      });
      expect(projected.issue?.code).toBe("EXTENSION_VALUE_LIMIT_EXCEEDED");
      if (projected.payload?.kind !== "extension") throw new Error("extension was not retained");
      expect(projected.payload.payload).toEqual({
        "reins:redacted": true,
        reason: "limit-exceeded",
      });
    }
  });

  test("replaces cyclic, accessor, class, bigint, and non-finite values without reading raw accessors", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    let getterReads = 0;
    const accessor = Object.defineProperty({}, "secret", {
      enumerable: true,
      get() {
        getterReads += 1;
        return "secret";
      },
    });
    const accessorArray = ["placeholder"];
    Object.defineProperty(accessorArray, 0, {
      enumerable: true,
      get() {
        getterReads += 1;
        return "secret";
      },
    });
    class ProviderResponse { value = "raw"; }
    const throwingProxy = new Proxy({}, { ownKeys() { throw new Error("raw provider trap"); } });
    const values = [
      cyclic,
      accessor,
      accessorArray,
      new ProviderResponse(),
      throwingProxy,
      1n,
      Number.POSITIVE_INFINITY,
      -0,
    ];

    for (const value of values) {
      const projected = projectHarnessEventPayloadForPersistence(extension(value), {
        projectExtension: (event) => event.payload,
      });
      expect(projected.issue?.code).toBe("EXTENSION_VALUE_INVALID");
      if (projected.payload?.kind !== "extension") throw new Error("extension was not retained");
      expect(projected.payload.payload).toEqual({
        "reins:redacted": true,
        reason: "invalid-value",
      });
    }
    expect(getterReads).toBe(0);
  });

  test("uses UTF-8 bytes and fixed markers instead of retaining an oversized prefix", () => {
    const secret = "🙂".repeat((HARNESS_EXTENSION_PAYLOAD_MAX_BYTES / 4) + 1);
    expect(secret.length).toBeLessThan(HARNESS_EXTENSION_PAYLOAD_MAX_BYTES);
    const projected = projectHarnessEventPayloadForPersistence(extension({ secret }), {
      projectExtension: (event) => event.payload,
    });

    expect(projected.issue?.code).toBe("EXTENSION_VALUE_LIMIT_EXCEEDED");
    if (projected.payload?.kind !== "extension") throw new Error("extension was not retained");
    expect(projected.payload.payload).toEqual({
      "reins:redacted": true,
      reason: "limit-exceeded",
    });
    expect(JSON.stringify(projected.payload)).not.toContain("🙂");
  });

  test("redacts a throwing projector and ignores an invalid extension envelope", () => {
    const failed = projectHarnessEventPayloadForPersistence(extension("raw"), {
      projectExtension() { throw new Error("raw provider failure"); },
    });
    expect(failed.issue?.code).toBe("EXTENSION_PROJECTION_FAILED");
    if (failed.payload?.kind !== "extension") throw new Error("extension was not retained");
    expect(failed.payload.payload).toEqual({
      "reins:redacted": true,
      reason: "projection-failed",
    });

    const ignored = projectHarnessEventPayloadForPersistence({
      ...extension("raw"),
      namespace: " invalid ",
    }, { projectExtension: (event) => event.payload });
    expect(ignored).toMatchObject({ payload: null, issue: { code: "EXTENSION_ENVELOPE_INVALID" } });
  });

  test("removes unapproved or unsafe tool extension maps and marks the presentation truncated", () => {
    const tool = {
      kind: "tool-updated" as const,
      toolId: "tool-1",
      toolKind: "search",
      title: "Search",
      extensions: { "example:raw": "secret" },
      rawProviderResponse: "must-not-persist-outside-extensions",
    } as const;
    const refused = projectHarnessEventPayloadForPersistence(tool, undefined);
    expect(refused.payload).toEqual({
      kind: "tool-updated",
      toolId: "tool-1",
      toolKind: "search",
      title: "Search",
      truncated: true,
    });
    expect(refused.issue?.code).toBe("EXTENSION_NOT_APPROVED");
    expect(JSON.stringify(refused.payload)).not.toContain("must-not-persist-outside-extensions");

    const approved = projectHarnessEventPayloadForPersistence(tool, {
      projectToolExtensions: (event) => event.extensions,
    });
    expect(approved.issue).toBeUndefined();
    expect(approved.payload).toEqual({
      kind: "tool-updated",
      toolId: "tool-1",
      toolKind: "search",
      title: "Search",
      extensions: { "example:raw": "secret" },
    });
    expect(JSON.stringify(approved.payload)).not.toContain("must-not-persist-outside-extensions");

    const oversized = projectHarnessEventPayloadForPersistence(tool, {
      projectToolExtensions: () => ({ raw: "x".repeat(HARNESS_EXTENSION_PAYLOAD_MAX_BYTES) }),
    });
    expect(oversized.payload).toEqual({
      kind: "tool-updated",
      toolId: "tool-1",
      toolKind: "search",
      title: "Search",
      truncated: true,
    });
    expect(oversized.issue?.code).toBe("EXTENSION_VALUE_LIMIT_EXCEEDED");
  });

  test("rebuilds tool envelopes even when no extension map was supplied", () => {
    const projected = projectHarnessEventPayloadForPersistence({
      kind: "tool-started",
      toolId: "tool-1",
      toolKind: "search",
      title: "Search",
      rawProviderResponse: "must-not-persist",
    } as HarnessToolExtensionEvent, undefined);

    expect(projected).toEqual({
      payload: {
        kind: "tool-started",
        toolId: "tool-1",
        toolKind: "search",
        title: "Search",
      },
    });
  });
});
