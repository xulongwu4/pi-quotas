export type SupportedQuotaProvider =
  | "anthropic"
  | "openai-codex"
  | "github-copilot"
  | "openrouter"
  | "synthetic"
  | "zai"
  | "opencode-go"
  | "kimi-coding"
  | "grok"
  | "antigravity"
  | "devin";

export type QuotasErrorKind =
  | "cancelled"
  | "timeout"
  | "config"
  | "http"
  | "network"
  // The provider is not applicable for the stored credential type
  // (e.g. a direct Anthropic API key has no OAuth subscription usage to
  // report). Consumers should render this silently rather than as a warning.
  | "not_applicable";

export type QuotasResult =
  | {
      success: true;
      data: { windows: QuotaWindow[]; provider: SupportedQuotaProvider };
    }
  | { success: false; error: { message: string; kind: QuotasErrorKind } };

/** How a quota window's value is expressed. */
export type QuotaWindowKind =
  | "percent" // e.g. Anthropic 5h: usedPercent only
  | "counts" // e.g. Copilot premium: usedValue/limitValue units
  | "currency" // e.g. OpenRouter credits: usedValue/limitValue dollars
  | "spend-cap"; // e.g. Codex spend cap: binary REACHED/OK

interface QuotaWindowBase {
  provider: SupportedQuotaProvider;
  label: string;
  usedPercent: number;
  /** Reset time, or null for balance-style windows with no reset
   * (e.g. credits without a billing cycle). Producers must supply either
   * null or a valid Date (parseDateish guarantees this). */
  resetsAt: Date | null;
  windowSeconds: number;
  showPace?: boolean;
  paceScale?: number;
  limited?: boolean;
  nextAmount?: string;
  nextLabel?: string;
}

/** Strictly discriminated quota value shape: percent windows cannot carry
 * synthetic counts, while counts/currency/spend-cap windows must provide a
 * real used/limit pair. */
export type QuotaWindow =
  | (QuotaWindowBase & {
      kind: "percent";
      usedValue?: never;
      limitValue?: never;
    })
  | (QuotaWindowBase & {
      kind: "counts" | "currency";
      usedValue: number;
      limitValue: number;
    })
  | (QuotaWindowBase & {
      kind: "spend-cap";
      usedValue?: never;
      limitValue?: never;
    });
