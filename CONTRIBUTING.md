# Contributing

Thank you for helping with Reins. Please read the
[code of conduct](CODE_OF_CONDUCT.md) first. Report security problems through
the process in [SECURITY.md](SECURITY.md), not in a public issue.

## Prerequisites

- [Bun](https://bun.sh) 1.2 or newer. Bun installs dependencies and runs the
  tests, scripts, and examples.
- Node.js 20 or newer with npm. The packaging checks use `npm pack`.
- Optional: a stable Rust toolchain for the Rust binding tests.
- Optional, macOS or Linux with Swift 5.9 or newer: the Swift binding tests.

CI runs the Rust and Swift binding tests on every pull request, so you can skip
them locally when you do not have those toolchains.

## Commands

```sh
bun install
bun run check            # types, bindings, public API, docs, tests, build
bun run example          # offline example
bun run smoke:consumer   # install the packed tarball in a clean project
npm pack --dry-run
```

Optional binding tests:

```sh
cargo test --locked --manifest-path bindings/rust/Cargo.toml
swift test --package-path bindings/swift
```

`bun run smoke:consumer` also builds the Rust example when `cargo` is present.
Live Claude Code and Codex tests use local provider accounts and are opt-in.
See [live provider tests](docs/getting-started/live-tests.md).

## Generated files

Do not edit these files by hand:

- `bindings/rust/src/lib.rs` and `bindings/swift/Sources/ReinsV1/ReinsV1.swift`.
  Run `bun run generate:bindings` after a schema change, and keep the golden
  fixture current.
- `api/public-api.json`. Run `bun run generate:public-api` after a public
  export change.

## Boundaries

- Keep provider identifiers open and negotiate optional behavior through
  capabilities.
- Do not expose provider SDK types from the protocol or runtime.
- Keep UI frameworks, product domains, database drivers, credentials, and
  provider account discovery out of the core package. The package must remain
  independent of host product concepts.
- The runtime is not a sandbox. Adapters and host documentation must describe
  filesystem, network, shell, authentication, and approval behavior exactly.
- Never inherit a host application's complete environment in an adapter.
- Never put credentials, prompts, tool results, or raw provider errors in
  diagnostics unless an explicit redaction contract covers them.
- Core events evolve additively. Unknown namespaced extensions must remain
  retainable or safely ignorable.
- The runtime owns terminal events and seals a run after completion.
- Provider execution approval and application transaction confirmation are
  different interactions. Do not collapse them into one policy decision.

## Changes

- Use atomic [Conventional Commits](https://www.conventionalcommits.org).
- Add tests for every public behavior change.
- Update `docs/ARCHITECTURE.md` when a boundary moves.
- Add a Changeset (`bun run changeset`) for every public API or behavior
  change.
- A provider adapter must pass the conformance suite before the documentation
  lists it as supported.
- Run `bun run check` before you open a pull request.
