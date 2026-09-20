# Incident terminal reference host

This example is a small, standalone product built on the public harness API. It
uses a terminal UI and an in-memory incident domain so the complete flow runs
offline, without credentials, network access, or a provider SDK.

```bash
bun run example:incident
```

The deterministic demo renders generic capability, engine, model, permission,
control, and limit discovery. It then prepares trusted instructions and
untrusted incident context, calls validated domain tools, restarts the host to
load an opaque checkpoint, and cancels a final turn while retaining partial
events.

Two consent boundaries are intentionally visible:

1. The fixture adapter asks for provider execution permission through a
   `HarnessInteraction`, which the terminal answers with `run.respond`.
2. The `incident_acknowledge` implementation asks the application operator to
   confirm the domain write after tool validation and policy, immediately
   before changing the incident store.

Run the same host with real terminal questions:

```bash
bun run example:incident:interactive
```

Useful prompts include `Inspect INC-104`, `Inspect and acknowledge INC-104`,
`Use invalid input while inspecting INC-104`, and `Inspect INC-999`. The
interactive host also accepts `/restart`, `/cancel-demo`, and `/quit`.

The adapter is deliberately scripted. It proves the host and UI boundary, not
provider interoperability; native Claude/Codex and generic ACP adapters have
their own conformance and live tests. A real product replaces the fixture
adapter and in-memory store while keeping the same runtime, event renderer,
context sources, tool host, and discovery-driven controls.

The runtime is not a sandbox. A real host still owns process creation,
credentials, environment allowlists, filesystem and network policy, durable
tenant-scoped stores, terminal safety, and every application transaction.
