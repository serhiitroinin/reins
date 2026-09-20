# ACP v1 compatibility

Reins implements the
[stable Agent Client Protocol v1](https://agentclientprotocol.com/protocol/v1/overview)
through `createAcpV1Adapter`. ACP supplies a useful interoperable session and
streaming surface. It does not make provider authentication, process isolation,
model catalogs, permission semantics, or account quotas universal.

The adapter uses the official
[`@agentclientprotocol/sdk`](https://github.com/agentclientprotocol/typescript-sdk)
internally. Its public API is SDK-free: a host injects a raw byte connection and
receives package-owned setup, negotiation, session-control, permission, and
presentation contracts.

## Ownership boundary

The adapter owns:

- stable-v1 initialize, `session/new`, and negotiated `session/load`;
- prompt streaming and terminal stop reasons;
- cancellation, bounded shutdown, and reconnect after transport exit;
- text, thinking, plan, tool, usage, and cost normalization;
- exact permission-option round trips and stale-answer rejection;
- checkpoint delivery and safe negotiated-capability projection.

ACP v1 does not define a native active-prompt steer request. The adapter
therefore advertises `replacement-turn`: Reins prepares the replacement
context, cancels and drains the current ACP prompt (including pending
permissions), seals its terminal event, retires that transport, and then
reloads the session into a new runtime turn. This strategy therefore carries
the `requiresAgentCapability: "loadSession"` constraint; a peer without
`session/load` cannot safely replace an active prompt because ACP updates have
session identity but no prompt identity.
Host-side waiting remains available through the separate turn queue.

The host owns:

- process or sidecar creation, environment allowlists, credentials, and updates;
- workspace roots, filesystem/network/shell policy, and sandbox claims;
- the MCP servers through which an agent reaches application tools;
- mapping ACP modes and config options to product controls;
- model/profile/limit discovery that ACP v1 does not provide;
- tool presentation and provider-error redaction before persistence;
- trusted application-context mapping.

The byte-stream boundary can wrap child-process pipes, Unix sockets, native FFI,
an embedded bridge, or a remote transport. The portable Reins wire schema
remains independent of that choice.

## OpenCode composition recipe

`createOpenCodeAcpAdapter` delegates the entire lifecycle to
`createAcpV1Adapter`. It contributes only the measured OpenCode session-control
mapping: an exact selected model, then an exact model effort when one is
advertised, then a fixed host-defined OpenCode mode. Current OpenCode exposes
these as `model`, `effort` (`thought_level`), and `mode`; older compatible ACP
revisions may expose mode through the protocol's mode method. Missing controls
or values fail closed rather than falling back to a different model or agent.

The helper deliberately requires a host-supplied engine profile and mode id.
It does not spawn OpenCode, generate configuration, deny native tools, copy
credentials, discover models, or claim a sandbox. An OpenCode mode describes
agent behavior, not a portable permission level. The host must describe only
the process posture it actually enforces and retain all process, environment,
filesystem, network, native-tool, MCP, credential, and context-mapping policy.

## Provider differences remain explicit

ACP modes describe an agent's session behavior. They are not assumed to be
equivalent to a Reins permission mode. The engine profile remains the
place for a host to explain an actual security posture and any versioned consent.

ACP config options are live session controls, not a durable model catalog. The
adapter exposes their open ids, categories, values, and current selection through
`configureSession`. A host can therefore map Claude effort, Codex reasoning,
Codex Fast, OpenCode model groups, or future Grok/OpenCode controls without adding
a provider enum to core. The independent `models()` API remains responsible for
a product's pre-session model picker.

ACP usage updates are normalized into turn events when supplied. Account rate
windows, credits, and subscription limits are not standardized by ACP v1, so
`limits()` remains independently injected and may report `unsupported`.

Permission requests preserve the exact options offered by the agent. A host can
select one immediately or defer it to a product interaction. The adapter refuses
invented or stale choices and seals outstanding permission and tool state on
cancel or terminal completion.

## Context and tool safety

The default prompt mapper works only when no prepared application context exists.
ACP prompt blocks do not carry a trusted system/instruction role, so flattening a
trusted instruction and untrusted domain data into one user prompt would erase a
security boundary. A context-using product must provide an explicit `mapPrompt`
appropriate to its agent and policy.

Raw ACP tool input, output, locations, content, and provider error messages are
not persisted by default. A host may return a bounded safe presentation or an
explicit public error. Unknown provider values stay private.

The generic client advertises no filesystem or terminal callbacks. Application
tools are supplied as host-owned MCP servers after the agent negotiates the
required transport. A working directory is policy input, not confinement.

## Measured compatibility

The live runner uses a synthetic workspace, an environment allowlist, redacted
stderr diagnostics, three turns, and a fresh-process resume. Authentication is
provided by an explicit host-owned account location. Measurements below were made
on 2026-09-15.

| Agent | Version | Load | Image | Extra roots | MCP | Session controls observed | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Claude Agent ACP | 0.77.0 | yes | yes | yes | stdio, HTTP, SSE | mode, model, effort | 3 turns + fresh-process resume passed |
| Codex ACP | 1.11.0 | yes | yes | yes | stdio, HTTP | mode, collaboration mode, model, reasoning effort, Fast | 3 turns + fresh-process resume passed; `fast-mode=on` passed |
| OpenCode | 1.18.20 | yes | yes | no | stdio, HTTP, SSE | model, mode | 3 turns + fresh-process resume passed |
| Grok CLI ACP | not installed | unverified | unverified | unverified | unverified | unverified | experimental candidate; no local binary or XAI credential was available |

Claude's macOS keychain authentication additionally required the host launch
environment to retain the login `HOME` and `USER`; copying a config file into an
isolated home correctly appeared logged out. OpenCode was verified with a copied
mode-`0600` auth file in isolated XDG directories. Temporary credential copies
were removed immediately after the run.

The reproducible runner is intentionally outside CI because it uses real provider
accounts:

```bash
ACP_SMOKE_HOME="$HOME" bun run smoke:acp -- --provider claude
bun run smoke:acp -- --provider codex
bun run smoke:acp -- --provider opencode
ACP_SMOKE_CONFIG_JSON='{"fast-mode":"on"}' bun run smoke:acp -- --provider codex
```

The OpenCode path uses the public composition helper with the stock `build`
mode only to verify protocol/session-control compatibility. It does not claim
that the smoke process has a production host's native-tool policy.

The Claude and Codex npm commands are pinned in `scripts/acp-live-smoke.ts`;
OpenCode uses the locally installed binary whose version is reported by the ACP
handshake. [Grok's official repository](https://github.com/xai-org/grok-build)
documents `grok agent stdio`, but Grok remains experimental until its command,
authentication, cancellation, repeated turns, and fresh-process resume are
measured locally.

## Native adapter decision

Keep the native Claude and Codex adapters. Today they expose important behavior
outside the ACP common surface: richer account-limit data, exact provider
security controls, Claude subagents and compaction, Codex service-tier/model
metadata, and provider-specific lifecycle details that host applications already use.

Use ACP v1, with the thin OpenCode composition recipe where useful, as the
generic route for OpenCode and future agents, and as an optional
portable route for Claude/Codex products that prefer interoperability over those
enhancements. Revisit the split when stable ACP revisions cover the missing
discovery and lifecycle semantics; do not emulate absent features in core.
