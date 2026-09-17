import type { QuotaWindow } from "../../types/quotas.js";
import {
  formatQuotaDisplay,
  remainingPercent,
} from "../../utils/quotas-format.js";
import type { RiskSeverity } from "../../utils/quotas-severity.js";
import { getSeverityColor } from "../../utils/quotas-severity.js";

// Mirror QuotaWindow's kind/value fields via Pick so a new kind field
// on QuotaWindow automatically flows here (toWindowStatus fails to
// compile until it copies the field).
type WindowStatusFor<W extends QuotaWindow> = W extends QuotaWindow
  ? Pick<
      W,
      | "provider"
      | "label"
      | "usedPercent"
      | "limited"
      | "kind"
      | "usedValue"
      | "limitValue"
    > & {
      severity: RiskSeverity;
      resetsAt: Date | null;
    }
  : never;

export type WindowStatus = WindowStatusFor<QuotaWindow>;

export interface ThemeLike {
  fg(color: string, text: string): string;
}

const SHORT_LABELS: Record<string, string> = {
  "5h": "5h",
  "7d": "7d",
  "7d Sonnet": "7d-son",
  "7d Fable": "7d-fable",
  "7d Opus": "7d-opus",
  "7d Opus (legacy)": "7d-opus",
  "Premium / month": "premium",
  "Chat / month": "chat",
  "Completions / month": "comp",
  "Spend cap": "cap",
  "Credits": "credits",
  "Credits / month": "credits",
  "Extra (AUD)": "extra",
  "Extra (USD)": "extra",
  "Extra (EUR)": "extra",
  "Extra (GBP)": "extra",
  // OpenRouter labels
  "Monthly Budget": "budget",
  "Credits Remaining": "credits",
  "Daily": "daily",
  "Weekly": "weekly",
  "Monthly": "monthly",
  // Synthetic labels (match pi-synthetic extension)
  "Credits / week": "week",
  "Requests / 5h": "5h",
  "Search / hour": "search",
  "Free Tool Calls / day": "tools",
  // Grok labels
  "Subscription": "sub",
  "SuperGrok": "grok",
  "SuperGrok Heavy": "heavy",
  // Antigravity labels
  "Gemini 5h": "gem-5h",
  "Gemini 7d": "gem-7d",
  "Claude/GPT 5h": "3p-5h",
  "Claude/GPT 7d": "3p-7d",
};

/**
 * Format a single window for the footer status bar.
 *
 * - Colors both the label and value based on severity
 * - Uses used/limit for real counts (e.g. "7/300")
 * - Uses "$X/$Y" for currency windows
 * - Uses "N% left" for percentage-only windows
 * - Uses "REACHED" / "OK" for spend cap
 */
export function formatWindowStatus(theme: ThemeLike, w: WindowStatus): string {
  const short = SHORT_LABELS[w.label] ?? w.label;
  const color = getSeverityColor(w.severity);

  // Color the label based on severity: dim when safe, colored when at risk
  const isAtRisk = w.severity !== "none";
  const labelColor = isAtRisk ? color : "dim";
  const labelText = theme.fg(labelColor, `${short}:`);

  // Synthetic windows always use compact "remaining%" format
  // to match the pi-synthetic extension display.
  const isSynthetic = w.provider === "synthetic";

  let valueText: string;
  if (isSynthetic) {
    // Compact format matching pi-synthetic: just remaining%
    valueText = theme.fg(color, `${remainingPercent(w)}%`);
  } else {
    // Shared value + suffix (types/quotas) keeps footer, dashboard, and
    // notify fallback in agreement.
    valueText = theme.fg(color, formatQuotaDisplay(w));
  }

  const limitTag = w.limited ? theme.fg("error", " !") : "";
  return `${labelText}${valueText}${limitTag}`;
}
