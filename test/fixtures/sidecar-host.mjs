const unsupported = { support: "unsupported" };

export default {
  server: { name: "fold-harness-test-sidecar", version: "1" },
  adapters: [{
    id: "test:sidecar",
    capabilities() {
      return {
        resume: unsupported,
        cancel: unsupported,
        interactions: unsupported,
        tools: unsupported,
        images: unsupported,
        thinking: unsupported,
        plans: unsupported,
        usage: unsupported,
        subagents: unsupported,
        shell: unsupported,
        filesystem: unsupported,
        network: unsupported,
      };
    },
    open() {
      throw new Error("the process smoke does not start a provider turn");
    },
  }],
};
