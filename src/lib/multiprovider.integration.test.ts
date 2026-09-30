import type { AuthStorage } from "@mariozechner/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { quotaAccount, setMultiProviderService, trackMultiProvider, type AccountContext } from "./multiprovider.js";
import { clearQuotaCache, fetchContextQuotas } from "./quotas.js";

const base = {
  get: vi.fn(() => ({ type: "oauth", access: "unrelated-token", accountId: "unrelated-id" })),
  getApiKey: vi.fn(async () => "unrelated-token"),
} as unknown as AuthStorage;
const ctx = (provider: string) => ({
  modelRegistry: { authStorage: base },
  model: { provider },
  sessionManager: {},
}) as unknown as AccountContext;

function installPool(provider: string, token = "pooled-token") {
  let active: { id: string; label: string } | undefined = { id: "work", label: "Work" };
  const getActiveAccount = vi.fn(async (id: string) => id === provider ? active : undefined);
  const resolveActiveAccountAuth = vi.fn(async () => ({ accessToken: token, label: active?.label ?? "" }));
  setMultiProviderService({ getActiveAccount, resolveActiveAccountAuth });
  return { getActiveAccount, resolveActiveAccountAuth, select: (next: typeof active) => { active = next; } };
}

beforeEach(() => {
  clearQuotaCache();
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ five_hour: { utilization: 25 } })));
});

afterEach(() => {
  setMultiProviderService(undefined);
  clearQuotaCache();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("pooled quota credential isolation", () => {
  it("uses the pooled Codex JWT for both Authorization and account id", async () => {
    const token = "h." + Buffer.from(JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: "work-id" },
    })).toString("base64url") + ".s";
    installPool("openai-codex", token);
    const snapshot = await fetchContextQuotas(ctx("openai-codex"), "openai-codex");
    expect(snapshot).toMatchObject({ account: "Work", accountId: "openai-codex:work" });
    expect(fetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      headers: expect.objectContaining({
        Authorization: "Bearer " + token,
        "ChatGPT-Account-Id": "work-id",
      }),
    }));
    expect(base.get).not.toHaveBeenCalled();
    expect(base.getApiKey).not.toHaveBeenCalled();
  });

  it("does not borrow a Codex CLI account id for a pooled token without one", async () => {
    installPool("openai-codex");
    const snapshot = await fetchContextQuotas(ctx("openai-codex"), "openai-codex");
    expect(snapshot.result).toMatchObject({ success: false, error: { kind: "config" } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("queries Synthetic with the pooled key instead of the environment key", async () => {
    vi.stubEnv("SYNTHETIC_API_KEY", "unrelated-env-key");
    installPool("synthetic");
    const snapshot = await fetchContextQuotas(ctx("synthetic"), "synthetic");
    expect(snapshot).toMatchObject({ account: "Work", result: { success: true } });
    expect(fetch).toHaveBeenCalledWith("https://api.synthetic.new/v2/quotas", expect.objectContaining({
      headers: { Authorization: "Bearer pooled-token" },
    }));
  });

  it("does not send an ambient Antigravity project with pooled credentials", async () => {
    vi.stubEnv("ANTIGRAVITY_PROJECT_ID", "unrelated-project");
    installPool("antigravity");
    await fetchContextQuotas(ctx("antigravity"), "antigravity");
    const calls = vi.mocked(fetch).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[1][1]?.body).toBe("{}");
  });

  it("does not fall back to a Cursor dashboard cookie after pooled auth fails", async () => {
    vi.stubEnv("CURSOR_USAGE_SESSION_TOKEN", "unrelated-cookie");
    vi.mocked(fetch).mockImplementation(async () => new Response("", { status: 401 }));
    installPool("cursor");
    const snapshot = await fetchContextQuotas(ctx("cursor"), "cursor");
    expect(snapshot).toMatchObject({ account: "Work", result: { success: false } });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(vi.mocked(fetch).mock.calls)).not.toContain("unrelated-cookie");
  });

  it("keeps OpenCode Go environment cookies out of pooled requests", async () => {
    vi.stubEnv("OPENCODE_GO_AUTH_COOKIE", "unrelated-cookie");
    vi.stubEnv("OPENCODE_API_KEY", "unrelated-key");
    installPool("opencode-go");
    await fetchContextQuotas(ctx("opencode-go"), "opencode-go");
    expect(fetch).toHaveBeenCalledTimes(1);
    const headers = vi.mocked(fetch).mock.calls[0][1]?.headers;
    expect(headers).toMatchObject({ Authorization: "Bearer pooled-token" });
    expect(headers).not.toHaveProperty("Cookie");
  });

  it("fails closed when active-account lookup throws", async () => {
    const pool = installPool("anthropic");
    pool.getActiveAccount.mockRejectedValue(new Error("service unavailable"));
    const snapshot = await fetchContextQuotas(ctx("anthropic"), "anthropic");
    expect(snapshot.result.success).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect(base.getApiKey).not.toHaveBeenCalled();
  });

  it("does not fall back to upstream when the active account disappears during resolution", async () => {
    const pool = installPool("anthropic");
    pool.resolveActiveAccountAuth.mockImplementationOnce(async () => {
      pool.select(undefined);
      return { accessToken: "pooled-token", label: "Work" };
    });
    const snapshot = await fetchContextQuotas(ctx("anthropic"), "anthropic");
    expect(snapshot.result.success).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a resolver label belonging to another account even if the id changed back", async () => {
    const pool = installPool("anthropic");
    pool.resolveActiveAccountAuth.mockResolvedValue({ accessToken: "home-token", label: "Home" });
    const snapshot = await fetchContextQuotas(ctx("anthropic"), "anthropic");
    expect(snapshot.result.success).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect(pool.resolveActiveAccountAuth.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it("keeps simultaneous requests for different account ids separate, even with duplicate labels", async () => {
    const pool = installPool("anthropic");
    let finish!: (response: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const first = fetchContextQuotas(ctx("anthropic"), "anthropic");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    pool.select({ id: "home", label: "Work" });
    pool.resolveActiveAccountAuth.mockResolvedValue({ accessToken: "home-token", label: "Work" });
    const second = await fetchContextQuotas(ctx("anthropic"), "anthropic");
    finish(Response.json({ five_hour: { utilization: 80 } }));
    const previous = await first;
    expect(previous.accountId).not.toBe(second.accountId);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(second.result).toMatchObject({ success: true, data: { windows: [{ usedPercent: 25 }] } });
    expect(previous.result).toMatchObject({ success: true, data: { windows: [{ usedPercent: 80 }] } });
  });

  it("ignores tokens resolved across an announced switch away and back with duplicate labels", async () => {
    let notify!: (event: { ctx?: never }) => void;
    const resolve = vi.fn(async () => ({ accessToken: "work-token", label: "Work" }));
    resolve.mockImplementationOnce(async () => {
      notify({});
      notify({});
      return { accessToken: "home-token", label: "Work" };
    });
    setMultiProviderService({
      getActiveAccount: async () => ({ id: "work", label: "Work" }),
      resolveActiveAccountAuth: resolve,
      onActiveAccountChanged: (_id, callback) => { notify = callback; return () => {}; },
    });
    await fetchContextQuotas(ctx("anthropic"), "anthropic");
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer work-token" }),
    }));
  });

  it("releases its service subscriptions on extension shutdown", async () => {
    const unsubscribe = vi.fn();
    const pool = installPool("anthropic");
    setMultiProviderService({
      getActiveAccount: pool.getActiveAccount,
      resolveActiveAccountAuth: pool.resolveActiveAccountAuth,
      onActiveAccountChanged: () => unsubscribe,
    });
    const pi = { events: { on: () => () => {} } } as never;
    const stop = trackMultiProvider(pi);
    await quotaAccount(ctx("anthropic"), ["anthropic"], base);
    stop();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(await quotaAccount(ctx("anthropic"), ["anthropic"], base)).toBeUndefined();
    stop(); // cleanup is idempotent
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("sanitizes account labels before rendering them in terminal UI", async () => {
    const pool = installPool("anthropic");
    pool.select({ id: "work", label: "\u001b[31mWork\u001b[0m\nTeam" });
    const snapshot = await fetchContextQuotas(ctx("anthropic"), "anthropic");
    expect(snapshot.account).toBe("Work Team");
  });

  it("serves a warm account cache without resolving credentials again", async () => {
    const pool = installPool("anthropic");
    const first = await fetchContextQuotas(ctx("anthropic"), "anthropic");
    pool.resolveActiveAccountAuth.mockRejectedValue(new Error("auth store locked"));
    expect(await fetchContextQuotas(ctx("anthropic"), "anthropic")).toEqual(first);
    expect(pool.getActiveAccount.mock.calls.length).toBeGreaterThan(1);
    expect(pool.resolveActiveAccountAuth).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("joins an account's in-flight quota request without re-resolving credentials", async () => {
    const pool = installPool("anthropic");
    let finish!: (response: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const first = fetchContextQuotas(ctx("anthropic"), "anthropic");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const second = fetchContextQuotas(ctx("anthropic"), "anthropic", { force: true });
    finish(Response.json({ five_hour: { utilization: 80 } }));
    expect(await second).toEqual(await first);
    expect(pool.resolveActiveAccountAuth).toHaveBeenCalledTimes(1);
  });

  it("refreshes credentials on a forced refresh but retains the warm cache on auth failure", async () => {
    const pool = installPool("anthropic");
    const first = await fetchContextQuotas(ctx("anthropic"), "anthropic");
    pool.resolveActiveAccountAuth.mockRejectedValue(new Error("auth store locked"));
    const forced = await fetchContextQuotas(ctx("anthropic"), "anthropic", { force: true });
    expect(forced.result.success).toBe(false);
    expect(pool.resolveActiveAccountAuth).toHaveBeenCalledTimes(2);
    expect(await fetchContextQuotas(ctx("anthropic"), "anthropic")).toEqual(first);
    expect(pool.resolveActiveAccountAuth).toHaveBeenCalledTimes(2);
  });

  it("refreshes expired account cache entries", async () => {
    vi.useFakeTimers();
    try {
      const pool = installPool("anthropic");
      await fetchContextQuotas(ctx("anthropic"), "anthropic");
      vi.advanceTimersByTime(60_001);
      await fetchContextQuotas(ctx("anthropic"), "anthropic");
      expect(pool.resolveActiveAccountAuth).toHaveBeenCalledTimes(2);
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never fetches or serves default quotas when the service has no selection", async () => {
    const baseline = await fetchContextQuotas(ctx("anthropic"), "anthropic");
    expect(baseline.result.success).toBe(true);
    const pool = installPool("anthropic");
    pool.select(undefined);
    vi.mocked(fetch).mockClear();
    vi.mocked(base.getApiKey).mockClear();
    const unknown = await fetchContextQuotas(ctx("anthropic"), "anthropic");
    expect(unknown).toMatchObject({ result: { success: false, error: { kind: "account_unknown" } } });
    expect(unknown.account).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
    expect(base.getApiKey).not.toHaveBeenCalled();
    expect(pool.resolveActiveAccountAuth).not.toHaveBeenCalled();
  });

  it("reports unsupported pooled Copilot before credential resolution", async () => {
    const pool = installPool("github-copilot");
    pool.resolveActiveAccountAuth.mockRejectedValue(new Error("must not resolve"));
    const snapshot = await fetchContextQuotas(ctx("github-copilot"), "github-copilot");
    expect(snapshot).toMatchObject({ account: "Work", result: { success: false, error: { kind: "not_applicable" } } });
    expect(pool.resolveActiveAccountAuth).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("still queries upstream Copilot quotas with the stored GitHub OAuth token", async () => {
    const pool = installPool("github-copilot");
    pool.select({ id: "pi:default", label: "Pi default" });
    vi.mocked(base.get).mockReturnValueOnce({ type: "oauth", refresh: "github-oauth", access: "proxy-token" } as never);
    const snapshot = await fetchContextQuotas(ctx("github-copilot"), "github-copilot");
    expect(snapshot).toMatchObject({ account: "Pi default", result: { success: true } });
    expect(pool.resolveActiveAccountAuth).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer github-oauth" }),
    }));
  });

  it("can find alias pools when the model context getter is stale", async () => {
    const pool = installPool("google-antigravity");
    const context = ctx("google-antigravity");
    Object.defineProperty(context, "model", { get() { throw new Error("stale context"); } });
    const snapshot = await fetchContextQuotas(context, "antigravity");
    expect(snapshot.accountId).toBe("google-antigravity:work");
    expect(pool.resolveActiveAccountAuth).toHaveBeenCalledTimes(1);
  });

  it("checks the new account's warm cache after a switch during credential resolution", async () => {
    const pool = installPool("anthropic");
    pool.select({ id: "home", label: "Home" });
    const home = await fetchContextQuotas(ctx("anthropic"), "anthropic");
    pool.select({ id: "work", label: "Work" });
    pool.resolveActiveAccountAuth.mockImplementationOnce(async () => {
      pool.select({ id: "home", label: "Home" });
      return { accessToken: "work-token", label: "Work" };
    });
    expect(await fetchContextQuotas(ctx("anthropic"), "anthropic")).toEqual(home);
    expect(pool.resolveActiveAccountAuth).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not fall back to default credentials when the service disappears mid-resolution", async () => {
    const pool = installPool("anthropic");
    pool.resolveActiveAccountAuth.mockImplementationOnce(async () => {
      setMultiProviderService(undefined);
      return { accessToken: "pooled-token", label: "Work" };
    });
    const snapshot = await fetchContextQuotas(ctx("anthropic"), "anthropic");
    expect(snapshot.result.success).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect(base.getApiKey).not.toHaveBeenCalled();
  });

  it("cancels one account cache waiter without cancelling another", async () => {
    const pool = installPool("anthropic");
    let finish!: (response: Response) => void;
    let providerSignal: AbortSignal | undefined;
    vi.mocked(fetch).mockImplementationOnce((_url, options) => new Promise(resolve => {
      finish = resolve;
      providerSignal = options?.signal ?? undefined;
    }));
    const controller = new AbortController();
    const first = fetchContextQuotas(ctx("anthropic"), "anthropic", { signal: controller.signal });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const second = fetchContextQuotas(ctx("anthropic"), "anthropic");
    // Let the second caller finish identity lookup and join the shared fetch.
    await new Promise(resolve => setTimeout(resolve, 0));
    controller.abort();
    expect((await first).result).toMatchObject({ success: false, error: { kind: "cancelled" } });
    expect(providerSignal?.aborted).toBe(false);
    finish(Response.json({ five_hour: { utilization: 25 } }));
    expect((await second).result.success).toBe(true);
    expect(pool.resolveActiveAccountAuth).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not resolve or serve a warm cache for an already-cancelled caller", async () => {
    const pool = installPool("anthropic");
    await fetchContextQuotas(ctx("anthropic"), "anthropic");
    const controller = new AbortController();
    controller.abort();
    const snapshot = await fetchContextQuotas(ctx("anthropic"), "anthropic", { signal: controller.signal });
    expect(snapshot.result).toMatchObject({ success: false, error: { kind: "cancelled" } });
    expect(pool.resolveActiveAccountAuth).toHaveBeenCalledTimes(1);
  });

  it("does not retry Anthropic credentials when another provider switches", async () => {
    const callbacks = new Map<string, (event: { ctx?: never }) => void>();
    const resolve = vi.fn(async () => {
      callbacks.get("devin")?.({});
      return { accessToken: "work-token", label: "Work" };
    });
    setMultiProviderService({
      getActiveAccount: async id => id === "anthropic" ? { id: "work", label: "Work" } : undefined,
      resolveActiveAccountAuth: resolve,
      onActiveAccountChanged: (id, cb) => { callbacks.set(id, cb); return () => callbacks.delete(id); },
    });
    await quotaAccount(ctx("devin"), ["devin"], base);
    const snapshot = await fetchContextQuotas(ctx("anthropic"), "anthropic");
    expect(snapshot).toMatchObject({ account: "Work", result: { success: true } });
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("retries identity lookup against a replacement service", async () => {
    const staleAuth = vi.fn(async () => ({ accessToken: "old-token" }));
    setMultiProviderService({
      getActiveAccount: async () => {
        installPool("anthropic", "new-token");
        return { id: "old", label: "Old" };
      },
      resolveActiveAccountAuth: staleAuth,
    });
    const snapshot = await fetchContextQuotas(ctx("anthropic"), "anthropic");
    expect(snapshot).toMatchObject({ account: "Work", result: { success: true } });
    expect(staleAuth).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer new-token" }),
    }));
  });

  it("bounds retries when the service keeps replacing itself", async () => {
    const getActiveAccount = vi.fn(async () => {
      setMultiProviderService({ getActiveAccount, resolveActiveAccountAuth });
      return undefined;
    });
    const resolveActiveAccountAuth = vi.fn(async () => undefined);
    setMultiProviderService({ getActiveAccount, resolveActiveAccountAuth });
    const snapshot = await fetchContextQuotas(ctx("anthropic"), "anthropic");
    expect(snapshot.result).toMatchObject({ success: false, error: { kind: "network" } });
    expect(getActiveAccount).toHaveBeenCalledTimes(3);
    expect(resolveActiveAccountAuth).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects stale cached identity after a same-provider switch during lookup", async () => {
    installPool("anthropic");
    await fetchContextQuotas(ctx("anthropic"), "anthropic"); // cache Work
    let notify!: (event: { ctx?: never }) => void;
    let active = { id: "work", label: "Work" };
    const getActiveAccount = vi.fn(async () => active);
    getActiveAccount.mockImplementationOnce(async () => {
      const old = active;
      active = { id: "home", label: "Home" };
      notify({});
      return old;
    });
    setMultiProviderService({
      getActiveAccount,
      resolveActiveAccountAuth: async () => ({ accessToken: "home-token", label: "Home" }),
      onActiveAccountChanged: (_id, cb) => { notify = cb; return () => {}; },
    });
    const snapshot = await fetchContextQuotas(ctx("anthropic"), "anthropic");
    expect(snapshot.accountId).toBe("anthropic:home");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("uses normal credentials only when the service explicitly reports no pool", async () => {
    const getActiveAccount = vi.fn(async () => undefined);
    const resolveActiveAccountAuth = vi.fn(async () => undefined);
    setMultiProviderService({ hasPool: () => false, getActiveAccount, resolveActiveAccountAuth });
    const snapshot = await fetchContextQuotas(ctx("anthropic"), "anthropic");
    expect(snapshot).toMatchObject({ result: { success: true } });
    expect(snapshot.account).toBeUndefined();
    expect(getActiveAccount).not.toHaveBeenCalled();
    expect(resolveActiveAccountAuth).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer unrelated-token" }),
    }));
  });

  it("does not fall back before a configured pool's first selection", async () => {
    setMultiProviderService({
      hasPool: () => true,
      getActiveAccount: async () => undefined,
      resolveActiveAccountAuth: async () => undefined,
    });
    const snapshot = await fetchContextQuotas(ctx("anthropic"), "anthropic");
    expect(snapshot.result).toMatchObject({ success: false, error: { kind: "account_unknown" } });
    expect(fetch).not.toHaveBeenCalled();
    expect(base.getApiKey).not.toHaveBeenCalled();
  });

  it("probes alias pools before declaring a provider unpooled", async () => {
    const getActiveAccount = vi.fn(async (_id: string) => ({ id: "work", label: "Work" }));
    setMultiProviderService({
      hasPool: id => id === "google-antigravity",
      getActiveAccount,
      resolveActiveAccountAuth: async () => ({ accountId: "work", accessToken: "pooled-token", label: "Work" }),
    });
    const snapshot = await fetchContextQuotas(ctx("anthropic"), "antigravity");
    expect(snapshot.accountId).toBe("google-antigravity:work");
    expect(getActiveAccount.mock.calls.every(([id]) => id === "google-antigravity")).toBe(true);
    expect(base.getApiKey).not.toHaveBeenCalled();
  });

  it("fails closed when checking pool presence fails", async () => {
    setMultiProviderService({
      hasPool: () => { throw new Error("pool lookup failed"); },
      getActiveAccount: async () => undefined,
      resolveActiveAccountAuth: async () => undefined,
    });
    const snapshot = await fetchContextQuotas(ctx("anthropic"), "anthropic");
    expect(snapshot.result).toMatchObject({ success: false, error: { kind: "network" } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("detects unannounced same-label account/token mismatches using accountId", async () => {
    const resolve = vi.fn(async () => ({ accountId: "home", accessToken: "home-token", label: "Account" }));
    resolve.mockResolvedValueOnce({ accountId: "home", accessToken: "home-token", label: "Account" });
    resolve.mockResolvedValueOnce({ accountId: "work", accessToken: "work-token", label: "Account" });
    setMultiProviderService({
      hasPool: () => true,
      getActiveAccount: async () => ({ id: "work", label: "Account" }),
      resolveActiveAccountAuth: resolve,
    });
    const snapshot = await fetchContextQuotas(ctx("anthropic"), "anthropic");
    expect(snapshot).toMatchObject({ accountId: "anthropic:work", result: { success: true } });
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer work-token" }),
    }));
  });

  it("backs off failed credentials per account but allows force refresh and expiry", async () => {
    vi.useFakeTimers();
    try {
      const pool = installPool("anthropic");
      pool.resolveActiveAccountAuth.mockRejectedValue(new Error("refresh failed"));
      const first = await fetchContextQuotas(ctx("anthropic"), "anthropic");
      expect(first.result.success).toBe(false);
      expect(await fetchContextQuotas(ctx("anthropic"), "anthropic")).toEqual(first);
      expect(pool.resolveActiveAccountAuth).toHaveBeenCalledTimes(1);
      await fetchContextQuotas(ctx("anthropic"), "anthropic", { force: true });
      expect(pool.resolveActiveAccountAuth).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(10_001);
      await fetchContextQuotas(ctx("anthropic"), "anthropic");
      expect(pool.resolveActiveAccountAuth).toHaveBeenCalledTimes(3);
      pool.select({ id: "home", label: "Home" });
      await fetchContextQuotas(ctx("anthropic"), "anthropic");
      expect(pool.resolveActiveAccountAuth).toHaveBeenCalledTimes(4);
      clearQuotaCache();
      await fetchContextQuotas(ctx("anthropic"), "anthropic");
      expect(pool.resolveActiveAccountAuth).toHaveBeenCalledTimes(5);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops the previous account identity if service disappears during resolution", async () => {
    const pool = installPool("anthropic");
    pool.resolveActiveAccountAuth.mockImplementationOnce(async () => {
      setMultiProviderService(undefined);
      return { accessToken: "work-token", label: "Work" };
    });
    const snapshot = await fetchContextQuotas(ctx("anthropic"), "anthropic");
    expect(snapshot.accountId).toBeUndefined();
    expect(snapshot.account).toBeUndefined();
    expect(snapshot.result).toMatchObject({ success: false, error: { kind: "network" } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not override the explicitly unpooled model provider with an alias pool", async () => {
    const getActiveAccount = vi.fn(async () => ({ id: "work", label: "Work" }));
    const resolveActiveAccountAuth = vi.fn(async () => ({ accessToken: "wrong-alias-token" }));
    setMultiProviderService({
      hasPool: id => id === "google-antigravity",
      getActiveAccount,
      resolveActiveAccountAuth,
    });
    const snapshot = await fetchContextQuotas(ctx("agy"), "antigravity");
    expect(snapshot.accountId).toBeUndefined();
    expect(snapshot.result.success).toBe(true);
    expect(getActiveAccount).not.toHaveBeenCalled();
    expect(resolveActiveAccountAuth).not.toHaveBeenCalled();
  });

  it("does not use a partly reconciled service selection", async () => {
    const getActiveAccount = vi.fn(async () => ({ id: "stale", label: "Old" }));
    setMultiProviderService({
      hasPool: () => undefined,
      getActiveAccount,
      resolveActiveAccountAuth: async () => ({ accessToken: "stale-token" }),
    });
    const snapshot = await fetchContextQuotas(ctx("anthropic"), "anthropic");
    expect(snapshot.result).toMatchObject({ success: false, error: { kind: "account_pending" } });
    expect(getActiveAccount).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses valid credentials even when a concurrent caller caches an auth failure", async () => {
    const pool = installPool("anthropic");
    let finish!: (auth: { accessToken: string; label: string }) => void;
    pool.resolveActiveAccountAuth.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const valid = fetchContextQuotas(ctx("anthropic"), "anthropic");
    await vi.waitFor(() => expect(pool.resolveActiveAccountAuth).toHaveBeenCalledTimes(1));
    pool.resolveActiveAccountAuth.mockRejectedValueOnce(new Error("temporary refresh failure"));
    expect((await fetchContextQuotas(ctx("anthropic"), "anthropic")).result.success).toBe(false);
    finish({ accessToken: "valid-token", label: "Work" });
    expect((await valid).result.success).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer valid-token" }),
    }));
  });
});
