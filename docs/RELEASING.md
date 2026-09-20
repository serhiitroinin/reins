# Release procedure

Use this checklist for every npm release.

## 1. Prepare

1. Start from a clean branch based on the current `main` branch.
2. Confirm that each public change has a Changeset.
3. Confirm that documentation describes the current behavior.

## 2. Validate

Run these commands locally:

```sh
bun install --frozen-lockfile
bun run check
bun run smoke:consumer
npm pack --dry-run
cargo test --locked --manifest-path bindings/rust/Cargo.toml
swift test --package-path bindings/swift
```

Run the opt-in provider matrix when adapter behavior changes:

```sh
REINS_LIVE=1 bun run smoke:native -- --provider claude
REINS_LIVE=1 bun run smoke:native -- --provider codex
```

Do not publish when a required local check fails.

## 3. Version

Run the Changesets version command:

```sh
bun run version-packages
```

Review the package version, changelog, consumed Changesets, generated files,
and complete diff. Commit the release as one Conventional Commit.

## 4. Publish

Publish the exact reviewed commit:

```sh
npm publish --access public --tag latest --provenance=false
```

npm can require browser authentication and a passkey. Wait until the registry
reports the new version before you create a consumer lockfile.

## 5. Verify

Use a fresh npm cache and a temporary project. Install the exact version from
the public registry. Verify the main Node import and the installed
`reins-sidecar` command.

Confirm all of these facts:

- `latest` points to the new stable version.
- The npm package access is `public`.
- The registry integrity matches the reviewed tarball.

## 6. Tag and integrate

1. Tag the merged `main` commit as `v<version>`.
2. Push the tag.
3. Create a non-draft, non-prerelease GitHub release.
4. Remove merged temporary branches.
