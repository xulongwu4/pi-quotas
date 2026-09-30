import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { quotaAccount, setMultiProviderService } from "../../lib/multiprovider.js";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import usageStatusExtension from "./index.js";
import { fetchContextQuotas } from "../../lib/quotas.js";

vi.mock("../../config.js", () => ({
  QUOTAS_CONFIG_UPDATED_EVENT: "quotas:config:updated",
  QUOTAS_EXTENSIONS_REGISTER_EVENT: "quotas:extensions:register",
  QUOTAS_EXTENSIONS_REQUEST_EVENT: "quotas:extensions:request",
  configLoader: {
    load: vi.fn(async () => undefined),
    getConfig: vi.fn(() => ({
      configVersion: "test",
      quotasCommand: true,
      providerCommands: true,
      usageStatus: true,
      quotaWarnings: true,
      deferToSynthetic: true,
    })),
  },
}));

vi.mock("../../lib/quotas.js", () => ({
  isSupportedProvider: (provider: string | undefined) => provider === "anthropic",
  normalizeQuotaProvider: (provider: string | undefined) =>
    provider === "anthropic" ? provider : undefined,
  fetchContextQuotas: vi.fn(async () => ({
    provider: "anthropic",
    result: { success: true, data: { provider: "anthropic", windows: [] } },
  })),
}));

const STALE_CONTEXT_ERROR =
  "This extension ctx is stale after session replacement or reload.";

type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown;

function createFakePi() {
  const extensionHandlers = new Map<string, EventHandler[]>();
  const eventBusHandlers = new Map<string, Array<(data: unknown) => void>>();

  const pi = {
    on(event: string, handler: EventHandler) {
      const handlers = extensionHandlers.get(event) ?? [];
      handlers.push(handler);
      extensionHandlers.set(event, handlers);
    },
    events: {
      on(channel: string, handler: (data: unknown) => void) {
        const handlers = eventBusHandlers.get(channel) ?? [];
        handlers.push(handler);
        eventBusHandlers.set(channel, handlers);
        return () => {
          const current = eventBusHandlers.get(channel) ?? [];
          eventBusHandlers.set(channel, current.filter((entry) => entry !== handler));
        };
      },
      emit(channel: string, data: unknown) {
        for (const handler of eventBusHandlers.get(channel) ?? []) handler(data);
      },
    },
  } as unknown as ExtensionAPI;

  return {
    pi,
    async emitExtensionEvent(event: string, ctx: ExtensionContext) {
      for (const handler of extensionHandlers.get(event) ?? []) {
        await handler({ type: event, reason: "test" }, ctx);
      }
    },
    emitBusEvent(channel: string, data: unknown) {
      pi.events.emit(channel, data);
    },
    listenerCount(channel: string) {
      return eventBusHandlers.get(channel)?.length ?? 0;
    },
  };
}

function createContext(provider: string) {
  let stale = false;
  const setStatus = vi.fn((_key: string, _text: string | undefined) => {
    if (stale) throw new Error(STALE_CONTEXT_ERROR);
  });

  const ctx = {
    get hasUI() {
      if (stale) throw new Error(STALE_CONTEXT_ERROR);
      return true;
    },
    get model() {
      if (stale) throw new Error(STALE_CONTEXT_ERROR);
      return { provider };
    },
    modelRegistry: { authStorage: {} },
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      setStatus,
    },
  } as unknown as ExtensionContext;

  return {
    ctx,
    setStale() {
      stale = true;
    },
    setStatus,
  };
}

beforeEach(() => {
  vi.mocked(fetchContextQuotas).mockReset().mockResolvedValue({
    provider: "anthropic",
    result: { success: true, data: { provider: "anthropic", windows: [] } },
  });
});
afterEach(() => {
  setMultiProviderService(undefined);
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("usage-status extension lifecycle", () => {
  it("ignores interval refreshes for stale session contexts", async () => {
    vi.useFakeTimers();
    const { pi, emitExtensionEvent } = createFakePi();
    const { ctx, setStale } = createContext("unsupported-provider");

    await usageStatusExtension(pi);
    await emitExtensionEvent("session_start", ctx);

    setStale();

    expect(() => vi.advanceTimersByTime(60_000)).not.toThrow();
    await vi.runOnlyPendingTimersAsync();
    await emitExtensionEvent("session_shutdown", ctx);
  });

  it("does not throw when event-bus callbacks see a stale session context", async () => {
    const { pi, emitExtensionEvent, emitBusEvent } = createFakePi();
    const { ctx, setStale } = createContext("synthetic");

    await usageStatusExtension(pi);
    await emitExtensionEvent("session_start", ctx);

    setStale();

    expect(() => {
      emitBusEvent("synthetic:extensions:register", { feature: "usageStatus" });
      emitBusEvent("quotas:config:updated", {
        config: { usageStatus: true, deferToSynthetic: true },
      });
    }).not.toThrow();
    await emitExtensionEvent("session_shutdown", ctx);
  });

  it("unsubscribes event-bus listeners during session shutdown", async () => {
    const { pi, emitExtensionEvent, listenerCount } = createFakePi();
    const { ctx } = createContext("unsupported-provider");

    await usageStatusExtension(pi);
    expect(listenerCount("quotas:config:updated")).toBe(1);
    expect(listenerCount("synthetic:extensions:register")).toBe(1);
    expect(listenerCount("quotas:extensions:request")).toBe(1);

    await emitExtensionEvent("session_shutdown", ctx);

    expect(listenerCount("quotas:config:updated")).toBe(0);
    expect(listenerCount("synthetic:extensions:register")).toBe(0);
    expect(listenerCount("quotas:extensions:request")).toBe(0);
  });

  it("clears the footer silently for not_applicable credentials instead of warning", async () => {
    vi.useFakeTimers();
    vi.mocked(fetchContextQuotas).mockResolvedValueOnce({
      provider: "anthropic",
      result: {
        success: false,
        error: { kind: "not_applicable", message: "Direct API key" },
      },
    } as any);

    const { pi, emitExtensionEvent } = createFakePi();
    const { ctx, setStatus } = createContext("anthropic");

    await usageStatusExtension(pi);
    await emitExtensionEvent("session_start", ctx);
    await vi.runOnlyPendingTimersAsync();
    await vi.advanceTimersByTimeAsync(0);

    const calls = setStatus.mock.calls as unknown as Array<[string, string | undefined]>;
    const last = calls[calls.length - 1]?.[1];
    expect(last).toBeUndefined();
    expect(calls.some((c) => c[1] === "usage unavailable")).toBe(false);
    await emitExtensionEvent("session_shutdown", ctx);
  });

  it.each(["config", "not_applicable"] as const)("shows the account when pooled quotas are %s", async (kind) => {
    vi.useFakeTimers();
    vi.mocked(fetchContextQuotas).mockResolvedValueOnce({
      provider: "anthropic",
      account: "Work",
      accountId: "anthropic:work",
      result: { success: false, error: { kind, message: "Unavailable" } },
    });
    const { pi, emitExtensionEvent } = createFakePi();
    const { ctx, setStatus } = createContext("anthropic");
    await usageStatusExtension(pi);
    await emitExtensionEvent("session_start", ctx);
    await vi.advanceTimersByTimeAsync(0);
    expect(setStatus).toHaveBeenLastCalledWith("pi-quotas-usage", "Work · usage unavailable");
    await emitExtensionEvent("session_shutdown", ctx);
  });

  it("clears old account quotas and aborts pending refreshes when the service changes", async () => {
    vi.useFakeTimers();
    vi.mocked(fetchContextQuotas).mockResolvedValueOnce({
      provider: "anthropic",
      account: "Work",
      accountId: "anthropic:work",
      result: { success: true, data: { provider: "anthropic", windows: [] } },
    });
    const { pi, emitExtensionEvent, emitBusEvent } = createFakePi();
    const { ctx, setStatus } = createContext("anthropic");
    await usageStatusExtension(pi);
    await emitExtensionEvent("session_start", ctx);
    await vi.advanceTimersByTimeAsync(0);
    let signal: AbortSignal | undefined;
    vi.mocked(fetchContextQuotas).mockImplementationOnce((_ctx, _provider, options) =>
      new Promise(resolve => {
        signal = options?.signal;
        signal?.addEventListener("abort", () => resolve({
          provider: "anthropic",
          result: { success: false, error: { kind: "cancelled", message: "Cancelled" } },
        }));
      }),
    );
    await emitExtensionEvent("turn_end", ctx);
    await vi.advanceTimersByTimeAsync(0);
    emitBusEvent("pi-multiprovider:service", {
      getActiveAccount: async () => undefined,
      resolveActiveAccountAuth: async () => undefined,
    });
    expect(signal?.aborted).toBe(true);
    expect(setStatus).toHaveBeenLastCalledWith("pi-quotas-usage", undefined);
    await vi.advanceTimersByTimeAsync(0);
    await emitExtensionEvent("session_shutdown", ctx);
  });

  it("explains an unknown account without displaying default quotas", async () => {
    vi.useFakeTimers();
    vi.mocked(fetchContextQuotas).mockResolvedValueOnce({
      provider: "anthropic",
      result: { success: false, error: { kind: "account_unknown", message: "Select an account" } },
    });
    const { pi, emitExtensionEvent } = createFakePi();
    const { ctx, setStatus } = createContext("anthropic");
    await usageStatusExtension(pi);
    await emitExtensionEvent("session_start", ctx);
    await vi.advanceTimersByTimeAsync(0);
    expect(setStatus).toHaveBeenLastCalledWith("pi-quotas-usage", "account unknown · see README");
    await emitExtensionEvent("session_shutdown", ctx);
  });

  it("uses the switch event context and ignores switches for other providers", async () => {
    vi.useFakeTimers();
    const { pi, emitExtensionEvent, emitBusEvent } = createFakePi();
    const original = createContext("anthropic");
    const replacement = createContext("anthropic");
    const callbacks = new Map<string, (event: { ctx?: ExtensionContext }) => void>();
    const service = {
      getActiveAccount: async () => undefined,
      resolveActiveAccountAuth: async () => undefined,
      onActiveAccountChanged: (id: string, cb: (event: { ctx?: ExtensionContext }) => void) => {
        callbacks.set(id, cb);
        return () => callbacks.delete(id);
      },
    };
    vi.mocked(fetchContextQuotas).mockImplementation(async (context) => {
      // Start following both providers through the real service bridge.
      await quotaAccount(context, ["anthropic", "devin"], {} as never);
      return { provider: "anthropic", result: { success: true, data: { provider: "anthropic", windows: [] } } };
    });
    await usageStatusExtension(pi);
    emitBusEvent("pi-multiprovider:service", service);
    await emitExtensionEvent("session_start", original.ctx);
    await vi.advanceTimersByTimeAsync(0);
    vi.mocked(fetchContextQuotas).mockClear();
    callbacks.get("devin")?.({ ctx: replacement.ctx });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchContextQuotas).not.toHaveBeenCalled();
    callbacks.get("anthropic")?.({ ctx: replacement.ctx });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchContextQuotas).toHaveBeenCalledWith(replacement.ctx, "anthropic", expect.anything());
    await emitExtensionEvent("session_shutdown", replacement.ctx);
  });

  it("hides not-applicable upstream quotas but refreshes on same-object announcements", async () => {
    vi.useFakeTimers();
    const { pi, emitExtensionEvent, emitBusEvent } = createFakePi();
    const { ctx, setStatus } = createContext("anthropic");
    const service = { getActiveAccount: async () => undefined, resolveActiveAccountAuth: async () => undefined };
    vi.mocked(fetchContextQuotas).mockResolvedValue({
      provider: "anthropic", account: "Pi default", accountId: "anthropic:pi:default",
      result: { success: false, error: { kind: "not_applicable", message: "API key" } },
    });
    await usageStatusExtension(pi);
    emitBusEvent("pi-multiprovider:service", service);
    await emitExtensionEvent("session_start", ctx);
    await vi.advanceTimersByTimeAsync(0);
    expect(setStatus).toHaveBeenLastCalledWith("pi-quotas-usage", undefined);
    vi.mocked(fetchContextQuotas).mockClear();
    emitBusEvent("pi-multiprovider:service", service);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchContextQuotas).toHaveBeenCalledTimes(1);
    await emitExtensionEvent("session_shutdown", ctx);
  });

  it.each([true, false])("keeps a stable footer across reconciliation (pooled=%s), but clears a lost selection", async (pooled) => {
    vi.useFakeTimers();
    const { pi, emitExtensionEvent, emitBusEvent } = createFakePi();
    const { ctx, setStatus } = createContext("anthropic");
    const service = { getActiveAccount: async () => undefined, resolveActiveAccountAuth: async () => undefined };
    const ready = {
      provider: "anthropic" as const,
      account: pooled ? "Work" : undefined, accountId: pooled ? "anthropic:work" : undefined,
      result: { success: true as const, data: { provider: "anthropic" as const, windows: [{
        provider: "anthropic" as const, kind: "percent" as const, label: "5h", usedPercent: 96,
        resetsAt: null, windowSeconds: 18000,
      }] } },
    };
    vi.mocked(fetchContextQuotas).mockResolvedValue(ready);
    await usageStatusExtension(pi);
    emitBusEvent("pi-multiprovider:service", service);
    await emitExtensionEvent("session_start", ctx);
    await vi.advanceTimersByTimeAsync(0);
    const painted = setStatus.mock.calls.at(-1)?.[1];
    expect(painted).toBeTruthy();
    setStatus.mockClear();
    for (let i = 0; i < 3; i++) {
      vi.mocked(fetchContextQuotas).mockResolvedValue({
        provider: "anthropic",
        result: { success: false, error: { kind: "account_pending", message: "Reconciling" } },
      });
      emitBusEvent("pi-multiprovider:service", service);
      await vi.advanceTimersByTimeAsync(0);
      vi.mocked(fetchContextQuotas).mockResolvedValue(ready);
      emitBusEvent("pi-multiprovider:service", service);
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(setStatus.mock.calls.every(call => call[1] === painted)).toBe(true);
    vi.mocked(fetchContextQuotas).mockResolvedValue({
      provider: "anthropic",
      result: { success: false, error: { kind: "account_unknown", message: "No selection" } },
    });
    emitBusEvent("pi-multiprovider:service", service);
    await vi.advanceTimersByTimeAsync(0);
    expect(setStatus).toHaveBeenLastCalledWith("pi-quotas-usage", "account unknown · see README");
    await emitExtensionEvent("session_shutdown", ctx);
  });
});
