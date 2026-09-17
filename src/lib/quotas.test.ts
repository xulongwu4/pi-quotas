import type { AuthStorage } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROVIDER_FETCHERS } from "../providers/fetch.js";
import type { QuotasResult } from "../types/quotas.js";
import { clearQuotaCache, fetchProviderQuotas } from "./quotas.js";

const authStorage = {} as AuthStorage;
const originalDevinFetcher = PROVIDER_FETCHERS.devin;
const success: QuotasResult = {
  success: true,
  data: { provider: "devin", windows: [] },
};
const cancelled: QuotasResult = {
  success: false,
  error: { message: "Request cancelled", kind: "cancelled" },
};

function setDevinFetcher(fetcher: typeof originalDevinFetcher): void {
  (PROVIDER_FETCHERS as { devin: typeof originalDevinFetcher }).devin = fetcher;
}

afterEach(() => {
  clearQuotaCache("devin");
  setDevinFetcher(originalDevinFetcher);
  vi.restoreAllMocks();
});

describe("fetchProviderQuotas shared cancellation", () => {
  it("does not start a fetch for an already-aborted caller", async () => {
    const fetcher = vi.fn(async () => success);
    setDevinFetcher(fetcher);
    const controller = new AbortController();
    controller.abort();

    const result = await fetchProviderQuotas(authStorage, "devin", {
      force: true,
      signal: controller.signal,
    });

    expect(result).toMatchObject({
      success: false,
      error: { kind: "cancelled" },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps the shared fetch alive while another waiter remains", async () => {
    let providerSignal: AbortSignal | undefined;
    let resolveFetch!: (result: QuotasResult) => void;
    const fetcher = vi.fn(
      async (_auth: AuthStorage, signal?: AbortSignal) =>
        new Promise<QuotasResult>((resolve) => {
          providerSignal = signal;
          resolveFetch = resolve;
          signal?.addEventListener("abort", () => resolve(cancelled), {
            once: true,
          });
        }),
    );
    setDevinFetcher(fetcher);
    const first = new AbortController();
    const second = new AbortController();

    const firstResult = fetchProviderQuotas(authStorage, "devin", {
      force: true,
      signal: first.signal,
    });
    const secondResult = fetchProviderQuotas(authStorage, "devin", {
      force: true,
      signal: second.signal,
    });
    first.abort();

    expect((await firstResult).success).toBe(false);
    expect(providerSignal?.aborted).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);

    resolveFetch(success);
    expect(await secondResult).toEqual(success);
  });

  it("aborts the provider fetch after its final waiter leaves", async () => {
    let providerSignal: AbortSignal | undefined;
    const fetcher = vi.fn(
      async (_auth: AuthStorage, signal?: AbortSignal) =>
        new Promise<QuotasResult>((resolve) => {
          providerSignal = signal;
          signal?.addEventListener("abort", () => resolve(cancelled), {
            once: true,
          });
        }),
    );
    setDevinFetcher(fetcher);
    const first = new AbortController();
    const second = new AbortController();

    const firstResult = fetchProviderQuotas(authStorage, "devin", {
      force: true,
      signal: first.signal,
    });
    const secondResult = fetchProviderQuotas(authStorage, "devin", {
      force: true,
      signal: second.signal,
    });
    first.abort();
    second.abort();

    expect((await firstResult).success).toBe(false);
    expect((await secondResult).success).toBe(false);
    expect(providerSignal?.aborted).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
