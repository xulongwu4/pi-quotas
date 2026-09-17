import type { AuthStorage } from "@mariozechner/pi-coding-agent";
import { cancelledError, PROVIDER_FETCHERS } from "../providers/fetch.js";
import type { QuotasResult, SupportedQuotaProvider } from "../types/quotas.js";

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
};

const ERROR_TTL_MS = 10_000;

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

const cache = new Map<SupportedQuotaProvider, CacheEntry>();

function evictInFlight(
  provider: SupportedQuotaProvider,
  fetch: InFlightFetch,
): void {
  const current = cache.get(provider);
  if (current?.inFlight !== fetch) return;
  delete current.inFlight;
  cache.set(provider, current);
}

function releaseIfUnused(
  provider: SupportedQuotaProvider,
  fetch: InFlightFetch,
): void {
  if (fetch.waiters !== 0 || fetch.settled) return;
  evictInFlight(provider, fetch);
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
  if (provider) {
    cache.get(provider)?.inFlight?.controller.abort();
    cache.delete(provider);
    return;
  }
  for (const entry of cache.values()) entry.inFlight?.controller.abort();
  cache.clear();
}

function cancelledResult(): QuotasResult {
  return { success: false, error: cancelledError() };
}

/** Wait on a shared fetch. A caller abort releases only its waiter;
 * the HTTP request is aborted when no consumers remain. */
function waitForFetch(
  provider: SupportedQuotaProvider,
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
      releaseIfUnused(provider, fetch);
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
  options?: { force?: boolean; signal?: AbortSignal },
): Promise<QuotasResult> {
  const provider =
    normalizeQuotaProvider(rawProvider) ??
    (rawProvider as SupportedQuotaProvider);
  // Cancellation wins before cache lookup or network kickoff: an already-
  // aborted caller must not start an unobserved background request.
  if (options?.signal?.aborted) return cancelledResult();
  const entry = cache.get(provider) ?? {};
  const now = Date.now();
  const ttl =
    entry.result && !entry.result.success
      ? ERROR_TTL_MS
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
    return waitForFetch(provider, entry.inFlight, options?.signal);
  }

  const controller = new AbortController();
  const inFlight = {
    controller,
    waiters: 0,
    settled: false,
  } as InFlightFetch;
  inFlight.promise = PROVIDER_FETCHERS[provider](authStorage, controller.signal)
    .then((result: QuotasResult) => {
      const current = cache.get(provider);
      // Only the current, still-observed fetch may populate the cache; an
      // aborted/replaced fetch cannot overwrite its successor.
      if (current?.inFlight === inFlight && !controller.signal.aborted) {
        cache.set(provider, {
          ...current,
          result,
          fetchedAt: Date.now(),
        });
      }
      return result;
    })
    .finally(() => {
      inFlight.settled = true;
      evictInFlight(provider, inFlight);
    });

  cache.set(provider, { ...entry, inFlight });
  // A caller may abort before the shared promise settles; keep its rejection
  // handled independently of any individual waiter.
  inFlight.promise.catch(() => {});
  return waitForFetch(provider, inFlight, options?.signal);
}

export async function fetchAllProviderQuotas(
  authStorage: AuthStorage,
  options?: {
    force?: boolean;
    signal?: AbortSignal;
    /** Called with each snapshot as it resolves, so UIs can render
     * incrementally instead of waiting for the slowest provider. */
    onSnapshot?: (snapshot: {
      provider: SupportedQuotaProvider;
      result: QuotasResult;
    }) => void;
  },
): Promise<Array<{ provider: SupportedQuotaProvider; result: QuotasResult }>> {
  const { force, signal, onSnapshot } = options ?? {};
  // Promise.all preserves SUPPORTED_PROVIDERS order in the return value;
  // onSnapshot still fires in completion order for incremental rendering.
  return Promise.all(
    SUPPORTED_PROVIDERS.map(async (provider) => {
      const snapshot = {
        provider,
        result: await fetchProviderQuotas(authStorage, provider, {
          force,
          signal,
        }),
      };
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
