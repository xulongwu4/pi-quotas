import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { QuotaSnapshot } from "../../types/quotas.js";
import { fetchContextQuotas } from "../../lib/quotas.js";
import quotaWarnings from "./index.js";

vi.mock("../../config.js", () => ({
  QUOTAS_CONFIG_UPDATED_EVENT: "quotas:config:updated",
  QUOTAS_EXTENSIONS_REGISTER_EVENT: "quotas:extensions:register",
  QUOTAS_EXTENSIONS_REQUEST_EVENT: "quotas:extensions:request",
  configLoader: {
    load: vi.fn(async () => undefined),
    getConfig: () => ({ quotaWarnings: true }),
  },
}));
vi.mock("../../lib/quotas.js", () => ({
  fetchContextQuotas: vi.fn(),
  normalizeQuotaProvider: (provider: string) => provider,
  PROVIDER_LABELS: { anthropic: "Anthropic" },
}));

const snapshot = (accountId?: string, account?: string): QuotaSnapshot => ({
  provider: "anthropic", accountId, account,
  result: { success: true, data: { provider: "anthropic", windows: [{
    provider: "anthropic", label: "5h", kind: "percent", usedPercent: 85,
    resetsAt: null, windowSeconds: 18000,
  }] } },
});

async function harness() {
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const notify = vi.fn();
  const bus = new Map<string, (value: unknown) => void>();
  const ctx = { hasUI: true, model: { provider: "anthropic" }, ui: { notify } } as unknown as ExtensionContext;
  const pi = {
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(event, handler),
    events: {
      on: (event: string, callback: (value: unknown) => void) => { bus.set(event, callback); return () => bus.delete(event); },
      emit: (event: string, value: unknown) => bus.get(event)?.(value),
    },
  } as unknown as ExtensionAPI;
  await quotaWarnings(pi);
  return {
    notify,
    async announce(service: unknown) {
      pi.events.emit("pi-multiprovider:service", service);
      await vi.advanceTimersByTimeAsync(0);
    },
    async emit(event: string) {
      await handlers.get(event)?.({}, ctx);
      await vi.advanceTimersByTimeAsync(0);
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-29T12:00:00Z"));
  vi.mocked(fetchContextQuotas).mockReset();
});
afterEach(() => vi.useRealTimers());

describe("account-scoped quota warnings", () => {
  it("keeps cooldowns separate for accounts with identical labels", async () => {
    vi.mocked(fetchContextQuotas).mockResolvedValue(snapshot("anthropic:work", "Account"));
    const h = await harness();
    try {
      await h.emit("session_start");
      expect(h.notify).toHaveBeenCalledTimes(1);
      expect(h.notify.mock.calls[0][0]).toContain("Anthropic (Account)");
      await vi.advanceTimersByTimeAsync(30_001);
      await h.emit("turn_end");
      expect(h.notify).toHaveBeenCalledTimes(1);
      vi.mocked(fetchContextQuotas).mockResolvedValue(snapshot("anthropic:home", "Account"));
      await vi.advanceTimersByTimeAsync(30_001);
      await h.emit("turn_end");
      expect(h.notify).toHaveBeenCalledTimes(2);
      vi.mocked(fetchContextQuotas).mockResolvedValue(snapshot("anthropic:work", "Account"));
      await vi.advanceTimersByTimeAsync(30_001);
      await h.emit("turn_end");
      expect(h.notify).toHaveBeenCalledTimes(2);
    } finally {
      await h.emit("session_shutdown");
    }
  });

  it("preserves the upstream cooldown when the service identifies Pi default", async () => {
    vi.mocked(fetchContextQuotas).mockResolvedValue(snapshot());
    const h = await harness();
    try {
      await h.emit("session_start");
      expect(h.notify).toHaveBeenCalledTimes(1);
      vi.mocked(fetchContextQuotas).mockResolvedValue(snapshot("anthropic:pi:default", "Pi default"));
      await vi.advanceTimersByTimeAsync(30_001);
      await h.emit("turn_end");
      expect(h.notify).toHaveBeenCalledTimes(1);
    } finally {
      await h.emit("session_shutdown");
    }
  });

  it("rechecks on same-object reannouncement and drops obsolete in-flight warnings", async () => {
    let finish!: (value: QuotaSnapshot) => void;
    vi.mocked(fetchContextQuotas).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const h = await harness();
    const service = { getActiveAccount: async () => undefined, resolveActiveAccountAuth: async () => undefined };
    try {
      await h.announce(service);
      await h.emit("session_start");
      vi.mocked(fetchContextQuotas).mockResolvedValue(snapshot("anthropic:work", "Work"));
      await h.announce(service);
      expect(fetchContextQuotas).toHaveBeenCalledTimes(2);
      expect(h.notify).toHaveBeenCalledTimes(1);
      finish(snapshot("anthropic:old", "Old"));
      await vi.advanceTimersByTimeAsync(0);
      expect(h.notify).toHaveBeenCalledTimes(1);
      expect(h.notify.mock.calls[0][0]).toContain("(Work)");
    } finally {
      await h.emit("session_shutdown");
    }
  });

  it.each([true, false])("throttles high warnings across same-service reconciliation (pooled=%s)", async (pooled) => {
    const high = snapshot(pooled ? "anthropic:work" : undefined, pooled ? "Work" : undefined);
    if (high.result.success) high.result.data.windows[0].usedPercent = 96;
    vi.mocked(fetchContextQuotas).mockResolvedValue(high);
    const h = await harness();
    const service = { getActiveAccount: async () => undefined, resolveActiveAccountAuth: async () => undefined };
    try {
      await h.announce(service);
      await h.emit("session_start");
      expect(h.notify).toHaveBeenCalledTimes(1);
      for (let i = 0; i < 3; i++) {
        vi.mocked(fetchContextQuotas).mockResolvedValue({
          provider: "anthropic",
          result: { success: false, error: { kind: "account_pending", message: "Reconciling" } },
        });
        await h.announce(service);
        vi.mocked(fetchContextQuotas).mockResolvedValue(high);
        await h.announce(service);
      }
      expect(h.notify).toHaveBeenCalledTimes(1);
      expect(fetchContextQuotas).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(30_001);
      await h.announce(service);
      expect(h.notify).toHaveBeenCalledTimes(2);
    } finally {
      await h.emit("session_shutdown");
    }
  });

  it("retries immediately when initialization completes after an unknown account", async () => {
    vi.mocked(fetchContextQuotas).mockResolvedValueOnce({
      provider: "anthropic",
      result: { success: false, error: { kind: "account_pending", message: "Initializing" } },
    });
    const h = await harness();
    const service = { getActiveAccount: async () => undefined, resolveActiveAccountAuth: async () => undefined };
    try {
      await h.announce(service);
      await h.emit("session_start");
      expect(h.notify).not.toHaveBeenCalled();
      vi.mocked(fetchContextQuotas).mockResolvedValue(snapshot("anthropic:work", "Work"));
      await h.announce(service);
      expect(h.notify).toHaveBeenCalledTimes(1);
    } finally {
      await h.emit("session_shutdown");
    }
  });
});
