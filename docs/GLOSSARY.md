# Glossary

The Reins documentation uses one term for each concept. This page defines
every term. Use these words in issues, pull requests, and new documents.

## Core terms

| Term | Definition |
| --- | --- |
| host | Your product code that embeds Reins. The host owns credentials, process launch, policy, domain data, and the user interface. |
| engine | The agent system that Reins drives. Claude Code, Codex, and an ACP agent are engines. |
| adapter | The module that connects one engine to the Reins runtime contract. An adapter translates engine messages into Reins events. |
| runtime | The Reins core. It owns run identity, event order, session reuse, cancellation, and terminal events. You create it with `createHarness`. |
| sidecar | The JSON-RPC 2.0 server that exposes the runtime to a host that does not run JavaScript. |
| session | The durable conversation identity. A session is one tenant, actor, thread, and adapter. |
| run | One unit of admitted work. A run has its own run id and its own abort signal. |
| turn | One exchange inside a run. The runtime opens a turn with `turn-started` and closes it with `turn-completed`. |
| event | One append-only record in the session stream. Every event carries a sequence number. |
| tool | A host function that the engine can call during a turn. The host owns the schema, the validator, the policy, and the implementation. |
| interaction | A question that the engine or a tool asks a person, plus the answer. A permission request is an interaction. |
| control | A named setting that an engine or a model declares. A control is a toggle, a select, or a number. |
| limit | A snapshot of an account quota, credit window, or spend window. |
| discovery | The act of reading capabilities, engine profile, model catalog, and limits before a run. |
| admission | The check that turns selected values into a validated, pinned snapshot. Admission runs before any engine work starts. |
| checkpoint | The opaque resume token that an adapter stores. The runtime keeps it durable and returns it after a restart. |
| context source | A host-owned snapshot of domain state. The runtime prepares it once per turn. |
| steering | A change to an active turn. `same-turn` steering adds input to the live turn. `replacement-turn` steering cancels the turn and starts a new one. |

## Abbreviations

| Abbreviation | Expansion |
| --- | --- |
| ACP | Agent Client Protocol |
| API | application programming interface |
| CI | continuous integration |
| FFI | foreign function interface |
| IPC | inter-process communication |
| JSON | JavaScript Object Notation |
| JSON-RPC | JSON Remote Procedure Call |
| MCP | Model Context Protocol |
| NDJSON | newline-delimited JSON |
| OIDC | OpenID Connect |
| SDK | software development kit |
| SSE | server-sent events |
| TTL | time to live |
| UI | user interface |
| URI | uniform resource identifier |

## Words this documentation avoids

| Avoid | Use instead |
| --- | --- |
| provider | engine. The word `provider` stays only inside fixed identifiers, such as the `provider-replay` recovery value, and inside the phrase "provider-neutral". |
| application, product, client (as the embedder) | host |
| harness (as a common noun) | runtime, or the product name Reins. Reins is an agent harness. That phrase describes the category; it is not a second name for the runtime. |
| simply, just, easily | Delete the word. State the step. |

## Spelling

This repository uses American spelling. Write `behavior`, `canceled`,
`catalog`, `license`, and `normalize`.

## Sentence rules

- Write one instruction per sentence.
- Keep a sentence under about 20 words.
- Use the active voice and the present tense.
- Use the imperative mood in a procedure.
- Define an abbreviation on its first use in a document.
