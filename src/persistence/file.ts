/** Private, durable, single-writer Node persistence for sidecar deployments. */

import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  truncate,
  unlink,
} from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  harnessSessionKey,
  isHarnessEvent,
  type HarnessEvent,
  type HarnessEventInput,
  type HarnessSessionKey,
} from "../protocol.js";
import type {
  HarnessPersistence,
  StoredHarnessSession,
} from "../runtime.js";

export const FILE_PERSISTENCE_DEFAULT_MAX_EVENT_BYTES = 4_000_000;
export const FILE_PERSISTENCE_DEFAULT_MAX_EVENT_FILE_BYTES = 256_000_000;
export const FILE_PERSISTENCE_DEFAULT_MAX_SESSION_BYTES = 1_000_000;

export interface HarnessFilePersistenceOptions {
  /** Explicit absolute private directory. No home-directory default exists. */
  directory: string;
  createId?: () => string;
  now?: () => Date;
  maxEventBytes?: number;
  maxEventFileBytes?: number;
  maxSessionBytes?: number;
  /** Defaults to true. Disable only when the embedding host owns durability. */
  fsync?: boolean;
}

interface FileLayout {
  root: string;
  events: string;
  sessions: string;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return selected;
}

function key(session: HarnessSessionKey, adapterId: string): string {
  return harnessSessionKey(session, adapterId);
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code?: unknown }).code === "ENOENT";
}

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`persistence path is not a private directory: ${path}`);
  }
  await chmod(path, 0o700);
}

async function regularFile(path: string): Promise<"missing" | "file"> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`persistence path is not a regular file: ${path}`);
    }
    return "file";
  } catch (error) {
    if (isMissing(error)) return "missing";
    throw error;
  }
}

async function syncDirectory(path: string, enabled: boolean): Promise<void> {
  if (!enabled) return;
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function serialized() {
  const tails = new Map<string, Promise<void>>();
  return <T>(identity: string, operation: () => Promise<T>): Promise<T> => {
    const before = tails.get(identity) ?? Promise.resolve();
    const result = before.catch(() => undefined).then(operation);
    const tail = result.then(() => undefined, () => undefined);
    tails.set(identity, tail);
    void tail.finally(() => {
      if (tails.get(identity) === tail) tails.delete(identity);
    });
    return result;
  };
}

function validateEventFile(
  event: HarnessEvent,
  session: HarnessSessionKey,
  adapterId: string,
  expectedSequence: number,
): void {
  if (
    event.sequence !== expectedSequence
    || event.adapterId !== adapterId
    || harnessSessionKey(event.session, adapterId) !== key(session, adapterId)
  ) {
    throw new Error("the harness event store is corrupt");
  }
}

function storedSession(value: unknown, session: HarnessSessionKey, adapterId: string): StoredHarnessSession {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("the harness session store is corrupt");
  }
  const candidate = value as Partial<StoredHarnessSession>;
  if (
    !candidate.key
    || typeof candidate.key.tenantId !== "string"
    || typeof candidate.key.actorId !== "string"
    || typeof candidate.key.threadId !== "string"
    || candidate.adapterId !== adapterId
    || typeof candidate.updatedAt !== "string"
    || key(candidate.key, candidate.adapterId) !== key(session, adapterId)
    || (
      candidate.sessionBinding !== undefined
      && typeof candidate.sessionBinding !== "string"
    )
  ) {
    throw new Error("the harness session store is corrupt");
  }
  if (candidate.checkpoint !== null) {
    const checkpoint = candidate.checkpoint;
    if (
      !checkpoint
      || checkpoint.schemaVersion !== 1
      || typeof checkpoint.format !== "string"
      || checkpoint.format === ""
      || typeof checkpoint.token !== "string"
      || checkpoint.token === ""
    ) {
      throw new Error("the harness session store is corrupt");
    }
  }
  return candidate as StoredHarnessSession;
}

/**
 * Store events and opaque resume checkpoints in a private directory.
 *
 * This implementation serializes operations within one process. Point only
 * one sidecar process at a directory; cross-process locking is deliberately
 * not inferred from a filesystem path.
 */
export function createFilePersistence(options: HarnessFilePersistenceOptions): HarnessPersistence {
  if (!isAbsolute(options.directory)) {
    throw new Error("file persistence directory must be absolute");
  }
  const root = resolve(options.directory);
  const layout: FileLayout = {
    root,
    events: join(root, "events"),
    sessions: join(root, "sessions"),
  };
  const createId = options.createId ?? randomUUID;
  const now = options.now ?? (() => new Date());
  const maxEventBytes = positiveInteger(
    options.maxEventBytes,
    FILE_PERSISTENCE_DEFAULT_MAX_EVENT_BYTES,
    "maxEventBytes",
  );
  const maxEventFileBytes = positiveInteger(
    options.maxEventFileBytes,
    FILE_PERSISTENCE_DEFAULT_MAX_EVENT_FILE_BYTES,
    "maxEventFileBytes",
  );
  const maxSessionBytes = positiveInteger(
    options.maxSessionBytes,
    FILE_PERSISTENCE_DEFAULT_MAX_SESSION_BYTES,
    "maxSessionBytes",
  );
  if (maxEventFileBytes < maxEventBytes) {
    throw new Error("maxEventFileBytes must be at least maxEventBytes");
  }
  const durable = options.fsync ?? true;
  const runSerial = serialized();
  const knownSequences = new Map<string, number>();
  let ready: Promise<void> | null = null;

  const ensure = (): Promise<void> => {
    ready ??= (async () => {
      await privateDirectory(layout.root);
      await privateDirectory(layout.events);
      await privateDirectory(layout.sessions);
    })();
    return ready;
  };

  const eventPath = (identity: string): string => join(layout.events, `${digest(identity)}.ndjson`);
  const sessionPath = (identity: string): string => join(layout.sessions, `${digest(identity)}.json`);

  const readEvents = async (
    session: HarnessSessionKey,
    adapterId: string,
    repairTail: boolean,
  ): Promise<HarnessEvent[]> => {
    await ensure();
    const identity = key(session, adapterId);
    const path = eventPath(identity);
    if (await regularFile(path) === "missing") return [];
    const info = await stat(path);
    if (info.size > maxEventFileBytes) throw new Error("the harness event store exceeds its size limit");
    const bytes = await readFile(path);
    let usable = bytes.length;
    if (usable > 0 && bytes[usable - 1] !== 0x0a) {
      const newline = bytes.lastIndexOf(0x0a);
      usable = newline < 0 ? 0 : newline + 1;
      if (!repairTail) throw new Error("the harness event store has a torn final record");
      await truncate(path, usable);
      await chmod(path, 0o600);
    }
    const body = bytes.subarray(0, usable).toString("utf8");
    const lines = body === "" ? [] : body.slice(0, -1).split("\n");
    const events: HarnessEvent[] = [];
    for (const [index, line] of lines.entries()) {
      if (Buffer.byteLength(line, "utf8") > maxEventBytes) {
        throw new Error("the harness event store contains an oversized record");
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new Error("the harness event store is corrupt");
      }
      if (!isHarnessEvent(parsed)) throw new Error("the harness event store is corrupt");
      validateEventFile(parsed, session, adapterId, index + 1);
      events.push(parsed);
    }
    knownSequences.set(identity, events.at(-1)?.sequence ?? 0);
    return events;
  };

  const append = async (input: HarnessEventInput): Promise<HarnessEvent> => {
    const identity = key(input.session, input.adapterId);
    return runSerial(`events:${identity}`, async () => {
      await ensure();
      let sequence = knownSequences.get(identity);
      if (sequence === undefined) {
        const previous = await readEvents(input.session, input.adapterId, true);
        sequence = previous.at(-1)?.sequence ?? 0;
      }
      const event: HarnessEvent = {
        ...input,
        eventId: createId(),
        sequence: sequence + 1,
        timestamp: now().toISOString(),
      };
      const encoded = Buffer.from(`${JSON.stringify(event)}\n`, "utf8");
      if (encoded.byteLength > maxEventBytes) throw new Error("the harness event exceeds its size limit");
      const path = eventPath(identity);
      const priorSize = await regularFile(path) === "file" ? (await stat(path)).size : 0;
      if (priorSize + encoded.byteLength > maxEventFileBytes) {
        throw new Error("the harness event store exceeds its size limit");
      }
      const flags = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT
        | (constants.O_NOFOLLOW ?? 0);
      const handle = await open(path, flags, 0o600);
      try {
        await handle.chmod(0o600);
        await handle.writeFile(encoded);
        if (durable) await handle.sync();
      } finally {
        await handle.close();
      }
      knownSequences.set(identity, event.sequence);
      return event;
    });
  };

  const list = async (
    session: HarnessSessionKey,
    adapterId: string,
    after = 0,
  ): Promise<readonly HarnessEvent[]> => {
    if (!Number.isSafeInteger(after) || after < 0) throw new Error("after must be a non-negative integer");
    const identity = key(session, adapterId);
    return runSerial(`events:${identity}`, async () => {
      const events = await readEvents(session, adapterId, true);
      return events.filter((event) => event.sequence > after);
    });
  };

  const writeSession = async (value: StoredHarnessSession): Promise<void> => {
    await ensure();
    const identity = key(value.key, value.adapterId);
    const path = sessionPath(identity);
    const encoded = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
    if (encoded.byteLength > maxSessionBytes) throw new Error("the harness session exceeds its size limit");
    const temporary = join(layout.sessions, `.${digest(identity)}.${process.pid}.${randomUUID()}.tmp`);
    const handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      await handle.writeFile(encoded);
      if (durable) await handle.sync();
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    await handle.close();
    try {
      await rename(temporary, path);
      await chmod(path, 0o600);
      await syncDirectory(layout.sessions, durable);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  };

  return {
    events: { append, list },
    sessions: {
      async load(session, adapterId) {
        const identity = key(session, adapterId);
        return runSerial(`session:${identity}`, async () => {
          await ensure();
          const path = sessionPath(identity);
          if (await regularFile(path) === "missing") return null;
          const info = await stat(path);
          if (info.size > maxSessionBytes) throw new Error("the harness session exceeds its size limit");
          let parsed: unknown;
          try {
            parsed = JSON.parse(await readFile(path, "utf8"));
          } catch (error) {
            if (error instanceof SyntaxError) throw new Error("the harness session store is corrupt");
            throw error;
          }
          return storedSession(parsed, session, adapterId);
        });
      },
      async save(session) {
        const identity = key(session.key, session.adapterId);
        await runSerial(`session:${identity}`, async () => writeSession(session));
      },
      async remove(session, adapterId) {
        const identity = key(session, adapterId);
        await runSerial(`session:${identity}`, async () => {
          await ensure();
          const path = sessionPath(identity);
          if (await regularFile(path) === "missing") return;
          await unlink(path);
          await syncDirectory(layout.sessions, durable);
        });
      },
    },
  };
}
