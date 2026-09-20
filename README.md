<!-- logo -->

# Reins

[![npm version](https://img.shields.io/npm/v/reins.svg)](https://www.npmjs.com/package/reins)
[![CI](https://github.com/serhiitroinin/reins/actions/workflows/ci.yml/badge.svg)](https://github.com/serhiitroinin/reins/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/npm/l/reins.svg)](LICENSE)

Reins is a provider-neutral runtime for products that embed coding agents:
Claude Code, Codex, and ACP agents. It is the agent harness layer between your
product and the provider. It gives each product one interface for sessions, streaming, tools,
human interactions, model discovery, controls, limits, steering, cancellation,
replay, and resume.

Version 0.1 is stable.

## Install

Use Node.js 20 or newer.

```sh
npm install reins
```

Use the Node API when your host runs JavaScript or TypeScript. Use the sidecar
when your host uses another language or process.

## Node example

This example needs no provider account or network access.

```js
import {
  createHarness,
  createMemoryPersistence,
} from "reins";
import {
  createScriptedAdapter,
} from "reins/testing";

const { adapter } = createScriptedAdapter({
  async *script() {
    yield { kind: "assistant-text", text: "The harness is ready." };
  },
});

const harness = createHarness({
  adapters: [adapter],
  persistence: createMemoryPersistence(),
});

const run = harness.start({
  session: {
    tenantId: "acme",
    actorId: "ada",
    threadId: "first-thread",
  },
  adapterId: adapter.id,
  input: [{ type: "text", text: "Start" }],
});

for await (const event of run.events) {
  console.log(event.payload);
}

await harness.close();
```

The scripted adapter is for tests and examples. A product uses the native
Claude Code adapter, the native Codex adapter, or another conforming adapter.

## Any-stack sidecar

The package installs `reins-sidecar`. It provides the same runtime over
JSON-RPC 2.0 on standard input and standard output.

```sh
reins-sidecar \
  --host /absolute/path/to/harness-host.mjs \
  --store /absolute/path/to/private-store
```

The host module supplies adapters, credentials, process policy, application
tools, and context sources. The sidecar owns protocol framing and private
runtime persistence. It does not own the product database or user interface.

The npm package includes JSON Schema and generated Rust and Swift data types.
These types describe the portable protocol. They do not include provider SDKs
or product policy.

## What the package owns

- Provider-neutral run and session identity.
- Streamed events and one terminal result per turn.
- Application tools and provider permission interactions.
- Model, effort, permission, control, input, and limit discovery.
- Codex Fast as a generic model control.
- Steering, replacement, cancellation, replay, and resume checkpoints.
- Trusted host instructions and untrusted application context.
- Conformance tests for adapters and lifecycle behavior.
- A Node API and a versioned sidecar protocol.

## What the host owns

- Credentials and provider accounts.
- Process launch and the exact child environment.
- Filesystem, network, shell, sandbox, and approval policy.
- Product data, authorization, confirmation, and persistence choices.
- Uploads, draft storage, notifications, and the user interface.

Reins is not a sandbox. A capability describes provider behavior. It
does not grant authority.

## Provider support

The native Claude Code adapter uses the Claude Agent SDK. The native Codex
adapter uses Codex App Server. They share the runtime contract, but they do not
pretend to have the same capabilities.

Hosts read the profile and model catalog before each admitted turn. Optional
features stay discoverable. Unsupported features return `unsupported`; they do
not become empty or invented values.

The ACP v1 adapter is an optional interoperability path. The adapter contract
uses open identifiers, so future providers do not require a closed core enum.

## Public API

The package exposes these groups:

- Core runtime, protocol, input, context, tools, and persistence.
- Discovery and admission helpers.
- Interactions, follow-up queues, and safe event projection.
- NDJSON, JSON-RPC, and async-iterable transports.
- Native Claude Code and Codex adapters and Node connectors.
- ACP v1 and experimental OpenCode ACP composition helpers.
- The sidecar server, protocol, executable, and file store.
- Test fixtures and shared conformance runners.
- Versioned JSON Schema under `schema/v1`.

`api/public-api.json` records every exported TypeScript symbol. The release
gate fails when the implementation and the manifest differ.

## Documentation

Start with [the documentation index](docs/README.md).

Important guides:

- [Node quickstart](docs/getting-started/node.md)
- [Sidecar quickstart](docs/getting-started/sidecar.md)
- [Claude Code and Codex](docs/getting-started/native-providers.md)
- [API stability](docs/API_STABILITY.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Sidecar protocol v1](docs/SIDECAR_V1.md)
- [Schema compatibility](docs/SCHEMA_V1.md)

The npm tarball contains every guide. After installation, open
`node_modules/reins/docs/README.md`.

## Development

Development needs [Bun](https://bun.sh) 1.2 or newer and Node.js 20 or newer.
Consumers of the npm package need only Node.js.

```sh
bun install
bun run check
bun run smoke:consumer
```

The binding tests are optional. They need a Rust toolchain and a Swift 5.9
toolchain (macOS or Linux). CI runs both.

```sh
cargo test --locked --manifest-path bindings/rust/Cargo.toml
swift test --package-path bindings/swift
```

Live Claude Code and Codex tests are opt-in because they use local provider
accounts. See `docs/getting-started/live-tests.md`.

Read [CONTRIBUTING.md](CONTRIBUTING.md) before you open a pull request and
[SECURITY.md](SECURITY.md) before you report a vulnerability. Maintainers read
[the release procedure](docs/RELEASING.md) before a release.

## Status

OpenCode and Grok provider work is paused. The extension contract remains open
for them and for other providers.

## License

MIT
