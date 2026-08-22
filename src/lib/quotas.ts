import type { AuthStorage } from "@mariozechner/pi-coding-agent";
import { PROVIDER_FETCHERS } from "../providers/fetch.js";
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
};

const ERROR_TTL_MS = 10_000;

type CacheEntry = {
  result?: QuotasResult;
  fetchedAt?: number;
  inFlight?: Promise<QuotasResult>;
};

const cache = new Map<SupportedQuotaProvider, CacheEntry>();

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
  if (provider) cache.delete(provider);
  else cache.clear();
}

export async function fetchProviderQuotas(
  authStorage: AuthStorage,
  rawProvider: SupportedQuotaProvider | string,
  options?: { force?: boolean; signal?: AbortSignal },
): Promise<QuotasResult> {
  const provider =
    normalizeQuotaProvider(rawProvider) ??
    (rawProvider as SupportedQuotaProvider);
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
  if (!options?.force && entry.inFlight) return entry.inFlight;

  const promise = PROVIDER_FETCHERS[provider](authStorage, options?.signal)
    .then((result: QuotasResult) => {
      cache.set(provider, { result, fetchedAt: Date.now() });
      return result;
    })
    .finally(() => {
      const current = cache.get(provider) ?? {};
      delete current.inFlight;
      cache.set(provider, current);
    });

  cache.set(provider, { ...entry, inFlight: promise });
  return promise;
}

export async function fetchAllProviderQuotas(
  authStorage: AuthStorage,
  options?: { force?: boolean; signal?: AbortSignal },
): Promise<Array<{ provider: SupportedQuotaProvider; result: QuotasResult }>> {
  return Promise.all(
    SUPPORTED_PROVIDERS.map(async (provider) => ({
      provider,
      result: await fetchProviderQuotas(authStorage, provider, options),
    })),
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
