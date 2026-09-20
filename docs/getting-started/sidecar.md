# Sidecar quickstart

Use the sidecar when your product does not run inside Node. The sidecar uses
JSON-RPC 2.0 over standard input and standard output.

## 1. Install the package

```sh
npm install reins
```

## 2. Create a host module

Create `host.mjs`. This module is the trusted Node boundary. It creates your
adapters. It also owns provider credentials and process policy.

```js
export default {
  server: { name: "my-harness", version: "1.0.0" },
  adapters: [myAdapter],
};
```

The module must provide at least one adapter. It may also provide context
sources and a safe diagnostic callback.

## 3. Create a private store

The sidecar store has one writer. Do not share one store directory between
processes.

```sh
mkdir -m 700 ./harness-store
```

## 4. Start the sidecar

The two paths must be absolute paths.

```sh
./node_modules/.bin/reins-sidecar \
  --host "$PWD/host.mjs" \
  --store "$PWD/harness-store"
```

Standard output contains protocol frames only. Read one JSON object per line.
Write one JSON object per line.

Start with this request:

```json
{"jsonrpc":"2.0","id":1,"method":"harness/initialize","params":{"protocolVersion":1,"client":{"name":"my-app","version":"1.0.0"}}}
```

The response lists the adapters, commands, callbacks, and notifications.
After initialization, call discovery before you start a run.

## 5. Implement host tools

The sidecar can call your product with `host/tool/call`. Validate the input.
Apply your policy. Ask for product confirmation when a write needs it. Then
return a tool result.

Provider permission and product confirmation are different consent steps.
Do not combine them.

Read [sidecar protocol v1](../SIDECAR_V1.md) for every method and payload.
