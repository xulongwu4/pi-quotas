import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import {
  QUOTAS_EXTENSIONS_REGISTER_EVENT,
  QUOTAS_EXTENSIONS_REQUEST_EVENT,
  configLoader,
} from "../../config.js";
import { quotaAuthStorage } from "../../lib/auth.js";
import { formatQuotaDisplay } from "../../utils/quotas-format.js";
import {
  fetchAllProviderQuotas,
  fetchProviderQuotas,
  SUPPORTED_PROVIDERS,
} from "../../lib/quotas.js";
import type { QuotasResult, SupportedQuotaProvider } from "../../types/quotas.js";
import { QuotasComponent } from "./components/quotas-display.js";
import { getProviderCommandInfo } from "./provider-commands.js";

type Snapshot = { provider: SupportedQuotaProvider; result: QuotasResult };

async function openQuotaView(
  title: string,
  loadSnapshots: (
    force: boolean,
    signal?: AbortSignal,
    onSnapshot?: (snapshot: Snapshot) => void,
  ) => Promise<Snapshot[]>,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const result = await ctx.ui.custom<null>((tui, theme, _kb, done) => {
    let controller = new AbortController();
    const component = new QuotasComponent(
      theme,
      tui,
      title,
      () => {
        controller.abort();
        done(null);
      },
      () => {
        // Abort any in-flight load so its late snapshots cannot paint over
        // this refresh; a fresh controller serves the new load.
        controller.abort();
        controller = new AbortController();
        component.setState({ type: "loading" });
        tui.requestRender();
        void load(true);
      },
    );

    async function load(force = false): Promise<void> {
      // Render incrementally: a slow provider (e.g. the catalog-class Devin
      // GetUserStatus RPC) must not gate providers that already resolved.
      // Capture this load's controller so a refresh aborts exactly the
      // in-flight load, never its successor.
      const loadController = controller;
      const collected: Snapshot[] = [];
      const onSnapshot = (snapshot: Snapshot): void => {
        collected.push(snapshot);
        if (loadController.signal.aborted) return;
        // Maintain catalog order incrementally: each arrival is sorted into
        // place, so rows never jump when a slow provider settles late.
        collected.sort(
          (a, b) =>
            SUPPORTED_PROVIDERS.indexOf(a.provider) -
            SUPPORTED_PROVIDERS.indexOf(b.provider),
        );
        component.setState({
          type: "streaming",
          snapshots: [...collected],
          pending: Math.max(
            0,
            SUPPORTED_PROVIDERS.length - collected.length,
          ),
        });
        tui.requestRender();
      };
      const snapshots = await loadSnapshots(force, loadController.signal, onSnapshot);
      if (loadController.signal.aborted) return;
      // The loader's return value is authoritative: canonical order, the
      // only source for loaders that do not stream, and the transition to
      // "loaded" so the state type always means complete.
      component.setState({ type: "loaded", snapshots });
      tui.requestRender();
    }

    void load();

    return {
      render: (width: number) => component.render(width),
      invalidate: () => component.invalidate(),
      handleInput: (data: string) => component.handleInput(data),
      dispose: () => {
        controller.abort();
        component.destroy();
      },
    };
  });

  if (result === undefined) {
    // Same as the interactive initial load: serve fresh-enough cache
    // instead of force-refetching (and re-downloading) every provider.
    const snapshots = await loadSnapshots(false);
    ctx.ui.notify(formatSnapshotsForNotify(snapshots), "info");
  }
}

/**
 * Render quota snapshots as a readable multi-line summary for the
 * non-interactive fallback (when `ctx.ui.custom` returns undefined). Avoids
 * dumping raw JSON — which previously leaked raw HTTP error bodies — and
 * skips "not_applicable" providers since they have nothing to report.
 */
function formatSnapshotsForNotify(snapshots: Snapshot[]): string {
  const lines: string[] = [];
  for (const { provider, result } of snapshots) {
    if (!result.success) {
      if (result.error.kind === "not_applicable") continue;
      lines.push(`${provider}: ${result.error.message}`);
      continue;
    }
    const summary = result.data.windows
      .map((w) => `${w.label} ${formatQuotaDisplay(w)}`)
      .join(", ");
    lines.push(`${provider}: ${summary || "no windows"}`);
  }
  return lines.join("\n") || "No quota data available";
}

export function registerQuotasCommands(pi: ExtensionAPI): void {
  pi.registerCommand("quotas", {
    description: "Display remaining quotas for all supported providers",
    handler: async (_args, ctx) => {
      if (!configLoader.getConfig().quotasCommand) {
        ctx.ui.notify("/quotas is disabled. Re-enable it in /quotas:settings.", "warning");
        return;
      }
      await openQuotaView(
        "Provider Quotas",
        (force, signal, onSnapshot) =>
          fetchAllProviderQuotas(quotaAuthStorage(ctx.modelRegistry), {
            force,
            signal,
            onSnapshot,
          }),
        ctx,
      );
    },
  });

  for (const provider of SUPPORTED_PROVIDERS) {
    const info = getProviderCommandInfo(provider);
    pi.registerCommand(info.commandName, {
      description: `Display remaining ${info.title.toLowerCase()}`,
      handler: async (_args, ctx) => {
        if (!configLoader.getConfig().providerCommands) {
          ctx.ui.notify(`${info.commandName} is disabled. Re-enable it in /quotas:settings.`, "warning");
          return;
        }
        await openQuotaView(
          info.title,
          async (force, signal) => [
            {
              provider,
              result: await fetchProviderQuotas(quotaAuthStorage(ctx.modelRegistry), provider, { force, signal }),
            },
          ],
          ctx,
        );
      },
    });
  }
}

export default async function (pi: ExtensionAPI) {
  await configLoader.load();

  const config = configLoader.getConfig();
  if (config.quotasCommand || config.providerCommands) {
    registerQuotasCommands(pi);
  }

  pi.events.on(QUOTAS_EXTENSIONS_REQUEST_EVENT, () => {
    if (configLoader.getConfig().quotasCommand) {
      pi.events.emit(QUOTAS_EXTENSIONS_REGISTER_EVENT, { feature: "quotasCommand" });
    }
    if (configLoader.getConfig().providerCommands) {
      pi.events.emit(QUOTAS_EXTENSIONS_REGISTER_EVENT, { feature: "providerCommands" });
    }
  });
}
