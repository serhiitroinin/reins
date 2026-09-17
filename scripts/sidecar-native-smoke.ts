import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const store = await mkdtemp(join(tmpdir(), "fold-harness-sidecar-smoke-"));
try {
  const result = Bun.spawnSync([
    "cargo",
    "run",
    "--quiet",
    "--locked",
    "--manifest-path",
    "bindings/rust/Cargo.toml",
    "--example",
    "sidecar_client",
    "--",
    "node",
    resolve("dist/bin/fold-harness-sidecar.js"),
    "--host",
    resolve("test/fixtures/sidecar-host.mjs"),
    "--store",
    store,
  ], {
    cwd: resolve("."),
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) process.exit(result.exitCode);
} finally {
  await rm(store, { recursive: true, force: true });
}
