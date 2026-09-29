import type { AuthStorage } from "@mariozechner/pi-coding-agent";
import { cancelledError, PROVIDER_FETCHERS } from "../providers/fetch.js";
import type { QuotaSnapshot, QuotasResult, SupportedQuotaProvider } from "../types/quotas.js";
import { quotaAuthStorage } from "./auth.js";
import { quotaAccount, type AccountContext } from "./multiprovider.js";

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

export async function fetchProviderQuotas(
  authStorage: AuthStorage,
  rawProvider: SupportedQuotaProvider | string,
  options?: {
    force?: boolean;
    signal?: AbortSignal;
    /** pi-multiprovider account id; keeps per-account results apart. */
    account?: string;
  },
): Promise<QuotasResult> {
  const provider =
    normalizeQuotaProvider(rawProvider) ??
    (rawProvider as SupportedQuotaProvider);
  // Cancellation wins before cache lookup or network kickoff: an already-
  // aborted caller must not start an unobserved background request.
  if (options?.signal?.aborted) return cancelledResult();
  const key = options?.account ? `${provider}@${options.account}` : provider;
  const entry = cache.get(key) ?? {};
  const now = Date.now();
  const ttl = !entry.result?.success
    ? entry.result?.error.kind === "rate_limit"
      ? RATE_LIMIT_TTL_MS
      : ERROR_TTL_MS
    : PROVIDER_TTLS_MS[provider];

  if (
    !options?.force &&
    entry.result &&
    entry.fetchedAt &&
    now - entry.fetchedAt < ttl
  ) {
    return entry.result;
  }
  // Any in-flight fetch is fresher than the cache, so force refreshes join
  // it too. If its final waiter already aborted, start a fresh request.
  if (entry.inFlight) {
    return waitForFetch(key, entry.inFlight, options?.signal);
  }

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
 * Synthetic reads only SYNTHETIC_API_KEY, and Copilot quotas need the GitHub
 * OAuth token pi-multiprovider does not expose (then fall back to `gh`).
 */
const NO_ACCOUNT_QUOTAS = new Set<SupportedQuotaProvider>(["synthetic", "github-copilot"]);

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
 * Quotas for the account the session actually uses: the active
 * pi-multiprovider account when one is known, else Pi's own credential.
 */
export async function fetchContextQuotas(
  ctx: AccountContext,
  provider: SupportedQuotaProvider,
  options?: { force?: boolean; signal?: AbortSignal },
): Promise<QuotaSnapshot> {
  const base = quotaAuthStorage(ctx.modelRegistry);
  const account = await quotaAccount(ctx, piProviderIds(ctx, provider), base, options?.signal);
  if (!account) {
    return { provider, result: await fetchProviderQuotas(base, provider, options) };
  }
  const snapshot = { provider, account: account.label, accountId: account.id };
  // Fail closed: fetcher fallbacks (env keys, CLI logins) could otherwise
  // report another account's quota under this account's label.
  if (!account.authStorage) {
    return {
      ...snapshot,
      result: {
        success: false,
        error: { message: `Could not resolve credentials for account ${account.label}`, kind: "config" },
      },
    };
  }
  if (NO_ACCOUNT_QUOTAS.has(provider) && !account.upstream) {
    return {
      ...snapshot,
      result: {
        success: false,
        error: { message: "Per-account quotas are not available for pooled accounts", kind: "not_applicable" },
      },
    };
  }
  const result = await fetchProviderQuotas(account.authStorage, provider, {
    ...options,
    account: account.id,
  });
  return { ...snapshot, result };
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
