# ACP v1 compatibility

ACP is the Agent Client Protocol. Reins implements the
[stable ACP v1 specification](https://agentclientprotocol.com/protocol/v1/overview)
through `createAcpV1Adapter`.

ACP supplies a useful interoperable session and streaming surface. It does not
make engine authentication, process isolation, model catalogs, permission
semantics, or account quotas universal.

Read [the glossary](GLOSSARY.md) for every term used below.

The adapter uses the official
[`@agentclientprotocol/sdk`](https://github.com/agentclientprotocol/typescript-sdk)
internally. Its public API is SDK-free. A host injects a raw byte connection.
The host receives package-owned setup, negotiation, session-control,
permission, and presentation contracts.

## Ownership boundary

The adapter owns:

- stable-v1 initialize, `session/new`, and negotiated `session/load`;
- prompt streaming and terminal stop reasons;
- cancellation, bounded shutdown, and reconnection after transport exit;
- text, thinking, plan, tool, usage, and cost normalization;
- exact permission-option round trips and stale-answer rejection;
- checkpoint delivery and safe negotiated-capability projection.

The host owns:

- process or sidecar creation, environment allow-lists, credentials, and
  updates;
- workspace roots, filesystem, network, and shell policy, and sandbox claims;
- the MCP servers through which an agent reaches your tools;
- the mapping from ACP modes and config options to product controls;
- the model, profile, and limit discovery that ACP v1 does not provide;
- tool presentation and engine-error redaction before persistence;
- trusted context mapping.

The byte-stream boundary can wrap child-process pipes, a Unix socket, native
FFI, an embedded bridge, or a remote transport. The portable Reins wire schema
stays independent of that choice.

## Steering by replacement

ACP v1 defines no native active-prompt steer request. The adapter therefore
advertises `replacement-turn`.

Reins performs these steps in order:

1. Prepare the replacement context.
2. Cancel the current ACP prompt and drain it, including pending permissions.
3. Seal the terminal event of the old turn.
4. Retire that transport.
5. Reload the session into a new runtime turn.

This strategy carries the constraint `requiresAgentCapability: "loadSession"`.
A peer without `session/load` cannot safely replace an active prompt. An ACP
update carries session identity, but it carries no prompt identity.

Host-side waiting stays available through the separate turn queue.

## Engine differences stay explicit

### Modes

An ACP mode describes the session behavior of one agent. It is not equivalent
to a Reins permission mode.

The engine profile remains the place where a host explains an actual security
posture and any versioned consent.

### Config options

An ACP config option is a live session control. It is not a durable model
catalog.

The adapter exposes open ids, categories, values, and the current selection
through `configureSession`. A host can therefore map Claude effort, Codex
reasoning, Codex Fast, an OpenCode model group, or a future control. The core
needs no new engine enum.

The independent `models()` API stays responsible for a pre-session model
picker.

### Usage and limits

ACP usage updates are normalized into turn events when the agent supplies them.

ACP v1 does not standardize account rate windows, credits, or subscription
limits. `limits()` therefore stays independently injected. It may report
`unsupported`.

### Permissions

A permission request preserves the exact options that the agent offered. A host
can select one immediately, or defer it to a product interaction.

The adapter refuses an invented choice and a stale choice. It seals outstanding
permission state and tool state on cancel and on terminal completion.

## Context and tool safety

The default prompt mapper works only when no prepared context exists. An ACP
prompt block carries no trusted system role or instruction role. Flattening a
trusted instruction and untrusted domain data into one user prompt would erase
a security boundary.

A host that uses context must supply an explicit `mapPrompt`. Make it
appropriate to your agent and your policy.

Raw ACP tool input, output, locations, content, and engine error messages are
not persisted by default. A host may return a bounded safe presentation or an
explicit public error. An unknown engine value stays private.

The generic client advertises no filesystem callback and no terminal callback.
Supply tools as host-owned MCP servers, after the agent negotiates the required
transport.

A working directory is policy input. It is not confinement.

## The OpenCode composition recipe

`createOpenCodeAcpAdapter` delegates the whole lifecycle to
`createAcpV1Adapter`. It contributes only the measured OpenCode session-control
mapping.

It applies three selections in this order:

1. An exact selected model.
2. An exact model effort, when one is advertised.
3. A fixed host-defined OpenCode mode.

Current OpenCode exposes these as `model`, `effort` (`thought_level`), and
`mode`. An older compatible ACP revision may expose the mode through the
protocol mode method.

A missing control or a missing value fails closed. The helper never falls back
to a different model or to a different agent.

The helper requires a host-supplied engine profile and mode id. It does not
launch OpenCode, generate configuration, deny native tools, copy credentials,
discover models, or claim a sandbox.

An OpenCode mode describes agent behavior. It is not a portable permission
level. Describe only the process posture that you actually enforce. Retain all
process, environment, filesystem, network, native-tool, MCP, credential, and
context-mapping policy.

## Measured compatibility

The live runner uses a synthetic workspace, an environment allow-list, redacted
stderr diagnostics, three turns, and a fresh-process resume. An explicit
host-owned account location supplies authentication.

The measurements below were made on 2026-09-15.

| Agent | Version | Load | Image | Extra roots | MCP | Session controls observed | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Claude Agent ACP | 0.77.0 | yes | yes | yes | stdio, HTTP, SSE | mode, model, effort | 3 turns and a fresh-process resume passed |
| Codex ACP | 1.11.0 | yes | yes | yes | stdio, HTTP | mode, collaboration mode, model, reasoning effort, Fast | 3 turns and a fresh-process resume passed; `fast-mode=on` passed |
| OpenCode | 1.18.20 | yes | yes | no | stdio, HTTP, SSE | model, mode | 3 turns and a fresh-process resume passed |
| Grok CLI ACP | not installed | unverified | unverified | unverified | unverified | unverified | Experimental candidate. No local binary and no XAI credential were available. |

Two authentication findings matter:

- Claude keychain authentication on macOS required the host launch environment
  to retain the login `HOME` and `USER`. Copying a config file into an isolated
  home correctly appeared signed out.
- OpenCode was verified with a copied auth file at mode `0600`, inside isolated
  XDG directories.

Every temporary credential copy was removed immediately after the run.

## Reproduce the measurements

The runner stays outside CI on purpose. It uses real engine accounts.

```bash
ACP_SMOKE_HOME="$HOME" bun run smoke:acp -- --provider claude
bun run smoke:acp -- --provider codex
bun run smoke:acp -- --provider opencode
ACP_SMOKE_CONFIG_JSON='{"fast-mode":"on"}' bun run smoke:acp -- --provider codex
```

The OpenCode path uses the public composition helper with the stock `build`
mode. It verifies protocol and session-control compatibility only. It makes no
claim about the native-tool policy of a production host.

The Claude and Codex npm commands are pinned in `scripts/acp-live-smoke.ts`.
OpenCode uses the locally installed binary. The ACP handshake reports its
version.

[The official Grok repository](https://github.com/xai-org/grok-build) documents
`grok agent stdio`. Grok stays experimental until its command, authentication,
cancellation, repeated turns, and fresh-process resume are measured locally.

## Why the native adapters stay

Keep the native Claude Code and Codex adapters. They expose important behavior
that sits outside the common ACP surface:

- richer account-limit data;
- exact engine security controls;
- Claude subagents and compaction;
- Codex service-tier and model metadata;
- engine-specific lifecycle details that hosts already use.

Use ACP v1 for two purposes:

1. As the generic route for OpenCode and future agents. The thin OpenCode
   composition recipe helps here.
2. As an optional portable route for a Claude Code or Codex product that
   prefers interoperability over those extra features.

Revisit the split when a stable ACP revision covers the missing discovery and
lifecycle semantics. Do not emulate an absent feature in the core.
