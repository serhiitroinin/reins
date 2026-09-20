---
"reins": minor
---

Add live model and limit discovery for the native adapters.

- Add `createClaudeAgentSdkDiscovery`, `claudeAgentSdkModelCatalog`, and
  `claudeAgentSdkUsageLimitSnapshot`. Claude models, effort levels, and plan
  limits now come from the Agent SDK without a turn.
- Add `createCodexAppServerDiscovery` and `codexAccountLimitSnapshot`. Codex
  limits now come from `account/rateLimits/read` before the first turn.
- Read the `unifiedWindows` of a Claude rate limit update. Live updates carry
  no top-level utilization, so the adapter observed no Claude limits before.
  Utilization fractions are now converted to percentages.
- Merge newer streamed limits over a host limit source instead of hiding them.
- Answer a limit request without an account id from the account that reported
  last.
