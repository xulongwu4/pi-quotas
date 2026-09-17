import type { QuotaWindowKind } from "../types/quotas.js";

type QuotaValueWindow = {
  usedPercent: number;
  kind: QuotaWindowKind;
  limited?: boolean;
  usedValue?: number;
  limitValue?: number;
};

/** Remaining whole percent for a percent-only window (e.g. 91 left). */
export function remainingPercent(w: { usedPercent: number }): number {
  return Math.max(0, Math.min(100, Math.round(100 - w.usedPercent)));
}

function usedCounts(w: { usedValue?: number }): number {
  return Math.max(0, Math.round(w.usedValue ?? 0));
}

function remainingCounts(w: {
  usedValue?: number;
  limitValue?: number;
}): number {
  return Math.max(0, Math.round((w.limitValue ?? 0) - (w.usedValue ?? 0)));
}

function formatCurrency(w: QuotaValueWindow): string {
  const used = w.usedValue ?? 0;
  const limit = w.limitValue ?? 0;
  return limit === 0
    ? `$${used.toFixed(2)} used`
    : `$${used.toFixed(2)}/$${limit.toFixed(2)}`;
}

function formatSpendCap(w: QuotaValueWindow): string {
  return w.limited ? "REACHED" : "OK";
}

/** Remaining/display scale used by footer, dashboard, and notify fallback. */
export function formatQuotaDisplay(w: QuotaValueWindow): string {
  switch (w.kind) {
    case "percent":
      return `${remainingPercent(w)}% left`;
    case "counts":
      return `${remainingCounts(w)}/${w.limitValue ?? 0} left`;
    case "currency":
      return formatCurrency(w);
    case "spend-cap":
      return formatSpendCap(w);
  }
}

/** Used scale for quota-warning headlines; never mixes remaining and used. */
export function formatQuotaUsage(w: QuotaValueWindow): string {
  switch (w.kind) {
    case "percent":
      return `${Math.round(w.usedPercent)}% used`;
    case "counts":
      return `${usedCounts(w)}/${w.limitValue ?? 0} used`;
    case "currency": {
      const value = formatCurrency(w);
      return value.endsWith(" used") ? value : `${value} used`;
    }
    case "spend-cap":
      return formatSpendCap(w);
  }
}
