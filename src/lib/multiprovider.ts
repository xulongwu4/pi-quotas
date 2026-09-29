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
  getActiveAccount(
    providerId: string,
    ctx: AccountContext,
  ): Promise<ActiveAccount | undefined>;
  resolveActiveAccountAuth(
    providerId: string,
    ctx: AccountContext,
    signal?: AbortSignal,
  ): Promise<{ accessToken: string } | undefined>;
  onActiveAccountChanged?(
    providerId: string,
    callback: (event: { ctx?: ExtensionContext }) => void,
  ): () => void;
}

type ChangeListener = (ctx?: ExtensionContext) => void;

let service: MultiProviderService | undefined;
const listeners = new Set<ChangeListener>();
// Provider ids we already follow on the current service.
const followed = new Map<string, () => void>();

function setService(next: MultiProviderService | undefined): void {
  if (next === service) return; // re-announced on every session start
  for (const unsubscribe of followed.values()) unsubscribe();
  followed.clear();
  service = next;
  for (const listener of listeners) listener();
}

/** Follow the pooled account of `providerId`, so switches repaint quotas. */
function follow(providerId: string): void {
  if (!service?.onActiveAccountChanged || followed.has(providerId)) return;
  followed.set(
    providerId,
    service.onActiveAccountChanged(providerId, (event) => {
      for (const listener of listeners) listener(event?.ctx);
    }),
  );
}

/**
 * Track pi-multiprovider's service. `onChange` fires when the service
 * appears and when a followed provider's active account changes
 * (/switch-account, or a pin restored on resume).
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
  return () => {
    off();
    if (onChange) listeners.delete(onChange);
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
  /** Undefined when the account's credential could not be resolved. */
  authStorage?: AuthStorage;
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

/** Retries when the active account changes mid-lookup. */
const MAX_LOOKUPS = 3;

/**
 * The pi-multiprovider account the session uses for one quota provider,
 * probing `ids` (the Pi provider ids its fetcher reads) in order. Undefined
 * when pi-multiprovider is absent or has not picked an account yet; callers
 * then use Pi's own credential, as before.
 */
export async function quotaAccount(
  ctx: AccountContext,
  ids: string[],
  base: AuthStorage,
  signal?: AbortSignal,
): Promise<QuotaAccount | undefined> {
  for (const id of ids) {
    if (!service || signal?.aborted) return undefined;
    follow(id);
    const lookup = () => service?.getActiveAccount(id, ctx).catch(() => undefined);
    let account = await lookup();
    if (!account) continue;
    const key = (account: ActiveAccount) => `${id}:${account.id}`;
    if (account.id === UPSTREAM_ACCOUNT_ID) {
      // Pin every alias to this id's own credential, so a fetcher that
      // prefers another alias (grok over xai) cannot read a different account.
      return {
        label: account.label,
        id: key(account),
        upstream: true,
        authStorage: scopedAuthStorage(base, ids, base.get(id), () =>
          base.getApiKey(id),
        ),
      };
    }
    // The two service calls select independently, so re-read the account
    // after resolving: a switch in between would pair one account's label
    // with another's token.
    // ponytail: an A→B→A switch inside one resolve still slips through; an
    // atomic id+token resolver in pi-multiprovider would close it.
    for (let attempt = 0; attempt < MAX_LOOKUPS && !signal?.aborted; attempt++) {
      const token = (
        await service.resolveActiveAccountAuth(id, ctx, signal).catch(() => undefined)
      )?.accessToken;
      const now = await lookup();
      if (!now) return undefined; // back to automatic selection
      if (now.id !== account.id) {
        account = now;
        continue;
      }
      if (now.id === UPSTREAM_ACCOUNT_ID) return quotaAccount(ctx, ids, base, signal);
      if (!token) break;
      const credential = {
        type: "oauth",
        access: token,
        key: token,
        accountId: codexAccountId(token),
      };
      return {
        label: account.label,
        id: key(account),
        upstream: false,
        authStorage: scopedAuthStorage(base, ids, credential, async () => token, true),
      };
    }
    // Unresolvable or unstable: report the account without credentials so
    // callers fail closed instead of querying some other account.
    return { label: account.label, id: key(account), upstream: false };
  }
  return undefined;
}
