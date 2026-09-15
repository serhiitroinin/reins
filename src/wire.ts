/** JSON-safe representations of the in-process harness protocol. */

import type {
  HarnessInput,
  HarnessRunRequest,
} from "./protocol.js";
import type {
  HarnessControlValue,
  HarnessDiscoveryRequest,
  HarnessPermissionSelection,
} from "./profile.js";

export const HARNESS_WIRE_SCHEMA_VERSION = 1 as const;

export type HarnessJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly HarnessJsonValue[]
  | HarnessJsonObject;

export interface HarnessJsonObject {
  readonly [key: string]: HarnessJsonValue;
}

export type HarnessWireInput =
  | { type: "text"; text: string }
  | {
      type: "image";
      mediaType: string;
      /** Binary image bytes encoded as canonical RFC 4648 base64. */
      data: string;
      encoding: "base64";
      name?: string;
    }
  | { type: "resource"; uri: string; mediaType?: string; name?: string };

export interface HarnessWireRunSettings {
  permission?: HarnessPermissionSelection;
  controls?: Readonly<Record<string, HarnessControlValue>>;
}

/** Portable discovery input. Cancellation remains a host/runtime concern. */
export interface HarnessWireDiscoveryRequest extends Pick<HarnessDiscoveryRequest, "accountId" | "modelId"> {
  schemaVersion: typeof HARNESS_WIRE_SCHEMA_VERSION;
  adapterId: string;
}

/**
 * Portable run input for JSON transports and native bindings.
 *
 * `configuration` remains adapter-specific even though its values are JSON.
 * Native products should prefer negotiated settings whenever a control has a
 * portable UI representation.
 */
export interface HarnessWireRunRequest {
  schemaVersion: typeof HARNESS_WIRE_SCHEMA_VERSION;
  session: HarnessRunRequest["session"];
  adapterId: string;
  input: readonly HarnessWireInput[];
  model?: string;
  effort?: string;
  accountId?: string;
  settings?: HarnessWireRunSettings;
  configuration?: HarnessJsonObject;
  metadata?: HarnessJsonObject;
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function encodeBase64(bytes: Uint8Array): string {
  let encoded = "";
  for (let offset = 0; offset < bytes.length; offset += 3) {
    const first = bytes[offset] ?? 0;
    const hasSecond = offset + 1 < bytes.length;
    const hasThird = offset + 2 < bytes.length;
    const second = bytes[offset + 1] ?? 0;
    const third = bytes[offset + 2] ?? 0;
    encoded += BASE64_ALPHABET[first >>> 2];
    encoded += BASE64_ALPHABET[((first & 0x03) << 4) | (second >>> 4)];
    encoded += hasSecond ? BASE64_ALPHABET[((second & 0x0f) << 2) | (third >>> 6)] : "=";
    encoded += hasThird ? BASE64_ALPHABET[third & 0x3f] : "=";
  }
  return encoded;
}

function decodeBase64(value: string): Uint8Array {
  if (!BASE64_PATTERN.test(value)) throw new TypeError("image data must be canonical base64");
  if (value === "") return new Uint8Array();
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const bytes = new Uint8Array((value.length / 4) * 3 - padding);
  let target = 0;
  for (let offset = 0; offset < value.length; offset += 4) {
    const first = BASE64_ALPHABET.indexOf(value[offset] ?? "");
    const second = BASE64_ALPHABET.indexOf(value[offset + 1] ?? "");
    const thirdCharacter = value[offset + 2] ?? "=";
    const fourthCharacter = value[offset + 3] ?? "=";
    const third = thirdCharacter === "=" ? 0 : BASE64_ALPHABET.indexOf(thirdCharacter);
    const fourth = fourthCharacter === "=" ? 0 : BASE64_ALPHABET.indexOf(fourthCharacter);
    bytes[target++] = (first << 2) | (second >>> 4);
    if (thirdCharacter !== "=") {
      bytes[target++] = ((second & 0x0f) << 4) | (third >>> 2);
    }
    if (fourthCharacter !== "=") {
      bytes[target++] = ((third & 0x03) << 6) | fourth;
    }
  }
  if (encodeBase64(bytes) !== value) throw new TypeError("image data must be canonical base64");
  return bytes;
}

function jsonValue(value: unknown, path: string, ancestors: Set<object>): HarnessJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${path} must contain only finite JSON numbers`);
    if (Object.is(value, -0)) throw new TypeError(`${path} must not contain negative zero`);
    return value;
  }
  if (typeof value !== "object") throw new TypeError(`${path} must contain only JSON values`);
  if (ancestors.has(value)) throw new TypeError(`${path} must not contain a cycle`);

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Reflect.ownKeys(value).length !== value.length + 1) {
        throw new TypeError(`${path} must not contain array holes or extra properties`);
      }
      const result: HarnessJsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new TypeError(`${path} must not contain array holes or extra properties`);
        }
        result.push(jsonValue(value[index], `${path}[${index}]`, ancestors));
      }
      return result;
    }
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${path} must contain only plain JSON objects`);
    }
    const result: Record<string, HarnessJsonValue> = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") throw new TypeError(`${path} must not contain symbol keys`);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        throw new TypeError(`${path}.${key} must be an enumerable data property`);
      }
      result[key] = jsonValue(descriptor.value, `${path}.${key}`, ancestors);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function jsonObject(value: Readonly<Record<string, unknown>>, path: string): HarnessJsonObject {
  const result = jsonValue(value, path, new Set());
  if (result === null || Array.isArray(result) || typeof result !== "object") {
    throw new TypeError(`${path} must be a JSON object`);
  }
  return result as HarnessJsonObject;
}

function wireSettings(settings: HarnessRunRequest["settings"]): HarnessWireRunSettings | undefined {
  if (!settings) return undefined;
  const controls = settings.controls
    ? jsonObject(settings.controls, "settings.controls") as Readonly<Record<string, HarnessControlValue>>
    : undefined;
  return {
    ...(settings.permission ? { permission: { ...settings.permission } } : {}),
    ...(controls ? { controls } : {}),
  };
}

/** Convert a runtime request into its portable JSON representation. */
export function encodeHarnessRunRequest(request: HarnessRunRequest): HarnessWireRunRequest {
  const input = request.input.map((part): HarnessWireInput => {
    if (part.type === "image") {
      return {
        type: "image",
        mediaType: part.mediaType,
        data: encodeBase64(part.data),
        encoding: "base64",
        ...(part.name !== undefined ? { name: part.name } : {}),
      };
    }
    return { ...part };
  });
  const settings = wireSettings(request.settings);
  return {
    schemaVersion: HARNESS_WIRE_SCHEMA_VERSION,
    session: { ...request.session },
    adapterId: request.adapterId,
    input,
    ...(request.model !== undefined ? { model: request.model } : {}),
    ...(request.effort !== undefined ? { effort: request.effort } : {}),
    ...(request.accountId !== undefined ? { accountId: request.accountId } : {}),
    ...(settings ? { settings } : {}),
    ...(request.configuration ? { configuration: jsonObject(request.configuration, "configuration") } : {}),
    ...(request.metadata ? { metadata: jsonObject(request.metadata, "metadata") } : {}),
  };
}

/** Convert a portable request back into the in-process representation. */
export function decodeHarnessRunRequest(request: HarnessWireRunRequest): HarnessRunRequest {
  if (request.schemaVersion !== HARNESS_WIRE_SCHEMA_VERSION) {
    throw new TypeError(`unsupported harness wire schema version: ${String(request.schemaVersion)}`);
  }
  const input = request.input.map((part): HarnessInput => part.type === "image"
    ? {
        type: "image",
        mediaType: part.mediaType,
        data: decodeBase64(part.data),
        ...(part.name !== undefined ? { name: part.name } : {}),
      }
    : { ...part });
  return {
    session: { ...request.session },
    adapterId: request.adapterId,
    input,
    ...(request.model !== undefined ? { model: request.model } : {}),
    ...(request.effort !== undefined ? { effort: request.effort } : {}),
    ...(request.accountId !== undefined ? { accountId: request.accountId } : {}),
    ...(request.settings ? {
      settings: {
        ...(request.settings.permission ? { permission: { ...request.settings.permission } } : {}),
        ...(request.settings.controls ? { controls: { ...request.settings.controls } } : {}),
      },
    } : {}),
    ...(request.configuration ? { configuration: jsonObject(request.configuration, "configuration") } : {}),
    ...(request.metadata ? { metadata: jsonObject(request.metadata, "metadata") } : {}),
  };
}
