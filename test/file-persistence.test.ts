import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, lstat, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFilePersistence } from "../src/persistence/file.ts";
import type { HarnessEventInput, HarnessSessionKey } from "../src/protocol.ts";

const roots: string[] = [];
const session: HarnessSessionKey = { tenantId: "tenant", actorId: "actor", threadId: "thread" };

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function directory(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "reins-file-"));
  roots.push(value);
  return value;
}

function event(index: number): HarnessEventInput {
  return {
    schemaVersion: 1,
    session,
    adapterId: "test",
    runId: "run",
    turnId: "turn",
    payload: { kind: "assistant-text", text: `chunk-${index}` },
  };
}

describe("file persistence", () => {
  test("persists ordered events and checkpoints across instances", async () => {
    const root = await directory();
    let id = 0;
    const first = createFilePersistence({
      directory: root,
      createId: () => `event-${++id}`,
      now: () => new Date("2026-09-17T12:00:00.000Z"),
    });
    const [one, two, three] = await Promise.all([
      first.events.append(event(1)),
      first.events.append(event(2)),
      first.events.append(event(3)),
    ]);
    expect([one.sequence, two.sequence, three.sequence].sort()).toEqual([1, 2, 3]);
    await first.sessions.save({
      key: session,
      adapterId: "test",
      checkpoint: { schemaVersion: 1, format: "test:resume@1", token: "secret-token" },
      sessionBinding: "account:a|policy:1",
      updatedAt: "2026-09-17T12:00:00.000Z",
    });

    const reopened = createFilePersistence({ directory: root });
    expect((await reopened.events.list(session, "test", 1)).map((value) => value.sequence)).toEqual([2, 3]);
    expect(await reopened.sessions.load(session, "test")).toEqual({
      key: session,
      adapterId: "test",
      checkpoint: { schemaVersion: 1, format: "test:resume@1", token: "secret-token" },
      sessionBinding: "account:a|policy:1",
      updatedAt: "2026-09-17T12:00:00.000Z",
    });

    await reopened.sessions.remove(session, "test");
    expect(await reopened.sessions.load(session, "test")).toBeNull();
  });

  test("creates private directories and regular private files", async () => {
    const root = await directory();
    const persistence = createFilePersistence({ directory: root });
    await persistence.events.append(event(1));
    await persistence.sessions.save({
      key: session,
      adapterId: "test",
      checkpoint: null,
      updatedAt: "2026-09-17T12:00:00.000Z",
    });

    if (process.platform !== "win32") {
      expect((await stat(root)).mode & 0o777).toBe(0o700);
      expect((await stat(join(root, "events"))).mode & 0o777).toBe(0o700);
      expect((await stat(join(root, "sessions"))).mode & 0o777).toBe(0o700);
      const eventName = (await readdir(join(root, "events")))[0]!;
      const sessionName = (await readdir(join(root, "sessions")))[0]!;
      expect((await stat(join(root, "events", eventName))).mode & 0o777).toBe(0o600);
      expect((await stat(join(root, "sessions", sessionName))).mode & 0o777).toBe(0o600);
    }
  });

  test("repairs only a torn final record and continues the sequence", async () => {
    const root = await directory();
    const persistence = createFilePersistence({ directory: root });
    await persistence.events.append(event(1));
    const eventName = (await readdir(join(root, "events")))[0]!;
    const path = join(root, "events", eventName);
    await appendFile(path, "{\"partial\":", "utf8");

    const reopened = createFilePersistence({ directory: root });
    const appended = await reopened.events.append(event(2));
    expect(appended.sequence).toBe(2);
    expect((await reopened.events.list(session, "test")).map((value) => value.sequence)).toEqual([1, 2]);
    expect((await readFile(path, "utf8")).endsWith("\n")).toBe(true);
  });

  test("fails closed on middle corruption, oversized state, and symlinks", async () => {
    const root = await directory();
    const persistence = createFilePersistence({ directory: root, maxEventBytes: 2_000, maxEventFileBytes: 4_000 });
    await persistence.events.append(event(1));
    const eventName = (await readdir(join(root, "events")))[0]!;
    const path = join(root, "events", eventName);
    await writeFile(path, "{}\n", "utf8");
    await expect(createFilePersistence({ directory: root }).events.list(session, "test"))
      .rejects.toThrow("corrupt");

    const smallRoot = await directory();
    const bounded = createFilePersistence({
      directory: smallRoot,
      maxEventBytes: 150,
      maxEventFileBytes: 150,
    });
    await expect(bounded.events.append(event(1))).rejects.toThrow("size limit");

    if (process.platform !== "win32") {
      const linkedRoot = await directory();
      const target = await directory();
      await rm(linkedRoot, { recursive: true, force: true });
      await symlink(target, linkedRoot);
      expect((await lstat(linkedRoot)).isSymbolicLink()).toBe(true);
      await expect(createFilePersistence({ directory: linkedRoot }).events.list(session, "test"))
        .rejects.toThrow("private directory");
    }
  });

  test("requires an explicit absolute directory and validates bounds", () => {
    expect(() => createFilePersistence({ directory: "relative" })).toThrow("absolute");
    expect(() => createFilePersistence({ directory: "/tmp/store", maxEventBytes: 10, maxEventFileBytes: 9 }))
      .toThrow("at least maxEventBytes");
  });
});
