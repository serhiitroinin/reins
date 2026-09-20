<!-- logo -->

# Reins

[![npm version](https://img.shields.io/npm/v/reins.svg)](https://www.npmjs.com/package/reins)
[![CI](https://github.com/serhiitroinin/reins/actions/workflows/ci.yml/badge.svg)](https://github.com/serhiitroinin/reins/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/npm/l/reins.svg)](LICENSE)

Reins is a provider-neutral runtime for products that embed a coding agent.
It is an agent harness: one interface to Claude Code, Codex, and ACP agents,
covering sessions, streaming, tools, interactions, discovery, steering,
cancellation, replay, and resume.

## Who it is for

Reins is for the team that builds the product around the agent.

- You ship a desktop, web, or native application that runs an agent for a
  person.
- You want to offer more than one engine, without a branch on the engine name
  in your code.
- You own your domain data, your user interface, and your approval rules, and
  you intend to keep owning them.

Reins is not for you if you want a chat UI component, a hosted service, or a
sandbox. Reins ships none of those.

## Quick start

This example needs no account and no network access. Use Node.js 20 or newer.

```sh
npm install reins
```

```js
import { createHarness, createMemoryPersistence } from "reins";
import { createScriptedAdapter } from "reins/testing";

const { adapter } = createScriptedAdapter({
  async *script() {
    yield { kind: "assistant-text", text: "Reins is ready." };
  },
});

const harness = createHarness({
  adapters: [adapter],
  persistence: createMemoryPersistence(),
});

const run = harness.start({
  session: { tenantId: "acme", actorId: "ada", threadId: "first-thread" },
  adapterId: adapter.id,
  input: [{ type: "text", text: "Start" }],
});

for await (const event of run.events) console.log(event.payload);
await harness.close();
```

The scripted adapter is for development and tests. Swap it for a native
adapter when you add an account. Read the
[Node quickstart](docs/getting-started/node.md) next.

## Engines

Every engine reaches your host through the same contract. The engines do not
pretend to have the same features. Read discovery data; never infer a feature
from a name.

| Feature | Claude Code | Codex | ACP v1 |
| --- | --- | --- | --- |
| Sessions and resume | Yes | Yes | Yes, when the agent offers `session/load` |
| Streamed events | Yes | Yes | Yes |
| Application tools | Yes, through an in-process MCP server | Yes, as dynamic tools | Yes, through host-owned MCP servers |
| Interactions | Yes | No | Yes |
| Model discovery | Live, from the Agent SDK control channel | Live, from `model/list` | Host-supplied |
| Limit discovery | Live, from the experimental usage request | Live, from `account/rateLimits/read` | Host-supplied; `unsupported` by default |
| Steering | `same-turn` | `same-turn` | `replacement-turn` |
| Cancel | Yes | Yes | Yes |
| Subagent stop | Yes | No | No |
| Thinking and plans | Yes | Yes | Yes |
| Usage events | Yes | Yes | Experimental |

An unsupported feature returns `unsupported`. It never returns an empty or
invented value.

Codex Fast is a generic model control. Read it from the profile and pass it in
`settings.controls`. Do not add a Codex-only field to your UI state.

## Hosts outside JavaScript

The package installs `reins-sidecar`. It serves the same runtime over JSON-RPC
2.0 on standard input and standard output.

```sh
reins-sidecar \
  --host /absolute/path/to/harness-host.mjs \
  --store /absolute/path/to/private-store
```

Your host module supplies the adapters, the credentials, the process policy,
the application tools, and the context sources. The sidecar owns protocol
framing and private runtime persistence. It does not own your database or your
user interface.

The npm package ships JSON Schema plus generated Swift and Rust data types.
Those types describe the portable protocol. They contain no engine SDK and no
product policy.

Start with the [sidecar quickstart](docs/getting-started/sidecar.md) or the
[Rust sidecar example](docs/getting-started/rust.md).

## Applications built on Reins

| Application | What it is |
| --- | --- |
| [Easel](https://github.com/serhiitroinin/easel) | A shared canvas. A person and an agent draw on the same board. |
| [Sculpt](https://github.com/serhiitroinin/sculpt) | A CAD workbench. An agent models a part and looks at its own renders. |
| [Butler](https://github.com/serhiitroinin/butler) | A macOS folder organizer. An agent proposes a plan, and the person approves it. |

Each one uses a different host stack. Easel and Sculpt embed the Node.js API.
Butler is a Swift application that drives the sidecar.

## What Reins owns

- Engine-neutral run and session identity.
- Streamed events and one terminal result per turn.
- Application tools and engine permission interactions.
- Model, effort, permission, control, input, and limit discovery.
- Steering, replacement, cancellation, replay, and resume checkpoints.
- Trusted host instructions and untrusted host context.
- Conformance tests for adapters and lifecycle behavior.
- A Node.js API and a versioned sidecar protocol.

## What your host owns

- Credentials and engine accounts.
- Process launch and the exact child environment.
- Filesystem, network, shell, sandbox, and approval policy.
- Product data, authorization, confirmation, and persistence choices.
- Uploads, draft storage, notifications, and the user interface.

Reins is not a sandbox. A capability describes engine behavior. It grants no
authority.

## Documentation

Start at [the documentation index](docs/README.md).

| Page | Read it for |
| --- | --- |
| [Node quickstart](docs/getting-started/node.md) | One streamed turn with a tool |
| [Sidecar quickstart](docs/getting-started/sidecar.md) | A host in another language |
| [Claude Code and Codex](docs/getting-started/native-providers.md) | Native engine setup |
| [Build your own app](docs/guides/build-an-app.md) | The complete product checklist |
| [FAQ](docs/guides/faq.md) | Auth, cost, neutrality, and platforms |
| [Glossary](docs/GLOSSARY.md) | Every term this documentation uses |
| [Architecture](docs/ARCHITECTURE.md) | The ownership boundary and the life of a turn |
| [API stability](docs/API_STABILITY.md) | What may change and when |
| [Sidecar protocol v1](docs/SIDECAR_V1.md) | Every command, callback, and event |
| [Schema v1](docs/SCHEMA_V1.md) | JSON and native binding compatibility |

The npm tarball contains every guide. After installation, open
`node_modules/reins/docs/README.md`.

## Status

Version 0.1 is stable. A stable change is additive. See
[API stability](docs/API_STABILITY.md).

Native Claude Code and Codex support is complete. The ACP v1 adapter is an
optional interoperability path. OpenCode and Grok work is paused; the adapter
contract stays open for them and for other engines.

## Development

Development needs [Bun](https://bun.sh) 1.2 or newer and Node.js 20 or newer.
A consumer of the npm package needs only Node.js.

```sh
bun install
bun run check
bun run smoke:consumer
```

The binding tests are optional. They need a Rust toolchain and a Swift 5.9
toolchain on macOS or Linux. CI runs both.

```sh
cargo test --locked --manifest-path bindings/rust/Cargo.toml
swift test --package-path bindings/swift
```

Live Claude Code and Codex tests are opt-in, because they use a local engine
account. See [live engine tests](docs/getting-started/live-tests.md).

Read [CONTRIBUTING.md](CONTRIBUTING.md) before you open a pull request. Read
[SECURITY.md](SECURITY.md) before you report a vulnerability. Maintainers read
[the release procedure](docs/RELEASING.md) before a release.

`api/public-api.json` records every exported TypeScript symbol. The release
gate fails when the implementation and the manifest differ.

## License

MIT
