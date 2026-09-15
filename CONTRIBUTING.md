# Contributing

Use Bun for dependency installation and tests. Run `bun run check` before
opening a pull request.

Schema changes must also keep the generated native bindings and their golden
fixture current:

```bash
bun run generate:bindings
cargo test --locked --manifest-path bindings/rust/Cargo.toml
swift test --package-path bindings/swift
```

Commits follow Conventional Commits. Keep changes atomic and include tests for
every public behavior change. Public API changes require a Changeset.

The package must remain independent of Fold product concepts, UI frameworks,
database implementations, and provider SDK types.
