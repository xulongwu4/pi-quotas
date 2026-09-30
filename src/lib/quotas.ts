import { stripVTControlCharacters } from "node:util";
import type { AuthStorage } from "@mariozechner/pi-coding-agent";
import { cancelledError, PROVIDER_FETCHERS } from "../providers/fetch.js";
import type { QuotaSnapshot, QuotasResult, SupportedQuotaProvider } from "../types/quotas.js";
import { quotaAuthStorage } from "./auth.js";
import { ACCOUNT_SELECTION_CHANGED, ACCOUNT_SERVICE_PENDING, quotaAccount, type AccountContext } from "./multiprovider.js";

export const SUPPORTED_PROVIDERS: SupportedQuotaProvider[] = [
  "anthropic",
  "openai-codex",
  "github-copilot",
  "openrouter",
  "synthetic",
  "zai",
  "opencode-go",
  "kimi-coding",
  "grok",
  "antigravity",
  "devin",
  "cursor",
  "cline-pass",
];

export const PROVIDER_LABELS: Record<SupportedQuotaProvider, string> = {
  anthropic: "Anthropic",
  "openai-codex": "OpenAI Codex",
  "github-copilot": "GitHub Copilot",
  openrouter: "OpenRouter",
  synthetic: "Synthetic",
  zai: "Z.ai",
  "opencode-go": "OpenCode Go",
  "kimi-coding": "Kimi Code",
  grok: "Grok",
  antigravity: "Antigravity",
  devin: "Devin",
  cursor: "Cursor",
  "cline-pass": "ClinePass",
};

const DEFAULT_PROVIDER_TTL_MS = 60_000;

const PROVIDER_TTLS_MS: Record<SupportedQuotaProvider, number> = {
  anthropic: DEFAULT_PROVIDER_TTL_MS,
  "openai-codex": DEFAULT_PROVIDER_TTL_MS,
  "github-copilot": DEFAULT_PROVIDER_TTL_MS,
  openrouter: DEFAULT_PROVIDER_TTL_MS,
  synthetic: DEFAULT_PROVIDER_TTL_MS,
  zai: DEFAULT_PROVIDER_TTL_MS,
  "opencode-go": DEFAULT_PROVIDER_TTL_MS,
  "kimi-coding": DEFAULT_PROVIDER_TTL_MS,
  grok: DEFAULT_PROVIDER_TTL_MS,
  antigravity: DEFAULT_PROVIDER_TTL_MS,
  // GetUserStatus returns the full ~370KB model catalog for ~1KB of
  // planStatus; poll it less often than the small usage endpoints.
  devin: 5 * 60_000,
  cursor: DEFAULT_PROVIDER_TTL_MS,
  "cline-pass": DEFAULT_PROVIDER_TTL_MS,
};

const ERROR_TTL_MS = 10_000;
// A 429 means the provider's quota endpoint is throttling us; re-asking every
// 10s just keeps it tripped (and burns nothing useful).
const RATE_LIMIT_TTL_MS = 5 * 60_000;

type InFlightFetch = {
  promise: Promise<QuotasResult>;
  controller: AbortController;
  waiters: number;
  settled: boolean;
};

type CacheEntry = {
  result?: QuotasResult;
  fetchedAt?: number;
  inFlight?: InFlightFetch;
  /** Credential refresh backoff, kept separate so a failed force refresh preserves warm quotas. */
  authFailure?: { result: QuotasResult; fetchedAt: number };
};

// Keyed by provider, or provider@account for pi-multiprovider accounts.
const cache = new Map<string, CacheEntry>();

function evictInFlight(key: string, fetch: InFlightFetch): void {
  const current = cache.get(key);
  if (current?.inFlight !== fetch) return;
  delete current.inFlight;
  cache.set(key, current);
}

function releaseIfUnused(key: string, fetch: InFlightFetch): void {
  if (fetch.waiters !== 0 || fetch.settled) return;
  evictInFlight(key, fetch);
  fetch.controller.abort();
}

export function normalizeQuotaProvider(
  provider: string | undefined,
): SupportedQuotaProvider | undefined {
  if (!provider) return undefined;
  if (
    provider === "grok" ||
    provider.startsWith("grok/") ||
    provider === "xai" ||
    provider.startsWith("xai/")
  ) {
    return "grok";
  }
  if (
    provider === "antigravity" ||
    provider.startsWith("antigravity/") ||
    provider === "agy" ||
    provider.startsWith("agy/") ||
    provider === "google-antigravity"
  ) {
    return "antigravity";
  }
  if (
    provider === "opencode-go" ||
    provider.startsWith("opencode-go/")
  ) {
    return "opencode-go";
  }
  // Both Cline providers bill the same account, so the pay-as-you-go `cline`
  // provider reports through the same quota windows.
  if (
    provider === "cline-pass" ||
    provider.startsWith("cline-pass/") ||
    provider === "clinepass" ||
    provider === "cline" ||
    provider.startsWith("cline/") ||
    provider === "cline-free" ||
    provider.startsWith("cline-free/")
  ) {
    return "cline-pass";
  }
  if (SUPPORTED_PROVIDERS.includes(provider as SupportedQuotaProvider)) {
    return provider as SupportedQuotaProvider;
  }
  return undefined;
}

export function isSupportedProvider(
  provider: string | undefined,
): provider is SupportedQuotaProvider {
  return normalizeQuotaProvider(provider) !== undefined;
}

export function clearQuotaCache(provider?: SupportedQuotaProvider): void {
  for (const [key, entry] of cache) {
    if (provider && key !== provider && !key.startsWith(`${provider}@`)) continue;
    entry.inFlight?.controller.abort();
    cache.delete(key);
  }
}

function cancelledResult(): QuotasResult {
  return { success: false, error: cancelledError() };
}

/** Wait on a shared fetch. A caller abort releases only its waiter;
 * the HTTP request is aborted when no consumers remain. */
function waitForFetch(
  key: string,
  fetch: InFlightFetch,
  signal?: AbortSignal,
): Promise<QuotasResult> {
  fetch.waiters++;
  return new Promise<QuotasResult>((resolve, reject) => {
    let finished = false;
    const release = () => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener("abort", onAbort);
      fetch.waiters--;
      releaseIfUnused(key, fetch);
    };
    const onAbort = () => {
      release();
      resolve(cancelledResult());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    fetch.promise.then(
      (result) => {
        release();
        resolve(result);
      },
      (error) => {
        release();
        reject(error);
      },
    );
  });
}

type FetchOptions = {
  force?: boolean;
  signal?: AbortSignal;
  /** pi-multiprovider account id; keeps per-account results apart. */
  account?: string;
};

/** Check cached/in-flight quotas before resolving account credentials. */
function cachedQuotaResult(
  provider: SupportedQuotaProvider,
  options?: FetchOptions,
): Promise<QuotasResult> | undefined {
  const key = options?.account ? `${provider}@${options.account}` : provider;
  const entry = cache.get(key);
  if (!entry) return undefined;
  const ttl = !entry.result?.success
    ? entry.result?.error.kind === "rate_limit" ? RATE_LIMIT_TTL_MS : ERROR_TTL_MS
    : PROVIDER_TTLS_MS[provider];
  if (!options?.force && entry.result && entry.fetchedAt !== undefined &&
      Date.now() - entry.fetchedAt < ttl) {
    return Promise.resolve(entry.result);
  }
  // Forced refreshes also join an existing, still-observed fetch.
  if (entry.inFlight) return waitForFetch(key, entry.inFlight, options?.signal);
  return undefined;
}

export async function fetchProviderQuotas(
  authStorage: AuthStorage,
  rawProvider: SupportedQuotaProvider | string,
  options?: FetchOptions,
): Promise<QuotasResult> {
  const provider =
    normalizeQuotaProvider(rawProvider) ??
    (rawProvider as SupportedQuotaProvider);
  // Cancellation wins before cache lookup or network kickoff: an already-
  // aborted caller must not start an unobserved background request.
  if (options?.signal?.aborted) return cancelledResult();
  const cached = cachedQuotaResult(provider, options);
  if (cached) return cached;
  const key = options?.account ? `${provider}@${options.account}` : provider;
  const entry = cache.get(key) ?? {};

  const controller = new AbortController();
  const inFlight = {
    controller,
    waiters: 0,
    settled: false,
  } as InFlightFetch;
  inFlight.promise = PROVIDER_FETCHERS[provider](authStorage, controller.signal)
    .then((result: QuotasResult) => {
      const current = cache.get(key);
      // Only the current, still-observed fetch may populate the cache; an
      // aborted/replaced fetch cannot overwrite its successor.
      if (current?.inFlight === inFlight && !controller.signal.aborted) {
        cache.set(key, {
          ...current,
          result,
          fetchedAt: Date.now(),
          authFailure: undefined,
        });
      }
      return result;
    })
    .finally(() => {
      inFlight.settled = true;
      evictInFlight(key, inFlight);
    });

  cache.set(key, { ...entry, inFlight });
  // A caller may abort before the shared promise settles; keep its rejection
  // handled independently of any individual waiter.
  inFlight.promise.catch(() => {});
  return waitForFetch(key, inFlight, options?.signal);
}

/** Extra Pi provider ids a quota fetcher reads credentials from. */
const PI_PROVIDER_ALIASES: Partial<Record<SupportedQuotaProvider, string[]>> = {
  "opencode-go": ["opencode"],
  grok: ["xai"],
  antigravity: ["google-antigravity", "agy"],
  "cline-pass": ["cline", "cline-free", "clinepass"],
};

/**
 * Fetchers that cannot be scoped to a pooled account's model token:
 * Copilot quotas need the GitHub OAuth token pi-multiprovider does not
 * expose (its resolved model token is a Copilot proxy token).
 */
const NO_ACCOUNT_QUOTAS = new Set<SupportedQuotaProvider>(["github-copilot"]);

/** Pi provider ids to probe for `provider`'s pooled account, current model first. */
function piProviderIds(ctx: AccountContext, provider: SupportedQuotaProvider): string[] {
  let current: string | undefined;
  try {
    current = ctx.model?.provider;
  } catch {
    // stale ctx
  }
  const ids = [provider, ...(PI_PROVIDER_ALIASES[provider] ?? [])];
  if (!current || normalizeQuotaProvider(current) !== provider) return ids;
  return [current, ...ids.filter((id) => id !== current)];
}

/**
 * Follow the service's selected identity, checking its cache before touching auth.
 * Never guess Pi's default account when a loaded service cannot identify one.
 */
export async function fetchContextQuotas(
  ctx: AccountContext,
  provider: SupportedQuotaProvider,
  options?: { force?: boolean; signal?: AbortSignal },
): Promise<QuotaSnapshot> {
  let snapshot: Omit<QuotaSnapshot, "result"> = { provider };
  const cancelled = (): QuotaSnapshot => ({ ...snapshot, result: cancelledResult() });
  if (options?.signal?.aborted) return cancelled();
  try {
    const base = quotaAuthStorage(ctx.modelRegistry);
    // Retry a changed selection from identity lookup, so its new cache key is
    // checked before resolving again. Never store a new account under the old key.
    for (let attempt = 0; attempt < 3; attempt++) {
      snapshot = { provider };
      const account = await quotaAccount(ctx, piProviderIds(ctx, provider), base, options?.signal);
      if (options?.signal?.aborted) return cancelled();
      if (account === ACCOUNT_SELECTION_CHANGED) continue;
      if (account === ACCOUNT_SERVICE_PENDING) {
        return { provider, result: { success: false, error: { kind: "account_pending", message: "pi-multiprovider is updating its pools." } } };
      }
      if (account === undefined) {
        // A service disappearing during resolution is not permission to use
        // another login. Ordinary standalone requests still use Pi credentials.
        if (attempt > 0) break;
        return { provider, result: await fetchProviderQuotas(base, provider, options) };
      }
      if (account === null) {
        return {
          provider,
          result: {
            success: false,
            error: {
              kind: "account_unknown",
              message: "pi-multiprovider did not identify an active account. If this provider has a pool, select one with /switch-account. Older services cannot distinguish no pool from no selection; upgrade to a service with hasPool() to restore unpooled quotas.",
            },
          },
        };
      }
      const label = stripVTControlCharacters(account.label).replace(/\p{Cc}/gu, " ").trim();
      snapshot = { provider, account: label, accountId: account.id };
      if (NO_ACCOUNT_QUOTAS.has(provider) && !account.upstream) {
        return {
          ...snapshot,
          result: {
            success: false,
            error: { message: "Per-account quotas are not available for pooled accounts", kind: "not_applicable" },
          },
        };
      }
      const scopedOptions = { ...options, account: account.id };
      const cached = cachedQuotaResult(provider, scopedOptions);
      if (cached) return { ...snapshot, result: await cached };
      const failure = cache.get(`${provider}@${account.id}`)?.authFailure;
      if (!options?.force && failure && Date.now() - failure.fetchedAt < ERROR_TTL_MS) {
        return { ...snapshot, result: failure.result };
      }
      const authStorage = await account.resolveAuth(options?.signal);
      if (options?.signal?.aborted) return cancelled();
      if (authStorage === null) {
        snapshot = { provider };
        continue; // reselect, including the new identity's cache
      }
      if (!authStorage) {
        const result: QuotasResult = {
          success: false,
          error: { kind: "config", message: `Could not resolve credentials for account ${label}` },
        };
        const key = `${provider}@${account.id}`;
        cache.set(key, { ...cache.get(key), authFailure: { result, fetchedAt: Date.now() } });
        return { ...snapshot, result };
      }
      return {
        ...snapshot,
        result: await fetchProviderQuotas(authStorage, provider, scopedOptions),
      };
    }
    return {
      ...snapshot,
      result: {
        success: false,
        error: {
          message: "pi-multiprovider changed during account lookup; try again.",
          kind: "network",
        },
      },
    };
  } catch {
    if (options?.signal?.aborted) return cancelled();
    return {
      ...snapshot,
      result: {
        success: false,
        error: { message: "Could not determine the pi-multiprovider account", kind: "network" },
      },
    };
  }
}

export async function fetchAllProviderQuotas(
  ctx: AccountContext,
  options?: {
    force?: boolean;
    signal?: AbortSignal;
    /** Called with each snapshot as it resolves, so UIs can render
     * incrementally instead of waiting for the slowest provider. */
    onSnapshot?: (snapshot: QuotaSnapshot) => void;
  },
): Promise<QuotaSnapshot[]> {
  const { force, signal, onSnapshot } = options ?? {};
  // Promise.all preserves SUPPORTED_PROVIDERS order in the return value;
  // onSnapshot still fires in completion order for incremental rendering.
  return Promise.all(
    SUPPORTED_PROVIDERS.map(async (provider) => {
      const snapshot = await fetchContextQuotas(ctx, provider, { force, signal });
      onSnapshot?.(snapshot);
      return snapshot;
    }),
  );
}

export function formatResetTime(renewsAt: string): string {
  const date = new Date(renewsAt);
  const now = new Date();
  const diffMs = date.getTime() - now.getTime();

  if (diffMs <= 0) return "soon";

  const diffHours = Math.ceil(diffMs / (1000 * 60 * 60));
  const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

  if (diffHours < 24) return `in ${diffHours}h`;
  if (diffDays < 7) return `in ${diffDays}d`;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
