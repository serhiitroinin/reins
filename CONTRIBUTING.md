# Contributing

Thank you for helping with Reins.

Read the [code of conduct](CODE_OF_CONDUCT.md) first. Report a security problem
through the process in [SECURITY.md](SECURITY.md). Do not open a public issue
for it.

Read [the glossary](docs/GLOSSARY.md) before you write documentation or a
commit message. It defines the term for each concept.

## Prerequisites

| Tool | Version | Needed for |
| --- | --- | --- |
| [Bun](https://bun.sh) | 1.2 or newer | Dependencies, tests, scripts, examples |
| Node.js and npm | 20 or newer | The packaging checks, which use `npm pack` |
| Rust toolchain | stable | Optional. The Rust binding tests. |
| Swift | 5.9 or newer, on macOS or Linux | Optional. The Swift binding tests. |

CI runs the Rust and Swift binding tests on every pull request. You may skip
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

Live Claude Code and Codex tests use a local engine account. They are opt-in.
See [live engine tests](docs/getting-started/live-tests.md).

## Generated files

Do not edit these files by hand.

| File | Regenerate with |
| --- | --- |
| `bindings/rust/src/lib.rs` | `bun run generate:bindings` |
| `bindings/swift/Sources/ReinsV1/ReinsV1.swift` | `bun run generate:bindings` |
| `api/public-api.json` | `bun run generate:public-api` |

Run `bun run generate:bindings` after a schema change. Keep the golden fixture
current. Run `bun run generate:public-api` after a change to a public export.

## Boundaries

Keep the core engine-neutral:

- Keep engine identifiers open. Negotiate optional behavior through
  capabilities.
- Do not expose an engine SDK type from the protocol or the runtime.
- Keep UI frameworks, product domains, database drivers, credentials, and
  engine account discovery out of the core package.

Keep the security contract honest:

- The runtime is not a sandbox. An adapter and its documentation must describe
  filesystem, network, shell, authentication, and approval behavior exactly.
- Never inherit the complete environment of a host application in an adapter.
- Never put a credential, a prompt, a tool result, or a raw engine error in a
  diagnostic. An explicit redaction contract is the only exception.

Keep the event model stable:

- Core events evolve additively.
- An unknown namespaced extension must stay retainable or safely ignorable.
- The runtime owns terminal events. It seals a run after completion.

Keep the two consent boundaries apart:

- Engine execution approval and product transaction confirmation are different
  interactions. Do not collapse them into one policy decision.

## Documentation style

Write documentation in Simplified Technical English:

1. Use one term per concept. Take the term from [the
   glossary](docs/GLOSSARY.md).
2. Keep a sentence under about 20 words.
3. Write one instruction per sentence in a procedure. Use the imperative mood.
4. Use the active voice and the present tense.
5. Turn parallel items into a list or a table.
6. Define an abbreviation on its first use in a document.
7. Use American spelling.
8. Do not write "simply", "just", or "easily".

Add a new term to the glossary when you introduce a new concept.

## Changes

- Use atomic [Conventional Commits](https://www.conventionalcommits.org).
- Add a test for every public behavior change.
- Update `docs/ARCHITECTURE.md` and its appendices when a boundary moves.
- Add a Changeset with `bun run changeset` for every public API change and
  every behavior change.
- A new engine adapter must pass the conformance suite before the
  documentation lists it as supported.
- Run `bun run check` before you open a pull request.
