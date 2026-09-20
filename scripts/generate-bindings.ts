import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const checking = process.argv.includes("--check");
const temporary = await mkdtemp(join(tmpdir(), "reins-bindings-"));

const common = [
  "--src-lang", "schema",
  "--src", join(root, "scripts/bindings-v1.schema.json"),
  "--additional-schema", join(root, "schema/v1/protocol.schema.json"),
  "--additional-schema", join(root, "schema/v1/discovery.schema.json"),
  "--additional-schema", join(root, "schema/v1/sidecar.schema.json"),
  "--top-level", "V1",
  "--no-date-times",
  "--alphabetize-properties",
  "--telemetry", "disable",
];

const targets = [
  {
    output: join(root, "bindings/swift/Sources/ReinsV1/ReinsV1.swift"),
    temporary: join(temporary, "ReinsV1.swift"),
    arguments: [
      "--lang", "swift",
      "--access-level", "public",
      "--struct-or-class", "struct",
      "--type-prefix", "FH",
      "--support-linux",
      "--no-initializers",
    ],
  },
  {
    output: join(root, "bindings/rust/src/lib.rs"),
    temporary: join(temporary, "lib.rs"),
    arguments: [
      "--lang", "rust",
      "--visibility", "public",
      "--derive-partial-eq",
      "--skip-serializing-none",
      "--no-leading-comments",
    ],
  },
] as const;

try {
  for (const target of targets) {
    const process = Bun.spawnSync({
      cmd: [join(root, "node_modules/.bin/quicktype"), ...common, ...target.arguments, "--out", target.temporary],
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (process.exitCode !== 0) {
      throw new Error(new TextDecoder().decode(process.stderr).trim() || "quicktype failed");
    }
    const generated = await readFile(target.temporary);
    if (checking) {
      let current: Uint8Array;
      try {
        current = await readFile(target.output);
      } catch {
        throw new Error(`generated binding is missing: ${target.output}`);
      }
      if (!generated.equals(current)) throw new Error(`generated binding is stale: ${target.output}`);
    } else {
      await mkdir(dirname(target.output), { recursive: true });
      await writeFile(target.output, generated);
    }
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
