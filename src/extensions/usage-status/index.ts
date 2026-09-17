import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import {
  QUOTAS_CONFIG_UPDATED_EVENT,
  QUOTAS_EXTENSIONS_REGISTER_EVENT,
  QUOTAS_EXTENSIONS_REQUEST_EVENT,
  type QuotasConfigUpdatedPayload,
  configLoader,
} from "../../config.js";

/** Event emitted by pi-synthetic when its usage-status extension registers. */
const SYNTHETIC_EXTENSIONS_REGISTER_EVENT = "synthetic:extensions:register";
interface SyntheticExtensionsRegisterPayload {
  feature: string;
}
import { quotaAuthStorage } from "../../lib/auth.js";
import {
  fetchProviderQuotas,
  isSupportedProvider,
} from "../../lib/quotas.js";
import {
  assessWindow,
  formatTimeRemaining,
} from "../../utils/quotas-severity.js";
import type { QuotaWindow } from "../../types/quotas.js";
import { formatWindowStatus, type WindowStatus } from "./format-status.js";

const EXTENSION_ID = "pi-quotas-usage";
const REFRESH_INTERVAL_MS = 60_000;
const STALE_CONTEXT_MESSAGE = "This extension ctx is stale";

function isStaleContextError(error: unknown): boolean {
  return error instanceof Error && error.message.includes(STALE_CONTEXT_MESSAGE);
}

function getContextProvider(
  ctx: ExtensionContext | undefined,
  modelOrProvider?: { provider?: string } | string,
): string | undefined {
  if (typeof modelOrProvider === "string" && modelOrProvider.length > 0) {
    return modelOrProvider;
  }
  if (
    typeof modelOrProvider === "object" &&
    typeof modelOrProvider?.provider === "string" &&
    modelOrProvider.provider.length > 0
  ) {
    return modelOrProvider.provider;
  }
  if (!ctx) return undefined;
  try {
    return ctx.model?.provider;
  } catch (error) {
    if (isStaleContextError(error)) return undefined;
    throw error;
  }
}

/** Footer reset text: `xd xh` past a day, `xh` past an hour, else minutes. */
function formatFooterReset(date: Date): string {
  const ms = date.getTime() - Date.now();
  const totalHours = Math.ceil(ms / (60 * 60 * 1000));
  if (totalHours >= 24) {
    const days = Math.floor(totalHours / 24);
    const hours = totalHours % 24;
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }
  if (totalHours >= 1) return `${totalHours}h`;
  return formatTimeRemaining(date);
}

export function formatStatus(ctx: Pick<ExtensionContext, "ui">, windows: WindowStatus[]): string {
  const theme = ctx.ui.theme;
  return windows
    .map((w) => {
      const core = formatWindowStatus(theme, w);
      const reset = w.resetsAt ? theme.fg("dim", ` ⟳ ${formatFooterReset(w.resetsAt)}`) : "";
      return `${core}${reset}`;
    })
    .join(" ");
}

export function toWindowStatus(window: QuotaWindow): WindowStatus {
  const common = {
    provider: window.provider,
    label: window.label,
    usedPercent: window.usedPercent,
    severity: assessWindow(window).severity,
    resetsAt: window.resetsAt,
    limited: window.limited ?? false,
  };
  switch (window.kind) {
    case "percent":
    case "spend-cap":
      return { ...common, kind: window.kind };
    case "counts":
    case "currency":
      return {
        ...common,
        kind: window.kind,
        usedValue: window.usedValue,
        limitValue: window.limitValue,
      };
  }
}

export function toStatusWindows(windows: QuotaWindow[]): WindowStatus[] {
  return windows.map(toWindowStatus);
}

export function formatStatusForFooter(
  ctx: Pick<ExtensionContext, "ui">,
  windows: WindowStatus[],
): string | undefined {
  if (windows.length === 0) return undefined;
  return formatStatus(ctx, windows);
}

function createStatusRefresher() {
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let activeContext: ExtensionContext | undefined;
  let activeProvider: string | undefined;
  let lastStatus: WindowStatus[] | undefined;
  // Serialize updates so refreshFor awaits its own provider refresh instead
  // of returning early behind an older in-flight request.
  let updateTail: Promise<void> = Promise.resolve();
  // Aborted when the provider switches or the refresher deactivates, so a
  // slow fetch (e.g. Devin GetUserStatus) cannot gate the next provider's
  // update for FETCH_TIMEOUT_MS.
  let fetchController: AbortController | undefined;

  // Bumped whenever the active ctx/provider is replaced or the refresher stops.
  // This prevents an old async fetch from writing to a replacement session.
  let generation = 0;

  function deactivate(): void {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = undefined;
    activeContext = undefined;
    activeProvider = undefined;
    lastStatus = undefined;
    fetchController?.abort();
    fetchController = undefined;
    generation++;
  }

  function setStatusSafely(
    ctx: ExtensionContext | undefined,
    text: string | undefined | ((ctx: ExtensionContext) => string | undefined),
  ): boolean {
    if (!ctx) return false;
    try {
      if (!ctx.hasUI) return true;
      ctx.ui.setStatus(EXTENSION_ID, typeof text === "function" ? text(ctx) : text);
      return true;
    } catch (error) {
      if (isStaleContextError(error) && activeContext === ctx) deactivate();
      return false;
    }
  }

  async function performUpdate(
    ctx: ExtensionContext,
    requestGeneration: number,
  ): Promise<void> {
    if (requestGeneration !== generation) return;
    if (!ctx.hasUI || !activeProvider || !isSupportedProvider(activeProvider)) return;

    const provider = activeProvider;
    const controller = new AbortController();
    fetchController = controller;
    try {
      const result = await fetchProviderQuotas(
        quotaAuthStorage(ctx.modelRegistry),
        provider,
        { signal: controller.signal },
      );
      if (
        controller.signal.aborted ||
        requestGeneration !== generation
      ) {
        return;
      }

      if (!result.success) {
        // Shared-cache eviction can cancel the provider request without
        // aborting this UI controller; cancellation is normal control flow.
        if (result.error.kind === "cancelled") return;
        // A "not applicable" result (e.g. a direct Anthropic API key with no
        // OAuth subscription usage) is expected, not a failure — show nothing
        // rather than a persistent "usage unavailable" warning.
        if (result.error.kind === "not_applicable") {
          setStatusSafely(ctx, undefined);
          return;
        }
        setStatusSafely(ctx, (ctx) =>
          ctx.ui.theme.fg("warning", "usage unavailable"),
        );
        return;
      }
      const windows: WindowStatus[] = toStatusWindows(result.data.windows);
      const status = formatStatusForFooter(ctx, windows);
      lastStatus = status === undefined ? undefined : windows;
      setStatusSafely(ctx, status);
    } catch (error) {
      if (isStaleContextError(error)) {
        if (requestGeneration === generation) deactivate();
        return;
      }
      setStatusSafely(ctx, (ctx) =>
        ctx.ui.theme.fg("warning", "usage unavailable"),
      );
    } finally {
      if (fetchController === controller) fetchController = undefined;
    }
  }

  function update(
    ctx: ExtensionContext,
    requestGeneration = generation,
  ): Promise<void> {
    const task = updateTail
      .catch(() => undefined)
      .then(() => performUpdate(ctx, requestGeneration));
    updateTail = task;
    return task;
  }

  return {
    async refreshFor(
      ctx: ExtensionContext,
      providerOverride?: { provider?: string } | string,
    ): Promise<void> {
      activeContext = ctx;
      const prevProvider = activeProvider;
      activeProvider = getContextProvider(ctx, providerOverride);
      // Abort the previous provider's in-flight fetch so a provider switch
      // is not stalled on it (e.g. leaving a slow Devin GetUserStatus).
      if (prevProvider !== activeProvider) fetchController?.abort();
      generation++;
      const requestGeneration = generation;
      if (!activeProvider || !isSupportedProvider(activeProvider)) {
        setStatusSafely(ctx, undefined);
        return;
      }
      // If switching models within the same provider, keep rendering the existing
      // status while the background quota refresh runs to avoid flickering/disappearing.
      if (prevProvider === activeProvider && lastStatus) {
        setStatusSafely(ctx, (ctx) => formatStatusForFooter(ctx, lastStatus ?? []));
      }
      await update(ctx, requestGeneration);
    },
    start(): void {
      if (refreshTimer) clearInterval(refreshTimer);
      refreshTimer = setInterval(() => {
        if (activeContext) void update(activeContext, generation).catch(() => undefined);
      }, REFRESH_INTERVAL_MS);
      refreshTimer.unref?.();
    },
    stop(ctx?: ExtensionContext): void {
      deactivate();
      setStatusSafely(ctx, undefined);
    },
    renderLast(ctx: ExtensionContext): boolean {
      if (!lastStatus) return false;
      return setStatusSafely(ctx, (ctx) => formatStatusForFooter(ctx, lastStatus ?? []));
    },
  };
}

export default async function (pi: ExtensionAPI) {
  await configLoader.load();
  const refresher = createStatusRefresher();
  const unsubscribeEventBusListeners: Array<() => void> = [];
  let enabled = configLoader.getConfig().usageStatus;
  let deferToSynthetic = configLoader.getConfig().deferToSynthetic;
  let currentContext: ExtensionContext | undefined;

  /** Whether pi-synthetic's usage footer is active in this session. */
  let syntheticUsageActive = false;

  unsubscribeEventBusListeners.push(pi.events.on(SYNTHETIC_EXTENSIONS_REGISTER_EVENT, (data: unknown) => {
    const { feature } = data as SyntheticExtensionsRegisterPayload;
    if (feature === "usageStatus") {
      syntheticUsageActive = true;
      // If currently showing synthetic data, clear our footer
      if (currentContext && enabled && deferToSynthetic && getContextProvider(currentContext) === "synthetic") {
        refresher.stop(currentContext);
      }
    }
  }));

  function scheduleRefresh(
    ctx: ExtensionContext,
    providerOverride?: { provider?: string } | string,
  ): void {
    void refresher.refreshFor(ctx, providerOverride).catch(() => undefined);
  }

  unsubscribeEventBusListeners.push(pi.events.on(QUOTAS_CONFIG_UPDATED_EVENT, (data: unknown) => {
    const config = (data as QuotasConfigUpdatedPayload).config;
    enabled = config.usageStatus;
    deferToSynthetic = config.deferToSynthetic;
    if (!enabled) {
      refresher.stop(currentContext);
      return;
    }
    if (currentContext) {
      refresher.start();
      scheduleRefresh(currentContext);
    }
  }));

  /**
   * Whether to suppress our footer because pi-synthetic is showing
   * the same data for the Synthetic provider.
   */
  function shouldDeferToSynthetic(provider: string | undefined): boolean {
    return deferToSynthetic && syntheticUsageActive && provider === "synthetic";
  }

  pi.on("session_start", (_event, ctx) => {
    currentContext = ctx;
    if (!enabled) {
      refresher.stop(ctx);
      return;
    }
    if (shouldDeferToSynthetic(getContextProvider(ctx))) {
      refresher.stop(ctx);
      return;
    }
    refresher.start();
    scheduleRefresh(ctx);
  });

  pi.on("turn_end", (_event, ctx) => {
    currentContext = ctx;
    if (!enabled) return;
    if (shouldDeferToSynthetic(getContextProvider(ctx))) {
      refresher.stop(ctx);
      return;
    }
    scheduleRefresh(ctx);
  });

  pi.on("model_select", (event, ctx) => {
    currentContext = ctx;
    const provider = getContextProvider(ctx, event?.model);
    if (!enabled) {
      refresher.stop(ctx);
      return;
    }
    if (shouldDeferToSynthetic(provider)) {
      refresher.stop(ctx);
      return;
    }
    scheduleRefresh(ctx, event?.model);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    currentContext = undefined;
    syntheticUsageActive = false;
    refresher.stop(ctx);
    for (const unsubscribe of unsubscribeEventBusListeners.splice(0)) {
      unsubscribe();
    }
  });

  unsubscribeEventBusListeners.push(pi.events.on(QUOTAS_EXTENSIONS_REQUEST_EVENT, () => {
    if (configLoader.getConfig().usageStatus) {
      pi.events.emit(QUOTAS_EXTENSIONS_REGISTER_EVENT, { feature: "usageStatus" });
    }
  }));
}
