import type { AuthStorage } from "@mariozechner/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROVIDER_FETCHERS } from "../providers/fetch.js";
import type { QuotasResult } from "../types/quotas.js";
import {
  isAccountScoped,
  setMultiProviderService,
  trackMultiProvider,
  type AccountContext,
} from "./multiprovider.js";
import { clearQuotaCache, fetchContextQuotas } from "./quotas.js";

const fetchers = PROVIDER_FETCHERS as Record<string, unknown>;
const original = { ...PROVIDER_FETCHERS };
const ok: QuotasResult = { success: true, data: { provider: "devin", windows: [] } };

const base = {
  get: (provider: string) => ({ type: "oauth", access: `upstream-${provider}` }),
  getApiKey: async (provider: string) => `upstream-${provider}`,
} as unknown as AuthStorage;
function context(provider: string): AccountContext {
  return {
    modelRegistry: { authStorage: base },
    model: { provider },
    sessionManager: {},
  } as unknown as AccountContext;
}
const ctx = context("openai-codex");

function jwt(accountId: string): string {
  const payload = Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
  ).toString("base64url");
  return `h.${payload}.s`;
}

// Fake pi-multiprovider: one pool, keyed by Pi provider id.
let pool = "openai-codex";
let active: { id: string; label: string } | undefined;
let onResolve: () => void = () => {};
const tokens: Record<string, string> = { work: jwt("work-acct"), home: jwt("home-acct") };
const changed = new Map<string, (event: { ctx?: never }) => void>();
beforeEach(() => {
  pool = "openai-codex";
  active = undefined;
  onResolve = () => {};
  setMultiProviderService({
    getActiveAccount: async (providerId) => (providerId === pool ? active : undefined),
    resolveActiveAccountAuth: async (providerId) => {
      if (providerId !== pool || !active) return undefined;
      const token = tokens[active.id];
      onResolve();
      return token ? { accessToken: token } : undefined;
    },
    onActiveAccountChanged: (providerId, callback) => {
      changed.set(providerId, callback);
      return () => changed.delete(providerId);
    },
  });
});

function recordKeys(provider: string, id = provider): Array<string | undefined> {
  const seen: Array<string | undefined> = [];
  fetchers[provider] = vi.fn(async (auth: AuthStorage) => {
    seen.push(await auth.getApiKey(id));
    return ok;
  });
  return seen;
}

afterEach(() => {
  Object.assign(fetchers, original);
  clearQuotaCache();
  setMultiProviderService(undefined);
});

describe("fetchContextQuotas with pi-multiprovider", () => {
  it("queries the active pooled account and caches per account", async () => {
    const seen: Array<[string | undefined, string | undefined]> = [];
    fetchers["openai-codex"] = vi.fn(async (auth: AuthStorage) => {
      seen.push([await auth.getApiKey("openai-codex"), (auth.get("openai-codex") as any)?.accountId]);
      return ok;
    });

    active = { id: "work", label: "Work" };
    const work = await fetchContextQuotas(ctx, "openai-codex");
    active = { id: "home", label: "Home" };
    const home = await fetchContextQuotas(ctx, "openai-codex");

    expect([work.account, work.accountId, home.account]).toEqual(["Work", "openai-codex:work", "Home"]);
    expect(seen).toEqual([
      [tokens.work, "work-acct"],
      [tokens.home, "home-acct"],
    ]);
  });

  it("does not pair one account's label with another's token", async () => {
    const seen = recordKeys("openai-codex");
    active = { id: "work", label: "Work" };
    onResolve = () => {
      onResolve = () => {};
      active = { id: "home", label: "Home" }; // /switch-account mid-lookup
    };
    const snapshot = await fetchContextQuotas(ctx, "openai-codex");
    expect(snapshot.account).toBe("Home");
    expect(seen).toEqual([tokens.home]);
  });

  it("uses Pi's own credential only for an identified upstream account", async () => {
    const seen = recordKeys("openai-codex");
    active = { id: "pi:default", label: "Pi default" };
    expect((await fetchContextQuotas(ctx, "openai-codex")).account).toBe("Pi default");
    active = undefined;
    const unknown = await fetchContextQuotas(ctx, "openai-codex");
    expect(unknown.result).toMatchObject({ success: false, error: { kind: "account_unknown" } });
    expect(seen).toEqual(["upstream-openai-codex"]);
  });

  it("pins aliases to the pooled provider id's credential", async () => {
    pool = "xai";
    active = { id: "pi:default", label: "Pi default" };
    const seen = recordKeys("grok"); // the Grok fetcher prefers "grok" over "xai"
    await fetchContextQuotas(context("xai"), "grok");
    expect(seen).toEqual(["upstream-xai"]);
  });

  it("finds alias pools regardless of the current model", async () => {
    pool = "google-antigravity";
    active = { id: "work", label: "Work" };
    const seen = recordKeys("antigravity");
    const snapshot = await fetchContextQuotas(context("devin"), "antigravity");
    expect(snapshot.account).toBe("Work");
    expect(seen).toEqual([tokens.work]);
  });

  it("fails closed when the account's credential cannot be resolved", async () => {
    const seen = recordKeys("openai-codex");
    active = { id: "broken", label: "Broken" };
    const snapshot = await fetchContextQuotas(ctx, "openai-codex");
    expect(snapshot.result).toMatchObject({ success: false, error: { kind: "config" } });
    expect(seen).toEqual([]);
  });

  it("reports unsupported per-account quotas instead of another account's", async () => {
    pool = "github-copilot";
    active = { id: "work", label: "Work" };
    const seen = recordKeys("github-copilot");
    const snapshot = await fetchContextQuotas(context("github-copilot"), "github-copilot");
    expect(snapshot.result).toMatchObject({ success: false, error: { kind: "not_applicable" } });
    expect(seen).toEqual([]);
  });

  it("leaves normal provider credentials alone when the service is absent", async () => {
    setMultiProviderService(undefined);
    const seen = recordKeys("devin");
    expect((await fetchContextQuotas(ctx, "devin")).account).toBeUndefined();
    expect(seen).toEqual(["upstream-devin"]);
  });

  it("keeps upstream accounts of different alias ids apart", async () => {
    active = { id: "pi:default", label: "Pi default" };
    const seen = recordKeys("grok");
    pool = "xai";
    const xai = await fetchContextQuotas(context("xai"), "grok");
    pool = "grok";
    const grok = await fetchContextQuotas(context("grok"), "grok");
    expect([xai.accountId, grok.accountId]).toEqual(["xai:pi:default", "grok:pi:default"]);
    expect(seen).toEqual(["upstream-xai", "upstream-grok"]);
  });

  it("fails closed when the account keeps changing", async () => {
    const seen = recordKeys("openai-codex");
    let flip = false;
    active = { id: "work", label: "Work" };
    onResolve = () => {
      flip = !flip;
      active = flip ? { id: "home", label: "Home" } : { id: "work", label: "Work" };
    };
    const snapshot = await fetchContextQuotas(ctx, "openai-codex");
    expect(snapshot.result).toMatchObject({ success: false, error: { kind: "network" } });
    expect(snapshot.accountId).toBeUndefined();
    expect(snapshot.account).toBeUndefined();
    expect(seen).toEqual([]);
  });

  it("marks only pooled accounts as scoped, disabling ambient fallbacks", async () => {
    const scoped: boolean[] = [];
    fetchers["openai-codex"] = vi.fn(async (auth: AuthStorage) => {
      scoped.push(isAccountScoped(auth));
      return ok;
    });
    active = { id: "work", label: "Work" };
    await fetchContextQuotas(ctx, "openai-codex");
    active = { id: "pi:default", label: "Pi default" };
    await fetchContextQuotas(ctx, "openai-codex");
    expect(scoped).toEqual([true, false]);
  });

  it("notifies listeners when a followed account changes", async () => {
    const pi = { events: { on: () => () => {} } } as never;
    const onChange = vi.fn();
    const stop = trackMultiProvider(pi, onChange);
    recordKeys("openai-codex");
    await fetchContextQuotas(ctx, "openai-codex"); // starts following openai-codex
    changed.get("openai-codex")?.({});
    stop();
    changed.get("openai-codex")?.({});
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
