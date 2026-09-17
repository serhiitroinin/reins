const unsupported = { support: "unsupported" };

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

export default {
  server: { name: "fold-harness-test-sidecar", version: "1" },
  adapters: [{
    id: "test:sidecar",
    checkpoint: { format: "test:sidecar:v1" },
    capabilities() {
      return {
        resume: { support: "stable" },
        cancel: { support: "stable" },
        interactions: { support: "stable", recovery: "live-only" },
        tools: { support: "stable" },
        images: unsupported,
        thinking: unsupported,
        plans: unsupported,
        usage: unsupported,
        subagents: unsupported,
        shell: unsupported,
        filesystem: unsupported,
        network: unsupported,
        steering: {
          support: "stable",
          strategies: ["same-turn", "replacement-turn"],
          preferred: "same-turn",
        },
      };
    },
    profile() {
      return {
        status: "available",
        value: {
          id: "test:sidecar",
          label: "Native sidecar fixture",
          modelSelection: "required",
          permissions: {
            kind: "approval-policy",
            selectable: true,
            defaultModeId: "ask",
            modes: [
              { id: "ask", label: "Ask", posture: "standard" },
              { id: "trusted", label: "Trusted", posture: "elevated" },
            ],
          },
          controls: [{
            id: "speed",
            label: "Speed",
            kind: "select",
            scope: "turn",
            options: [
              { id: "normal", label: "Normal" },
              { id: "fast", label: "Fast" },
            ],
            defaultValue: "normal",
          }],
          inputPolicy: { modalities: { text: { support: "stable" } } },
        },
      };
    },
    models() {
      return {
        status: "available",
        value: {
          selection: "required",
          defaultModelId: "alpha",
          models: [
            {
              id: "alpha",
              label: "Alpha",
              effort: {
                defaultOptionId: "medium",
                options: [{ id: "medium", label: "Medium" }],
              },
            },
            {
              id: "beta",
              label: "Beta",
              effort: {
                defaultOptionId: "high",
                options: [{ id: "high", label: "High" }],
              },
            },
          ],
        },
      };
    },
    limits() {
      return {
        status: "available",
        value: {
          planLabel: "Fixture plan",
          limits: [{
            id: "fixture:turns",
            label: "Turns",
            kind: "quota",
            scope: "account",
            unit: "requests",
            remaining: 99,
          }],
        },
      };
    },
    async open({ resumeToken }) {
      let gate = deferred();
      let followUp = "";
      let interaction = "";
      return {
        async *run(request) {
          gate = deferred();
          const first = request.input[0];
          const text = first?.type === "text" ? first.text : "";
          if (text === "tool") {
            const result = await request.tools.call("lookup", { query: "status" });
            const content = result.content[0];
            yield {
              kind: "assistant-text",
              text: `tool:${content?.type === "text" ? content.text : "missing"}`,
            };
            return;
          }
          if (text === "interaction") {
            yield {
              kind: "interaction-requested",
              interaction: {
                id: "approval-1",
                kind: "permission",
                title: "Continue?",
                acceptsText: true,
              },
            };
            await gate.promise;
            yield { kind: "assistant-text", text: `interaction:${interaction}` };
            return;
          }
          if (text === "steer") {
            yield { kind: "assistant-text", text: "waiting-for-steer" };
            await gate.promise;
            yield { kind: "assistant-text", text: `steered:${followUp}` };
            return;
          }
          if (text === "replace") {
            yield { kind: "assistant-text", text: "waiting-for-replacement" };
            await gate.promise;
            return;
          }
          if (text === "cancel") {
            yield { kind: "assistant-text", text: "partial-before-cancel" };
            await gate.promise;
            return;
          }
          yield {
            kind: "assistant-text",
            text: [
              resumeToken === null ? "fresh" : "resumed",
              request.model ?? "none",
              request.effort ?? "none",
              String(request.settings?.controls?.speed ?? "none"),
              text,
            ].join(":"),
          };
        },
        async steer(request) {
          const first = request.input[0];
          followUp = first?.type === "text" ? first.text : "";
          gate.resolve();
        },
        async respond(_interactionId, response) {
          interaction = response.text ?? response.choiceId ?? "";
          gate.resolve();
        },
        async cancel() {
          gate.resolve();
        },
        checkpoint() {
          return "fixture-checkpoint";
        },
        async close() {
          gate.resolve();
        },
      };
    },
  }],
};
