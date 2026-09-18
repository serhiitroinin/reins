/**
 * Limits a provider pushed during a turn, kept per provider account.
 *
 * A host's limit source answers before any turn has run. Stream updates are
 * newer than that answer, so they are merged on top of it by limit id.
 */

import type {
  HarnessDiscovery,
  HarnessDiscoveryRequest,
  HarnessLimit,
  HarnessLimitSnapshot,
} from "../profile.js";

interface ObservedLimit {
  limit: HarnessLimit;
  observedAt: string;
}

interface ObservedAccount {
  limits: Map<string, ObservedLimit>;
  planLabel?: string;
  observedAt: string;
}

export interface ObservedLimits {
  record(accountId: string | undefined, snapshot: HarnessLimitSnapshot): void;
  resolve(
    request: HarnessDiscoveryRequest,
    source?: HarnessDiscovery<HarnessLimitSnapshot>,
  ): HarnessDiscovery<HarnessLimitSnapshot>;
}

export function createObservedLimits(now: () => Date): ObservedLimits {
  const accounts = new Map<string, ObservedAccount>();
  let latest: ObservedAccount | undefined;

  /** A request that names no account reads the account that last reported. */
  const find = (accountId: string | undefined): ObservedAccount | undefined =>
    accountId === undefined ? accounts.get("") ?? latest : accounts.get(accountId);

  return {
    record(accountId, snapshot) {
      const observedAt = now().toISOString();
      const key = accountId ?? "";
      let account = accounts.get(key);
      if (!account) {
        account = { limits: new Map(), observedAt };
        accounts.set(key, account);
      }
      for (const limit of snapshot.limits) account.limits.set(limit.id, { limit, observedAt });
      if (snapshot.planLabel) account.planLabel = snapshot.planLabel;
      account.observedAt = observedAt;
      latest = account;
    },

    resolve(request, source) {
      const account = find(request.accountId);
      if (!account || account.limits.size === 0) return source ?? { status: "unsupported" };
      if (source?.status !== "available") {
        return {
          status: "available",
          value: {
            ...(account.planLabel ? { planLabel: account.planLabel } : {}),
            limits: [...account.limits.values()].map((entry) => entry.limit),
          },
          fetchedAt: account.observedAt,
        };
      }
      const fetchedMs = Date.parse(source.fetchedAt ?? "");
      const merged = new Map(source.value.limits.map((limit) => [limit.id, limit]));
      let newest = source.fetchedAt;
      let newestMs = fetchedMs;
      for (const [id, entry] of account.limits) {
        const observedMs = Date.parse(entry.observedAt);
        if (Number.isFinite(fetchedMs) && observedMs < fetchedMs) continue;
        merged.set(id, entry.limit);
        if (!Number.isFinite(newestMs) || observedMs > newestMs) {
          newest = entry.observedAt;
          newestMs = observedMs;
        }
      }
      const planLabel = source.value.planLabel ?? account.planLabel;
      return {
        status: "available",
        value: {
          ...source.value,
          ...(planLabel ? { planLabel } : {}),
          limits: [...merged.values()],
        },
        ...(newest ? { fetchedAt: newest } : {}),
        ...(source.expiresAt ? { expiresAt: source.expiresAt } : {}),
      };
    },
  };
}
