# Live engine tests

The native live test uses a real local Claude Code or Codex account. It is not
part of `bun run check`. You must opt in.

```sh
REINS_LIVE=1 bun run smoke:native -- --provider claude
REINS_LIVE=1 bun run smoke:native -- --provider codex
```

The test covers a fresh turn, application tools, and resume after a host
restart. It also covers same-turn steering, cancellation, checkpoints, and live
model and limit discovery. The summary prints the discovered model catalog and the limit
snapshot before and after the turns.
The Claude run also covers a permission interaction. The Codex run also uses
the Fast control.

By default, the test reads the login account in `~/.claude` or copies only
`~/.codex/auth.json` into a temporary private home. It removes the temporary
workspace and Codex home when it ends.

Use another account directory with these variables:

```sh
REINS_LIVE_CLAUDE_CONFIG_DIR=/private/claude-account
REINS_LIVE_CODEX_HOME=/private/codex-account
```

The Claude test uses the stable `sonnet` alias by default. Codex uses the
account default model. Set `REINS_LIVE_MODEL` to test another model.
Use `REINS_LIVE_KEEP=1` only when you need to inspect the temporary
files.

The test does not enable engine shell or filesystem tools. It uses only the
three application tools that the script defines.
