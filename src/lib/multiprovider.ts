import type {
  AuthStorage,
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";

/**
 * pi-multiprovider announces an in-process service on this event so sibling
 * extensions can follow the session's active pooled account. Duck-typed here
 * so pi-quotas keeps working (and type-checks) without pi-multiprovider.
 */
export const MULTIPROVIDER_SERVICE_EVENT = "pi-multiprovider:service";
/** pi-multiprovider's id for Pi's own /login credential in a pool. */
const UPSTREAM_ACCOUNT_ID = "pi:default";

export type AccountContext = Pick<
  ExtensionContext,
  "modelRegistry" | "model" | "sessionManager"
>;

type ActiveAccount = { id: string; label: string };

interface MultiProviderService {
  /** True: pooled; false: unpooled; undefined: initializing/reconciling. */
  hasPool?(providerId: string): boolean | undefined;
  getActiveAccount(
    providerId: string,
    ctx: AccountContext,
  ): Promise<ActiveAccount | undefined>;
  resolveActiveAccountAuth(
    providerId: string,
    ctx: AccountContext,
    signal?: AbortSignal,
  ): Promise<{ accessToken: string; accountId?: string; label?: string } | undefined>;
  onActiveAccountChanged?(
    providerId: string,
    callback: (event: { ctx?: ExtensionContext }) => void,
  ): () => void;
}

type ChangeListener = (ctx?: ExtensionContext, providerId?: string, replaced?: boolean) => void;

let service: MultiProviderService | undefined;
const revisions = new Map<string, number>();
/** Retry selection; distinct from a stable service with no selected account. */
export const ACCOUNT_SELECTION_CHANGED = Symbol("account-selection-changed");
export const ACCOUNT_SERVICE_PENDING = Symbol("account-service-pending");
const listeners = new Set<ChangeListener>();
// Provider ids we already follow on the current service.
const followed = new Map<string, () => void>();

function setService(next: MultiProviderService | undefined): void {
  const replaced = next !== service;
  if (replaced) {
    for (const unsubscribe of followed.values()) unsubscribe();
    followed.clear();
    revisions.clear();
    service = next;
  }
  // Same-object announcements bracket reconciliation, not just factory load.
  for (const id of followed.keys()) revisions.set(id, (revisions.get(id) ?? 0) + 1);
  for (const listener of listeners) listener(undefined, undefined, replaced);
}

/** Follow the pooled account of `providerId`, so switches repaint quotas. */
function follow(providerId: string): void {
  if (!service?.onActiveAccountChanged || followed.has(providerId)) return;
  followed.set(
    providerId,
    service.onActiveAccountChanged(providerId, (event) => {
      revisions.set(providerId, (revisions.get(providerId) ?? 0) + 1);
      for (const listener of listeners) listener(event?.ctx, providerId);
    }),
  );
}

/**
 * Track pi-multiprovider's service. `onChange` fires when the service
 * appears, is re-announced after reconciliation, and when a followed provider's
 * active account changes (/switch-account, or a pin restored on resume).
 */
export function trackMultiProvider(
  pi: ExtensionAPI,
  onChange?: ChangeListener,
): () => void {
  if (onChange) listeners.add(onChange);
  const off = pi.events.on(MULTIPROVIDER_SERVICE_EVENT, (value: any) => {
    if (
      typeof value?.getActiveAccount === "function" &&
      typeof value?.resolveActiveAccountAuth === "function"
    ) {
      setService(value);
    }
  });
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    off();
    if (onChange) listeners.delete(onChange);
    // Pi loads each extension in its own module graph; this tracker owns it.
    setService(undefined);
  };
}

/** Test hook. */
export function setMultiProviderService(
  next: MultiProviderService | undefined,
): void {
  setService(next);
}

export type QuotaAccount = {
  /** Account label shown next to the quota. */
  label: string;
  /** Stable "<pi provider id>:<account id>" key for caches and alert state. */
  id: string;
  /** Pi's own /login credential (the pool's upstream account). */
  upstream: boolean;
  /** Resolve only on a quota cache miss; null means selection changed, undefined means auth failed. */
  resolveAuth(signal?: AbortSignal): Promise<AuthStorage | null | undefined>;
};

const ACCOUNT_SCOPED = Symbol("pi-quotas:account-scoped");

/**
 * Whether `authStorage` serves a pooled (non-upstream) account. Fetchers must
 * then skip ambient fallbacks (env cookies, CLI configs) that could belong to
 * a different account.
 */
export function isAccountScoped(authStorage: AuthStorage): boolean {
  return (authStorage as unknown as Record<symbol, unknown>)[ACCOUNT_SCOPED] === true;
}

/** Codex quota calls need the ChatGPT account id; pi-ai reads it from the JWT. */
function codexAccountId(token: string): string | undefined {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"),
    );
    const id = payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
    return typeof id === "string" ? id : undefined;
  } catch {
    return undefined;
  }
}

/** Auth storage answering every id in `ids` with one account's credential. */
function scopedAuthStorage(
  base: AuthStorage,
  ids: string[],
  credential: unknown,
  apiKey: () => Promise<string | undefined>,
  pooled = false,
): AuthStorage {
  return {
    [ACCOUNT_SCOPED]: pooled,
    get: (provider: string) =>
      ids.includes(provider) ? credential : base.get(provider),
    getApiKey: (provider: string) =>
      ids.includes(provider) ? apiKey() : base.getApiKey(provider),
  } as unknown as AuthStorage;
}

/**
 * Select an account without resolving credentials (or taking the auth-store lock).
 * Undefined means no service or confirmed no pool across all aliases.
 * Null means the service cannot identify an account; older services cannot
 * distinguish that from a provider with no pool.
 * ACCOUNT_SELECTION_CHANGED asks the caller to retry, not infer an absent pool.
 * ACCOUNT_SERVICE_PENDING denotes transient reconciliation, not a lost selection.
 */
export async function quotaAccount(
  ctx: AccountContext,
  ids: string[],
  base: AuthStorage,
  signal?: AbortSignal,
): Promise<QuotaAccount | null | undefined | typeof ACCOUNT_SELECTION_CHANGED | typeof ACCOUNT_SERVICE_PENDING> {
  const currentService = service;
  if (!currentService) return undefined;
  let currentProvider: string | undefined;
  try { currentProvider = ctx.model?.provider; } catch { /* stale context: probe aliases */ }
  let unpooled = true;
  for (const id of ids) {
    if (signal?.aborted) return null;
    if (currentService !== service) return ACCOUNT_SELECTION_CHANGED;
    follow(id);
    const pooled = currentService.hasPool?.(id);
    if (currentService.hasPool && pooled === undefined) return ACCOUNT_SERVICE_PENDING;
    if (pooled === false) {
      if (id === currentProvider) return undefined;
      continue;
    }
    // A missing capability is unknown, never proof that Pi's login is in use.
    unpooled = false;
    const selectedRevision = revisions.get(id);
    const account = await currentService.getActiveAccount(id, ctx);
    if (currentService !== service || selectedRevision !== revisions.get(id)) return ACCOUNT_SELECTION_CHANGED;
    if (!account) {
      if (pooled === true && id === currentProvider) return null;
      continue;
    }
    const upstream = account.id === UPSTREAM_ACCOUNT_ID;
    return {
      label: account.label,
      id: `${id}:${account.id}`,
      upstream,
      async resolveAuth(signal) {
        if (signal?.aborted || currentService !== service || selectedRevision !== revisions.get(id)) return null;
        if (upstream) {
          // Pin aliases to this provider's own upstream credential.
          return scopedAuthStorage(base, ids, base.get(id), () => base.getApiKey(id));
        }
        const auth = await currentService.resolveActiveAccountAuth(id, ctx, signal).catch(() => undefined);
        const now = await currentService.getActiveAccount(id, ctx).catch(() => undefined);
        if (
          signal?.aborted || currentService !== service || selectedRevision !== revisions.get(id) ||
          !now || now.id !== account.id ||
          (auth?.accountId !== undefined && auth.accountId !== now.id) ||
          (auth?.label !== undefined && auth.label !== now.label)
        ) return null;
        const token = auth?.accessToken;
        if (!token) return undefined;
        // ponytail: older services without accountId cannot prove identity
        // across unannounced A→B→A switches between identically named accounts.
        return scopedAuthStorage(base, ids, {
          type: "oauth",
          access: token,
          key: token,
          accountId: codexAccountId(token),
        }, async () => token, true);
      },
    };
  }
  return unpooled ? undefined : null;
}
