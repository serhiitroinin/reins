# Frequently asked questions

This page answers the questions that new hosts ask first. Read
[the glossary](../GLOSSARY.md) for every term.

## Authentication

### Does Reins handle my API key?

No. Reins handles no credential of any kind.

An engine authenticates the same way its own command-line tool authenticates.
Claude Code reads the login in `~/.claude`. Codex reads the login in
`~/.codex`. The person who uses your product signs in with that tool once.

### Then what does my host pass to Reins?

Your host passes a process launch decision. You choose the executable, the
arguments, the working directory, and the exact environment. The engine reads
its own account from the home directory that your environment names.

No credential enters a run request, an event, a checkpoint, a diagnostic, or a
sidecar command. See [the security boundary](../ARCHITECTURE.md#security-boundary).

### Can I use an API key instead of a signed-in account?

Yes, when the engine supports it. Set the key in the exact environment that you
build for the engine process. Reins never reads it.

An API-key account often reports no plan limits. `limits()` then returns
`unsupported`. That is a correct answer, not a failure.

### Can I run two accounts at once?

Yes. Give each account its own environment and its own private home directory.
Limit snapshots are account-scoped, so one login never shows the quota of
another login.

## Cost

### What does Reins cost?

Nothing. Reins is an MIT-licensed npm package.

### What does a turn cost?

A turn costs whatever the engine account charges. A subscription turn spends
the plan allowance. An API-key turn spends credits. Reins adds no fee and no
network hop.

### How do I develop without spending anything?

Use the scripted adapter from `reins/testing`. It needs no account and no
network access. It is deterministic, so it also suits tests.

Keep it out of a release build. It is test-only API. See
[API stability](../API_STABILITY.md).

### How do I show usage and remaining quota?

Read two different things:

| Question | Source |
| --- | --- |
| What did this turn use? | The `usage` events of the turn |
| What is left on the account? | `limits()` |

Query `limits()` again after every turn. A turn spends the allowance.

## Provider neutrality

### What does "provider-neutral" cover?

It covers the shape of the work. Every engine reaches your host through the
same contract:

- one run and turn identity model;
- one append-only event stream;
- one tool boundary;
- one interaction model;
- one cancellation and steering model;
- one resume checkpoint model;
- one JSON Schema, and one set of generated Rust and Swift types.

You can therefore change engine without rewriting your product.

### What does "provider-neutral" not cover?

It does not make engines equal. These differences stay real, and Reins reports
them instead of hiding them:

| Difference | How you learn about it |
| --- | --- |
| Features an engine lacks | Capability data. An absent feature reports `unsupported`. |
| Permission vocabulary | The engine profile. A Claude approval policy is not a Codex sandbox mode. |
| Model names and effort options | The model catalog, read live. |
| Quota and credit shape | Limit snapshots, which may be `unsupported`. |
| Engine-only activity | Namespaced extension events. |

Reins never invents a value to fill a gap. It never emulates a missing feature.

### Does neutrality mean the same prompt gives the same result?

No. Engines differ in behavior. Reins standardizes the plumbing around the
engine, not the engine.

### Can I add an engine that Reins does not ship?

Yes. Write an adapter. Engine identifiers are open strings, so the core needs
no change. The adapter must pass the conformance suite before the
documentation lists it as supported. See [CONTRIBUTING.md](../../CONTRIBUTING.md).

## Security

### Is Reins a sandbox?

No. Reins is not an operating-system sandbox, and a capability grants no
authority.

Your host decides whether a tool or a subprocess may reach the filesystem or
the network. Your host builds the environment, the working directory, and the
approval rules.

### Does `cwd` confine the engine?

No. `cwd` places relative paths. It confines nothing.

### Does a permission callback prove that approval happened?

No. Claude may execute a call that its effective policy already allows, without
invoking the callback. A product that promises approval must install the
matching ask rules and deny rules. It must then verify them independently,
after administrator policy resolves.

## Platforms

### Which operating systems work?

| System | Status |
| --- | --- |
| macOS | Supported. Continuous integration runs on macOS. |
| Linux | Supported. Continuous integration runs on Ubuntu. |
| Windows | Untested. See below. |

### What is the Windows status?

The Node.js API has no known Windows-specific code. The packaged file store
does. It sets Unix directory mode `0700` and file mode `0600`, and it refuses
symlinks and non-regular paths.

Continuous integration does not run on Windows. Treat Windows as untested.

Two routes work today on Windows:

1. Supply your own `HarnessPersistence` implementation instead of the packaged
   file store.
2. Run the sidecar and the engines under the Windows Subsystem for Linux.

Engine support on Windows is a separate question. Check the documentation of
Claude Code and of Codex.

### Which Node.js version do I need?

Node.js 20 or newer. Development of the repository also needs Bun 1.2 or
newer. A consumer of the npm package needs only Node.js.

### Can my host be a Swift or Rust application?

Yes. Use the sidecar. It speaks JSON-RPC 2.0 over standard input and standard
output. The package ships generated Swift and Rust data types.

Read the [sidecar quickstart](../getting-started/sidecar.md) and the
[Rust sidecar example](../getting-started/rust.md).

## Scope

### Does Reins include a user interface?

No. Reins ships no React component, no HTTP server, and no database driver.
Your host owns presentation and storage. Read the [roadmap](../ROADMAP.md) for
the complete list of choices that stay outside the package.

### Is version 0.1 stable?

Yes. Version 0.1 starts the supported public API. A stable change is additive.
Read [API stability](../API_STABILITY.md) for the exact promise.

### Where do I start?

1. Run the [Node quickstart](../getting-started/node.md).
2. Read [build your own app on Reins](build-an-app.md).
3. Read the [architecture](../ARCHITECTURE.md).
