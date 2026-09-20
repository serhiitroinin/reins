# Incident terminal reference host

This example is a small, standalone product built on the public Reins API. Its
user interface is a terminal. Its domain is an in-memory incident store.

The complete flow runs offline. It needs no credentials, no network access, and
no engine SDK.

```bash
bun run example:incident
```

## What the demo shows

The deterministic demo performs these steps in order:

1. Render generic capability, engine, model, permission, control, and limit
   discovery.
2. Prepare trusted instructions and untrusted incident context.
3. Call validated domain tools.
4. Restart the host and load an opaque checkpoint.
5. Cancel a final turn and retain the partial events.

## Two consent boundaries

The example keeps both consent boundaries visible on purpose.

| Boundary | Who asks | How the host answers |
| --- | --- | --- |
| Engine execution permission | The fixture adapter, through a `HarnessInteraction` | `run.respond` |
| Domain write confirmation | The `incident_acknowledge` implementation, after validation and policy | An operator prompt, immediately before the store changes |

Neither decision is inferred from the other.

## Run it interactively

```bash
bun run example:incident:interactive
```

Try these prompts:

- `Inspect INC-104`
- `Inspect and acknowledge INC-104`
- `Use invalid input while inspecting INC-104`
- `Inspect INC-999`

The interactive host also accepts `/restart`, `/cancel-demo`, and `/quit`.

## What this example does not prove

The adapter is scripted on purpose. It proves the host boundary and the user
interface boundary. It does not prove engine interoperability. The native
Claude Code, Codex, and ACP adapters have their own conformance tests and live
tests.

A real product replaces the fixture adapter and the in-memory store. It keeps
the same runtime, event renderer, context sources, tool host, and
discovery-driven controls.

The runtime is not a sandbox. A real host still owns all of these:

- process creation and credentials;
- environment allow-lists;
- filesystem and network policy;
- durable tenant-scoped stores;
- terminal safety and every domain transaction.

Read [build your own app on Reins](../../docs/guides/build-an-app.md) next.
