# Release procedure

Use this checklist for every npm release of `@serhiitroinin/reins`.

The release workflow (`.github/workflows/release.yml`) publishes from GitHub
Actions with npm trusted publishing (OIDC) and a provenance statement. A manual
publish from a maintainer machine is the fallback. A manual publish cannot
carry provenance.

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

Run the opt-in engine matrix when adapter behavior changes:

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
and complete diff. Commit the release as one Conventional Commit
(`chore(release): <version>`). Merge the commit into `main`.

## 4. Tag

Tag the merged `main` commit and push the tag:

```sh
git tag v<version>
git push origin v<version>
```

## 5. Publish

### With the release workflow

Run the `Release` workflow and give it the tag:

```sh
gh workflow run release.yml -f tag=v<version>
```

The workflow does four things:

1. Check out the tag.
2. Run `bun run check` and confirm that the tag matches the package version.
3. Publish with `--provenance`.
4. Create the GitHub release. A version with a prerelease suffix is published under the
matching dist-tag (`next` for `0.3.0-next.1`), not under `latest`.

The workflow needs all of these conditions:

- The GitHub repository is public. npm rejects provenance from a private
  repository.
- The repository name matches `repository.url` in `package.json`
  (`serhiitroinin/reins`).
- The `@serhiitroinin/reins` package on npmjs.com has a trusted publisher: repository
  `serhiitroinin/reins`, workflow `release.yml`, environment `npm`.
- The repository has an `npm` environment.

npm can add a trusted publisher only to a package that exists. Therefore the
first `@serhiitroinin/reins` version uses the manual fallback.

### Manual fallback

Publish the exact tagged commit from a clean checkout:

```sh
git switch --detach v<version>
bun install --frozen-lockfile
npm publish --access public --tag latest --provenance=false
gh release create v<version> --generate-notes --verify-tag
```

npm can require browser authentication and a passkey. Use the prerelease
dist-tag instead of `latest` for a prerelease version.

## 6. Verify

Use a fresh npm cache and a temporary project. Install the exact version from
the public registry. Verify the main Node import and the installed
`reins-sidecar` command.

Confirm all of these facts:

- `npm view @serhiitroinin/reins dist-tags` shows the new version under the expected tag.
- The registry integrity matches the reviewed tarball.
- After a workflow publish, the npm page shows the provenance statement.
- The GitHub release exists and is not a draft.

Then remove merged temporary branches.

## First release of Reins (0.2.1)

Versions up to 0.1.1 were published as `@serhiitroinin/fold-harness`. The
0.2.0 release renamed the project to Reins, but npm rejected the unscoped name
`reins` as too similar to `redis`. Version 0.2.0 was never published. Version
0.2.1 is the first release on npm, under the scoped name
`@serhiitroinin/reins`. The brand, the sidecar executable `reins-sidecar`, the
tool server name `reins`, and the `ReinsV1` bindings keep the short name.

1. Do sections 1 to 4. `bun run version-packages` must produce version 0.2.1.
2. Publish 0.2.1 with the manual fallback.
3. On npmjs.com, open the `@serhiitroinin/reins` package settings and add the
   trusted publisher from section 1. Create the `npm` environment in the
   GitHub repository settings. Later releases use the workflow.
4. Do section 6.

## Retire `@serhiitroinin/fold-harness`

Do these steps after `@serhiitroinin/reins@0.2.1` is on the registry.

1. Create a branch from the last release of the old package:

   ```sh
   git switch -c release/fold-harness-0.1.2 v0.1.1
   ```

2. Replace the content of `README.md` with a rename notice:

   ```md
   # @serhiitroinin/fold-harness

   This package was renamed to [`@serhiitroinin/reins`](https://www.npmjs.com/package/@serhiitroinin/reins).
   Install `@serhiitroinin/reins` instead:

       npm install @serhiitroinin/reins

   Version 0.1.2 contains the same code as version 0.1.1. It receives no
   further updates. The rename changes identifiers; read the Reins 0.2.0
   changelog before you migrate.
   ```

3. Set `"version": "0.1.2"` in `package.json`. Add a `0.1.2` entry to
   `CHANGELOG.md` that states the rename. Commit the change as
   `chore(release): 0.1.2`.
4. Run `bun install --frozen-lockfile` and `bun run check`.
5. Publish manually. The `.npmrc` file at that tag enables provenance, so the
   flag is required:

   ```sh
   npm publish --access public --tag latest --provenance=false
   ```

6. Tag the commit as `fold-harness-v0.1.2` and push the tag. Do not merge the
   branch into `main`.
7. Deprecate every version of the old package:

   ```sh
   npm deprecate "@serhiitroinin/fold-harness@*" "Renamed to reins. Install reins instead."
   ```

8. Confirm the result: `npm view @serhiitroinin/fold-harness deprecated`.
