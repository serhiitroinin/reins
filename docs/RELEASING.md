# Release procedure

Use this checklist for every npm release of `reins`.

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

The workflow checks out the tag, runs `bun run check`, confirms that the tag
matches the package version, publishes with `--provenance`, and creates the
GitHub release. A version with a prerelease suffix is published under the
matching dist-tag (`next` for `0.3.0-next.1`), not under `latest`.

The workflow needs all of these conditions:

- The GitHub repository is public. npm rejects provenance from a private
  repository.
- The repository name matches `repository.url` in `package.json`
  (`serhiitroinin/reins`).
- The `reins` package on npmjs.com has a trusted publisher: repository
  `serhiitroinin/reins`, workflow `release.yml`, environment `npm`.
- The repository has an `npm` environment.

npm can add a trusted publisher only to a package that exists. Therefore the
first `reins` version uses the manual fallback.

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

- `npm view reins dist-tags` shows the new version under the expected tag.
- The registry integrity matches the reviewed tarball.
- After a workflow publish, the npm page shows the provenance statement.
- The GitHub release exists and is not a draft.

Then remove merged temporary branches.

## First release of `reins` (0.2.0)

Versions up to 0.1.1 were published as `@serhiitroinin/fold-harness`. Version
0.2.0 continues that line under the new name. Do these steps once, in order.

1. Merge the rename branch into `main`.
2. Rename the GitHub repository to `reins` and make it public. GitHub
   redirects the old URL. Update the local remote:
   `git remote set-url origin git@github.com:serhiitroinin/reins.git`.
3. Confirm that the name is still free:
   `npm view reins` must return a 404 error.
4. Do sections 1 to 4. `bun run version-packages` must produce version 0.2.0.
   After it runs, move the "Versions up to 0.1.1 were published as" line in
   `CHANGELOG.md` back to the top of the file, under the title.
5. Publish 0.2.0 with the manual fallback. npm can reject a new unscoped name
   that is too similar to an existing package. When that happens, stop. Do not
   publish under another name without a new decision.
6. On npmjs.com, open the `reins` package settings and add the trusted
   publisher from section 5. Create the `npm` environment in the GitHub
   repository settings. Later releases use the workflow.
7. Do section 6.

## Retire `@serhiitroinin/fold-harness`

Do these steps after `reins@0.2.0` is on the registry.

1. Create a branch from the last release of the old package:

   ```sh
   git switch -c release/fold-harness-0.1.2 v0.1.1
   ```

2. Replace the content of `README.md` with a rename notice:

   ```md
   # @serhiitroinin/fold-harness

   This package was renamed to [`reins`](https://www.npmjs.com/package/reins).
   Install `reins` instead:

       npm install reins

   Version 0.1.2 contains the same code as version 0.1.1. It receives no
   further updates. The rename changes identifiers; read the `reins` 0.2.0
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
