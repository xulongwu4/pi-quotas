import type { QuotaWindow } from "../types/quotas.js";
import { safePercent } from "../utils/quotas-severity.js";

/** Parse a reset timestamp; null means "no reset / unknown". Never
 * returns an Invalid Date: overflow/Infinity timestamps map to null so
 * the resetsAt != null checks downstream mean "a real reset exists". */
function parseDateish(value: unknown): Date | null {
  if (typeof value === "number") {
    if (!(value > 0)) return null;
    const ms = value > 10 ** 11 ? value : value * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value === "string") {
    // Numeric unix-second/ms strings (e.g. "1789632000") are not ISO-8601;
    // new Date("1789632000") is Invalid Date, so coerce to the number path.
    if (/^\d+$/.test(value)) return parseDateish(Number(value));
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

/** Percent-only window kind; spread into the push so the value is
 * written once and no dummy usedValue/limitValue pair can leak into a
 * percent window (a new surface formatting from raw counts would then
 * mis-render true percents the same as true counts). */
function percentOnly(
  usedPercent: number,
): Pick<Extract<QuotaWindow, { kind: "percent" }>, "usedPercent" | "kind"> {
  return { usedPercent, kind: "percent" };
}

function monthWindowSeconds(resetAt: Date): number {
  const approxStart = new Date(resetAt);
  approxStart.setMonth(approxStart.getMonth() - 1);
  return Math.max(
    1,
    Math.round((resetAt.getTime() - approxStart.getTime()) / 1000),
  );
}

export function parseAnthropicUsage(data: any): QuotaWindow[] {
  const windows: QuotaWindow[] = [];

  if (data?.five_hour) {
    windows.push({
      provider: "anthropic",
      label: "5h",
      resetsAt: parseDateish(data.five_hour.resets_at),
      windowSeconds: 5 * 60 * 60,
      ...percentOnly(Number(data.five_hour.utilization ?? 0)),
      showPace: false,
      nextLabel: "Resets",
    });
  }

  if (data?.seven_day) {
    windows.push({
      provider: "anthropic",
      label: "7d",
      resetsAt: parseDateish(data.seven_day.resets_at),
      windowSeconds: 7 * 24 * 60 * 60,
      ...percentOnly(Number(data.seven_day.utilization ?? 0)),
      showPace: false,
      nextLabel: "Resets",
    });
  }

  // Per-model 7d windows
  const modelWindows: Array<[string, string]> = [
    ["seven_day_sonnet", "7d Sonnet"],
    ["seven_day_omelette", "7d Opus"],
    ["seven_day_fable", "7d Fable"],
    ["seven_day_opus", "7d Opus (legacy)"],
  ];
  for (const [key, label] of modelWindows) {
    const entry = data?.[key];
    if (entry && typeof entry === "object" && entry.utilization != null) {
      windows.push({
        provider: "anthropic",
        label,
        resetsAt: parseDateish(entry.resets_at),
        windowSeconds: 7 * 24 * 60 * 60,
        ...percentOnly(Number(entry.utilization)),
        showPace: false,
        nextLabel: "Resets",
      });
    }
  }

  // Modern limits[] format: per-model scoped weekly windows (e.g. Fable).
  // Generic kinds (session/weekly_all) duplicate the 5h/7d windows above.
  const existing = new Set(windows.map((w) => w.label));
  for (const entry of Array.isArray(data?.limits) ? data.limits : []) {
    if (entry?.kind !== "weekly_scoped") continue;
    const model = entry.scope?.model?.display_name;
    if (typeof model !== "string" || !model) continue;
    const label = `7d ${model}`;
    if (existing.has(label)) continue;
    existing.add(label);
    windows.push({
      provider: "anthropic",
      label,
      resetsAt: parseDateish(entry.resets_at),
      windowSeconds: 7 * 24 * 60 * 60,
      ...percentOnly(Number(entry.percent ?? 0)),
      showPace: false,
      nextLabel: "Resets",
    });
  }

  // Extra usage (overage budget)
  const extra = data?.extra_usage;
  if (extra && extra.is_enabled && extra.monthly_limit > 0) {
    const limitDollars = extra.monthly_limit / 100;
    const usedDollars = (extra.used_credits ?? 0) / 100;
    const currency = extra.currency ?? "USD";
    windows.push({
      provider: "anthropic",
      label: `Extra (${currency})`,
      usedPercent: Number(
        extra.utilization ?? safePercent(usedDollars, limitDollars),
      ),
      resetsAt: new Date(
        new Date().getFullYear(),
        new Date().getMonth() + 1,
        1,
      ),
      windowSeconds: 30 * 24 * 60 * 60,
      usedValue: usedDollars,
      limitValue: limitDollars,
      kind: "currency",
      showPace: true,
      paceScale: 1,
      nextLabel: "Resets",
    });
  }

  return windows;
}

function percentLeftToUsedPercent(limit: any): number {
  if (limit?.percent_left != null)
    return Math.max(0, 100 - Number(limit.percent_left));
  if (limit?.remaining_percent != null)
    return Math.max(0, 100 - Number(limit.remaining_percent));
  if (limit?.used_percent != null) return Number(limit.used_percent);
  return 0;
}

function codexWindowSeconds(value: unknown, fallback: number): number {
  const seconds = Number(value ?? fallback);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : fallback;
}

function codexWindowLabel(windowSeconds: number): string {
  if (windowSeconds % (24 * 60 * 60) === 0)
    return `${windowSeconds / (24 * 60 * 60)}d`;
  if (windowSeconds % (60 * 60) === 0)
    return `${windowSeconds / (60 * 60)}h`;
  if (windowSeconds % 60 === 0) return `${windowSeconds / 60}m`;
  return `${windowSeconds}s`;
}

export function parseCodexUsage(data: any): QuotaWindow[] {
  const rateLimit = data?.rate_limit ?? data?.rate_limits ?? {};
  const primary =
    rateLimit.primary_window ??
    rateLimit.primary ??
    rateLimit.five_hour_limit ??
    rateLimit.five_hour;
  const secondary =
    rateLimit.secondary_window ??
    rateLimit.secondary ??
    rateLimit.weekly_limit ??
    rateLimit.weekly;

  const windows: QuotaWindow[] = [];

  if (primary) {
    const windowSeconds = codexWindowSeconds(
      primary.limit_window_seconds,
      5 * 60 * 60,
    );
    windows.push({
      provider: "openai-codex",
      label: codexWindowLabel(windowSeconds),
      resetsAt: parseDateish(primary.reset_at ?? primary.reset_time_ms),
      windowSeconds,
      ...percentOnly(percentLeftToUsedPercent(primary)),
      showPace: false,
      nextLabel: "Resets",
    });
  }

  if (secondary) {
    const windowSeconds = codexWindowSeconds(
      secondary.limit_window_seconds,
      7 * 24 * 60 * 60,
    );
    windows.push({
      provider: "openai-codex",
      label: codexWindowLabel(windowSeconds),
      resetsAt: parseDateish(secondary.reset_at ?? secondary.reset_time_ms),
      windowSeconds,
      ...percentOnly(percentLeftToUsedPercent(secondary)),
      showPace: false,
      nextLabel: "Resets",
    });
  }

  // Credits balance
  const credits = data?.credits;
  if (credits && credits.has_credits && credits.balance != null) {
    const balance = Number(credits.balance);
    windows.push({
      provider: "openai-codex",
      label: "Credits",
      usedPercent: 0,
      resetsAt: null,
      windowSeconds: 0,
      usedValue: balance,
      limitValue: balance,
      kind: "currency",
      showPace: false,
      nextLabel: credits.approx_local_messages
        ? `~${credits.approx_local_messages} local msgs`
        : undefined,
    });
  }

  // Spend control
  const spendControl = data?.spend_control;
  if (spendControl) {
    const reached = !!spendControl.reached;
    windows.push({
      provider: "openai-codex",
      label: "Spend cap",
      usedPercent: reached ? 100 : 0,
      resetsAt: null,
      windowSeconds: 0,
      kind: "spend-cap",
      limited: reached,
      showPace: false,
      nextLabel: reached ? "Reached" : "OK",
    });
  }

  return windows;
}

export function parseGitHubCopilotUsage(data: any): QuotaWindow[] {
  const windows: QuotaWindow[] = [];

  const resetAt = parseDateish(
    data?.quota_reset_date ??
      data?.quota_reset_date_utc ??
      data?.limited_user_reset_date,
  );
  const periodSeconds =
    resetAt != null ? monthWindowSeconds(resetAt) : 30 * 24 * 60 * 60;

  const snapshots = data?.quota_snapshots;
  if (snapshots && typeof snapshots === "object") {
    const mappings: Array<[string, string]> = [
      ["premium_interactions", "Premium / month"],
      ["chat", "Chat / month"],
      ["completions", "Completions / month"],
    ];

    for (const [key, label] of mappings) {
      const snap = snapshots[key];
      if (!snap || snap.unlimited) continue;
      const entitlement = Number(snap.entitlement ?? 0);
      const remaining = Number(snap.remaining ?? snap.quota_remaining ?? 0);
      if (entitlement <= 0) continue;
      const overageCount = Number(snap.overage_count ?? 0);
      const overagePermitted = !!snap.overage_permitted;
      windows.push({
        provider: "github-copilot",
        label,
        usedPercent: safePercent(entitlement - remaining, entitlement),
        resetsAt: resetAt,
        windowSeconds: periodSeconds,
        usedValue: entitlement - remaining,
        limitValue: entitlement,
        kind: "counts",
        showPace: true,
        nextLabel: "Resets",
        nextAmount:
          overageCount > 0
            ? `+${overageCount} overage`
            : overagePermitted
              ? "overage allowed"
              : undefined,
      });
    }
    return windows;
  }

  if (data?.monthly_quotas && data?.limited_user_quotas) {
    for (const [key, label] of [
      ["chat", "Chat / month"],
      ["completions", "Completions / month"],
    ] as const) {
      const limitValue = Number(data.monthly_quotas[key] ?? 0);
      const remaining = Number(data.limited_user_quotas[key] ?? 0);
      if (limitValue <= 0) continue;
      windows.push({
        provider: "github-copilot",
        label,
        usedPercent: safePercent(limitValue - remaining, limitValue),
        resetsAt: resetAt,
        windowSeconds: periodSeconds,
        usedValue: limitValue - remaining,
        limitValue,
        kind: "counts",
        showPace: true,
        nextLabel: "Resets",
      });
    }
  }

  return windows;
}

// Helper functions for OpenRouter date calculations (UTC-based)
function calculateNextMidnightUTC(): Date {
  const now = new Date();
  const midnight = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + 1,
      0,
      0,
      0,
    ),
  );
  return midnight;
}

function calculateNextMondayUTC(): Date {
  const now = new Date();
  const day = now.getUTCDay(); // 0 = Sunday, 1 = Monday, etc.
  const daysUntilMonday = day === 0 ? 1 : 8 - day; // Days until next Monday
  const monday = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + daysUntilMonday,
      0,
      0,
      0,
    ),
  );
  return monday;
}

function calculateNextMonthStartUTC(): Date {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0),
  );
}

export function parseOpenRouterUsage(data: any): QuotaWindow[] {
  const windows: QuotaWindow[] = [];
  const keyData = data?.data;

  if (!keyData) return windows;

  const limit = keyData.limit;
  const limitRemaining = keyData.limit_remaining;
  const usageDaily = keyData.usage_daily ?? 0;
  const usageWeekly = keyData.usage_weekly ?? 0;
  const usageMonthly = keyData.usage_monthly ?? 0;

  // Monthly budget window (if limit is set)
  if (limit != null && limit > 0) {
    const usedPercent = safePercent(usageMonthly, limit);
    windows.push({
      provider: "openrouter",
      label: "Monthly Budget",
      usedPercent,
      resetsAt: calculateNextMonthStartUTC(),
      windowSeconds: 30 * 24 * 60 * 60,
      usedValue: usageMonthly,
      limitValue: limit,
      kind: "currency",
      showPace: true,
      paceScale: 1,
      nextLabel: "Resets",
    });
  } else if (limitRemaining != null && limitRemaining >= 0) {
    // Unlimited key with remaining tracked
    windows.push({
      provider: "openrouter",
      label: "Credits Remaining",
      usedPercent: 0,
      resetsAt: null,
      windowSeconds: 0,
      usedValue: limitRemaining,
      limitValue: limitRemaining,
      kind: "currency",
      showPace: false,
      nextLabel: undefined,
    });
  }

  // Daily usage window (tracking only)
  windows.push({
    provider: "openrouter",
    label: "Daily",
    usedPercent: 0,
    resetsAt: calculateNextMidnightUTC(),
    windowSeconds: 24 * 60 * 60,
    usedValue: usageDaily,
    limitValue: 0,
    kind: "currency",
    showPace: false,
    nextLabel: "UTC",
  });

  // Weekly usage window (tracking only)
  windows.push({
    provider: "openrouter",
    label: "Weekly",
    usedPercent: 0,
    resetsAt: calculateNextMondayUTC(),
    windowSeconds: 7 * 24 * 60 * 60,
    usedValue: usageWeekly,
    limitValue: 0,
    kind: "currency",
    showPace: false,
    nextLabel: "Week",
  });

  // Monthly usage window (tracking only)
  windows.push({
    provider: "openrouter",
    label: "Monthly",
    usedPercent: 0,
    resetsAt: calculateNextMonthStartUTC(),
    windowSeconds: 30 * 24 * 60 * 60,
    usedValue: usageMonthly,
    limitValue: 0,
    kind: "currency",
    showPace: false,
    nextLabel: "Month",
  });

  return windows;
}

/** Parse currency strings like "$24.00" to a number */
function parseCurrency(value: string): number {
  const n = Number(value.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

export function parseSyntheticUsage(data: any): QuotaWindow[] {
  const windows: QuotaWindow[] = [];

  // Weekly token/credit limit (primary window for paid plans)
  if (data?.weeklyTokenLimit) {
    const limitValue = parseCurrency(data.weeklyTokenLimit.maxCredits);
    const remainingValue = parseCurrency(data.weeklyTokenLimit.remainingCredits);
    windows.push({
      provider: "synthetic",
      label: "Credits / week",
      usedPercent: Math.max(0, Math.min(100, 100 - data.weeklyTokenLimit.percentRemaining)),
      resetsAt: parseDateish(data.weeklyTokenLimit.nextRegenAt),
      windowSeconds: 24 * 60 * 60,
      usedValue: limitValue - remainingValue,
      limitValue,
      kind: "currency",
      showPace: true,
      paceScale: 1 / 7,
      nextAmount: `+${data.weeklyTokenLimit.nextRegenCredits}`,
      nextLabel: "Next regen",
    });
  }

  // Rolling 5-hour request limit
  if (data?.rollingFiveHourLimit && data.rollingFiveHourLimit.max > 0) {
    const used =
      data.rollingFiveHourLimit.max - data.rollingFiveHourLimit.remaining;
    windows.push({
      provider: "synthetic",
      label: "Requests / 5h",
      usedPercent: safePercent(used, data.rollingFiveHourLimit.max),
      resetsAt: parseDateish(data.rollingFiveHourLimit.nextTickAt),
      windowSeconds: 5 * 60 * 60,
      usedValue: Math.round(used),
      limitValue: data.rollingFiveHourLimit.max,
      kind: "counts",
      showPace: false,
      limited: data.rollingFiveHourLimit.limited,
      nextLabel: data.rollingFiveHourLimit.limited ? "Limited" : "Resets",
    });
  }

  // Search hourly (only if limit > 0)
  if (data?.search?.hourly?.limit && data.search.hourly.limit > 0) {
    windows.push({
      provider: "synthetic",
      label: "Search / hour",
      usedPercent: safePercent(
        data.search.hourly.requests,
        data.search.hourly.limit,
      ),
      resetsAt: parseDateish(data.search.hourly.renewsAt),
      windowSeconds: 60 * 60,
      usedValue: data.search.hourly.requests,
      limitValue: data.search.hourly.limit,
      kind: "counts",
      showPace: true,
      paceScale: 1,
      nextLabel: "Resets",
    });
  }

  // Free tool calls (only if limit > 0)
  if (data?.freeToolCalls?.limit && data.freeToolCalls.limit > 0) {
    windows.push({
      provider: "synthetic",
      label: "Free Tool Calls / day",
      usedPercent: safePercent(
        data.freeToolCalls.requests,
        data.freeToolCalls.limit,
      ),
      resetsAt: parseDateish(data.freeToolCalls.renewsAt),
      windowSeconds: 24 * 60 * 60,
      usedValue: data.freeToolCalls.requests,
      limitValue: data.freeToolCalls.limit,
      kind: "counts",
      showPace: true,
      paceScale: 1,
      nextLabel: "Resets",
    });
  }

  return windows;
}

export function parseOpenCodeGoUsage(data: any): QuotaWindow[] {
  const windows: QuotaWindow[] = [];
  if (!data || typeof data !== "object") return windows;

  const usage = data?.usage ?? data;

  if (usage.rolling && typeof usage.rolling === "object") {
    const raw = usage.rolling;
    const usedPercent = Number(raw.percent ?? raw.usagePercent ?? 0);
    const resetsAt = parseDateish(
      raw.resetsAt ??
        raw.resetTimeIso ??
        (raw.resetInSec ? Date.now() + Number(raw.resetInSec) * 1000 : undefined),
    );
    windows.push({
      provider: "opencode-go",
      label: "5h Rolling",
      resetsAt,
      windowSeconds: 5 * 60 * 60,
      ...percentOnly(usedPercent),
      showPace: false,
      nextLabel: "Resets",
    });
  }

  if (usage.weekly && typeof usage.weekly === "object") {
    const raw = usage.weekly;
    const usedPercent = Number(raw.percent ?? raw.usagePercent ?? 0);
    const resetsAt = parseDateish(
      raw.resetsAt ??
        raw.resetTimeIso ??
        (raw.resetInSec ? Date.now() + Number(raw.resetInSec) * 1000 : undefined),
    );
    windows.push({
      provider: "opencode-go",
      label: "Weekly",
      resetsAt,
      windowSeconds: 7 * 24 * 60 * 60,
      ...percentOnly(usedPercent),
      showPace: true,
      paceScale: 1,
      nextLabel: "Resets",
    });
  }

  if (usage.monthly && typeof usage.monthly === "object") {
    const raw = usage.monthly;
    const usedPercent = Number(raw.percent ?? raw.usagePercent ?? 0);
    const resetsAt = parseDateish(
      raw.resetsAt ??
        raw.resetTimeIso ??
        (raw.resetInSec ? Date.now() + Number(raw.resetInSec) * 1000 : undefined),
    );
    windows.push({
      provider: "opencode-go",
      label: "Monthly",
      resetsAt,
      windowSeconds: 30 * 24 * 60 * 60,
      ...percentOnly(usedPercent),
      showPace: true,
      paceScale: 1,
      nextLabel: "Resets",
    });
  }

  return windows;
}

// Kimi Code subscription quotas. The /coding/v1/usages endpoint exposes a
// weekly allowance plus one or more shorter rolling windows.
export function parseKimiCodingUsage(data: any): QuotaWindow[] {
  const windows: QuotaWindow[] = [];

  const weekly = data?.usage;
  if (weekly && typeof weekly === "object") {
    const limit = Number(weekly.limit ?? 0);
    const used = Number(weekly.used ?? 0);
    if (Number.isFinite(limit) && Number.isFinite(used) && limit > 0) {
      windows.push({
        provider: "kimi-coding",
        label: "Weekly",
        usedPercent: safePercent(used, limit),
        resetsAt: parseDateish(weekly.resetTime),
        windowSeconds: 7 * 24 * 60 * 60,
        usedValue: used,
        limitValue: limit,
        kind: "counts",
        showPace: true,
        limited: used >= limit,
        nextLabel: "Resets",
      });
    }
  }

  const limits = Array.isArray(data?.limits) ? data.limits : [];
  for (const entry of limits) {
    const detail = entry?.detail;
    const window = entry?.window;
    if (!detail || !window) continue;

    const limit = Number(detail.limit ?? 0);
    const used = Number(detail.used ?? 0);
    const duration = Number(window.duration ?? 0);
    if (
      !Number.isFinite(limit) ||
      !Number.isFinite(used) ||
      !Number.isFinite(duration) ||
      limit <= 0 ||
      duration <= 0
    ) {
      continue;
    }

    let windowSeconds: number;
    let label: string;
    switch (window.timeUnit) {
      case "TIME_UNIT_SECOND":
        windowSeconds = duration;
        label = `${duration}s`;
        break;
      case "TIME_UNIT_MINUTE":
        windowSeconds = duration * 60;
        label =
          duration % 60 === 0 ? `${duration / 60}h` : `${duration}m`;
        break;
      case "TIME_UNIT_HOUR":
        windowSeconds = duration * 60 * 60;
        label = `${duration}h`;
        break;
      case "TIME_UNIT_DAY":
        windowSeconds = duration * 24 * 60 * 60;
        label = `${duration}d`;
        break;
      default:
        continue;
    }
    windows.push({
      provider: "kimi-coding",
      label,
      usedPercent: safePercent(used, limit),
      resetsAt: parseDateish(detail.resetTime),
      windowSeconds,
      usedValue: used,
      limitValue: limit,
      kind: "counts",
      showPace: false,
      limited: used >= limit,
      nextLabel: "Resets",
    });
  }

  windows.sort((a, b) => a.windowSeconds - b.windowSeconds);
  return windows;
}

// Z.ai (Zhipu AI) GLM Coding Plan quotas.
//
// The quota endpoint returns { data: { limits: [...], level } }. Each entry in
// `limits` is either a TOKENS_LIMIT (token utilisation, reported as a bare
// `percentage` with no absolute used/limit counts) or a TIME_LIMIT (a monthly
// count window such as web searches, which does carry real used/limit counts).
//
// The window length is encoded as (unit, number). Observed values:
//   unit 3 = HOUR  (e.g. the rolling 5-hour session window)
//   unit 6 = WEEK  (e.g. the rolling 7-day weekly window)
//   unit 5 = MONTH (TIME_LIMIT only, the monthly count window)
// Reset times are epoch milliseconds.
export function parseZaiUsage(data: any): QuotaWindow[] {
  const collected: QuotaWindow[] = [];

  const limits: any[] = data?.data?.limits ?? data?.limits ?? [];
  if (!Array.isArray(limits)) return collected;

  for (const entry of limits) {
    if (!entry || typeof entry !== "object") continue;

    // Token windows only expose a percentage, so — like Anthropic/Codex — we
    // report usedValue as the percentage against a nominal limit of 100.
    if (entry.type === "TOKENS_LIMIT") {
      const unit = entry.unit;
      const count = Number(entry.number ?? 1) || 1;
      let label: string;
      let windowSeconds: number;

      switch (unit) {
        case 3: // HOUR
          label = `${count}h`;
          windowSeconds = count * 60 * 60;
          break;
        case 4: // DAY (defensive — not observed, but handled)
          label = `${count}d`;
          windowSeconds = count * 24 * 60 * 60;
          break;
        case 6: // WEEK
          label = `${count * 7}d`;
          windowSeconds = count * 7 * 24 * 60 * 60;
          break;
        default:
          // Unknown unit — still surface it so usage is never silently hidden.
          label = "Tokens";
          windowSeconds = 0;
          break;
      }

      collected.push({
        provider: "zai",
        label,
        resetsAt: parseDateish(entry.nextResetTime),
        windowSeconds,
        ...percentOnly(Number(entry.percentage ?? 0)),
        showPace: false,
        nextLabel: "Resets",
      });
      continue;
    }

    // Monthly web-search / tool-call count window. Here z.ai gives real
    // counts: `usage` is the entitlement, `currentValue` is what's been used.
    if (entry.type === "TIME_LIMIT") {
      const limit = Number(entry.usage ?? 0);
      const used = Number(entry.currentValue ?? 0);
      if (limit <= 0) continue;

      collected.push({
        provider: "zai",
        label: "Web / month",
        usedPercent: safePercent(used, limit),
        resetsAt: parseDateish(entry.nextResetTime),
        windowSeconds: 30 * 24 * 60 * 60,
        usedValue: used,
        limitValue: limit,
        kind: "counts",
        showPace: false,
        nextLabel: "Resets",
      });
    }
  }

  // Shortest window first (5h → 7d → month), matching Anthropic/Codex order.
  collected.sort((a, b) => a.windowSeconds - b.windowSeconds);
  return collected;
}

// Grok (xAI) consumer subscription quotas from the CLI chat proxy.
export function parseGrokUsage(data: any): QuotaWindow[] {
  const windows: QuotaWindow[] = [];
  if (!data || typeof data !== "object") return windows;

  const config = data.config ?? data;
  const resetRaw =
    config?.currentPeriod?.end ??
    config?.billingPeriodEnd ??
    data?.currentPeriod?.end ??
    data?.billingPeriodEnd;
  const resetsAt = parseDateish(resetRaw);

  const rawPercent =
    typeof config?.creditUsagePercent === "number"
      ? config.creditUsagePercent
      : typeof data?.creditUsagePercent === "number"
        ? data.creditUsagePercent
        : undefined;

  const cap = Number(config?.onDemandCap?.val ?? data?.onDemandCap?.val ?? 0);
  const used = Number(
    config?.onDemandUsed?.val ?? data?.onDemandUsed?.val ?? 0,
  );

  let usedPercent: number | undefined;
  if (rawPercent != null && Number.isFinite(rawPercent)) {
    usedPercent = Math.max(0, Math.min(100, rawPercent));
  } else if (cap > 0 && Number.isFinite(used)) {
    usedPercent = safePercent(used, cap);
  } else if (resetsAt != null) {
    usedPercent = 0;
  }

  if (usedPercent == null) return windows;

  const windowSeconds =
    resetsAt != null ? monthWindowSeconds(resetsAt) : 30 * 24 * 60 * 60;
  const value =
    cap > 0 && Number.isFinite(used)
      ? ({
        kind: "counts",
        usedPercent,
        usedValue: used,
        limitValue: cap,
      } as const)
      : percentOnly(usedPercent);

  windows.push({
    provider: "grok",
    label: "Subscription",
    resetsAt,
    windowSeconds,
    ...value,
    showPace: true,
    nextLabel: "Resets",
  });

  return windows;
}

// Google Antigravity quota parser (RetrieveUserQuotaSummary, fetchAvailableModels & GetUserStatus formats).
export function parseAntigravityUsage(data: any): QuotaWindow[] {
  const windows: QuotaWindow[] = [];
  if (!data || typeof data !== "object") return windows;

  // 1) Primary: RetrieveUserQuotaSummary format (live dynamic buckets from local daemon / verified source)
  const groups = data?.response?.groups ?? data?.groups;
  if (Array.isArray(groups)) {
    for (const group of groups) {
      if (!group || typeof group !== "object") continue;
      const groupName = String(group.displayName ?? "");
      const isGemini = groupName.toLowerCase().includes("gemini");
      const prefix = isGemini ? "Gemini" : "Claude/GPT";

      const buckets = Array.isArray(group.buckets) ? group.buckets : [];
      for (const bucket of buckets) {
        if (!bucket || typeof bucket !== "object") continue;
        const bucketId = String(bucket.bucketId ?? "").toLowerCase();
        const displayName = String(bucket.displayName ?? "").toLowerCase();

        const fraction =
          bucket.remaining?.remainingFraction ??
          bucket.remaining?.value ??
          bucket.remainingFraction;
        if (typeof fraction !== "number" || !Number.isFinite(fraction)) continue;

        const is5h =
          bucketId.includes("5h") ||
          bucketId.includes("session") ||
          displayName.includes("5h") ||
          displayName.includes("five") ||
          displayName.includes("session");
        const isWeekly =
          bucketId.includes("week") ||
          bucketId.includes("7d") ||
          displayName.includes("week") ||
          displayName.includes("7d");

        const cadence = is5h ? "5h" : isWeekly ? "7d" : bucket.displayName || "Quota";
        const windowSeconds = is5h ? 5 * 60 * 60 : isWeekly ? 7 * 24 * 60 * 60 : 24 * 60 * 60;
        const usedPercent = Math.max(0, Math.min(100, Math.round((1 - fraction) * 100)));

        windows.push({
          provider: "antigravity",
          label: `${prefix} ${cadence}`,
          resetsAt: parseDateish(bucket.resetTime),
          windowSeconds,
          ...percentOnly(usedPercent),
          showPace: isWeekly,
          nextLabel: "Resets",
        });
      }
    }
    if (windows.length > 0) {
      windows.sort((a, b) => a.windowSeconds - b.windowSeconds);
      return windows;
    }
  }

  // 2) GetUserStatus / GetCommandModelConfigs format (with real dynamic fractions)
  const configs =
    data?.userStatus?.cascadeModelConfigData?.clientModelConfigs ??
    data?.cascadeModelConfigData?.clientModelConfigs ??
    data?.clientModelConfigs;
  if (Array.isArray(configs)) {
    for (const config of configs) {
      if (!config || typeof config !== "object") continue;
      const fraction = config?.quotaInfo?.remainingFraction;
      if (typeof fraction !== "number" || !Number.isFinite(fraction)) continue;

      const label = config.label ?? config.modelOrAlias?.model ?? "Gemini";
      const usedPercent = Math.max(0, Math.min(100, Math.round((1 - fraction) * 100)));

      windows.push({
        provider: "antigravity",
        label,
        resetsAt: parseDateish(config?.quotaInfo?.resetTime),
        windowSeconds: 5 * 60 * 60,
        ...percentOnly(usedPercent),
        showPace: false,
        nextLabel: "Resets",
      });
    }
    if (windows.length > 0) {
      windows.sort((a, b) => a.windowSeconds - b.windowSeconds);
      return windows;
    }
  }

  // 3) fetchAvailableModels format (models dictionary). Every model in a pool
  // shares one fraction/resetTime; remainingFraction 1.0 is real "unused" data
  // when querying the host that actually serves traffic (see antigravityBaseUrl).
  if (data?.models && typeof data.models === "object") {
    const models = data.models as Record<string, any>;
    let minGeminiFraction = 1;
    let geminiResetTime: string | undefined;
    let minClaudeGptFraction = 1;
    let claudeGptResetTime: string | undefined;
    let hasGemini = false;
    let hasClaudeGpt = false;

    for (const [modelId, modelObj] of Object.entries(models)) {
      if (!modelObj || typeof modelObj !== "object") continue;
      const fraction = modelObj?.quotaInfo?.remainingFraction;
      if (typeof fraction !== "number" || !Number.isFinite(fraction)) continue;
      const resetTime = modelObj?.quotaInfo?.resetTime;
      const id = modelId.toLowerCase();

      if (id.includes("gemini")) {
        hasGemini = true;
        if (fraction < minGeminiFraction) {
          minGeminiFraction = fraction;
          geminiResetTime = resetTime;
        } else if (!geminiResetTime && resetTime) {
          geminiResetTime = resetTime;
        }
      } else if (id.includes("claude") || id.includes("gpt")) {
        hasClaudeGpt = true;
        if (fraction < minClaudeGptFraction) {
          minClaudeGptFraction = fraction;
          claudeGptResetTime = resetTime;
        } else if (!claudeGptResetTime && resetTime) {
          claudeGptResetTime = resetTime;
        }
      }
    }

    // ponytail: the API doesn't say which pool a per-model bucket is; infer 7d vs 5h
    // from how far out the reset is. Use retrieveUserQuotaSummary for exact buckets.
    const pushPool = (prefix: string, fraction: number, resetTime: string | undefined) => {
      const resetsAt = parseDateish(resetTime);
      const isWeekly =
        resetsAt != null && resetsAt.getTime() - Date.now() > 5 * 60 * 60 * 1000;
      const usedPercent = Math.max(0, Math.min(100, Math.round((1 - fraction) * 100)));
      windows.push({
        provider: "antigravity",
        label: `${prefix} ${isWeekly ? "7d" : "5h"}`,
        resetsAt,
        windowSeconds: isWeekly ? 7 * 24 * 60 * 60 : 5 * 60 * 60,
        ...percentOnly(usedPercent),
        showPace: isWeekly,
        nextLabel: "Resets",
      });
    };
    if (hasGemini) pushPool("Gemini", minGeminiFraction, geminiResetTime);
    if (hasClaudeGpt) pushPool("Claude/GPT", minClaudeGptFraction, claudeGptResetTime);
  }

  windows.sort((a, b) => a.windowSeconds - b.windowSeconds);
  return windows;
}

// Devin (Cognition) quotas from the Connect GetUserStatus endpoint on
// server.codeium.com (the same Windsurf backend pi-devin streams through).
// planStatus exposes "remaining percent" values, so they are inverted here.
// Reset times are Unix seconds (sometimes as strings).
export function parseDevinUsage(data: any): QuotaWindow[] {
  const windows: QuotaWindow[] = [];
  const status = data?.userStatus ?? data;
  const plan = status?.planStatus;

  const pushPercentWindow = (
    label: string,
    remainingPercentValue: unknown,
    resetAt: unknown,
    windowSeconds: number,
  ): void => {
    // Number(null) is 0, so a JSON null must be skipped explicitly or the
    // window would render as fully used.
    if (remainingPercentValue == null) return;
    const remainingPercent = Number(remainingPercentValue);
    if (!Number.isFinite(remainingPercent)) return;
    // The kind is declared at the producer; remaining outside 0..100
    // must not leak an unclamped percent next to the bar.
    const usedPercent = Math.max(0, Math.min(100, 100 - remainingPercent));
    windows.push({
      provider: "devin",
      label,
      resetsAt: parseDateish(resetAt),
      windowSeconds,
      ...percentOnly(usedPercent),
      showPace: false,
      nextLabel: "Resets",
    });
  };

  pushPercentWindow(
    "Daily",
    plan?.dailyQuotaRemainingPercent,
    plan?.dailyQuotaResetAtUnix,
    24 * 60 * 60,
  );
  pushPercentWindow(
    "Weekly",
    plan?.weeklyQuotaRemainingPercent,
    plan?.weeklyQuotaResetAtUnix,
    7 * 24 * 60 * 60,
  );

  const monthlyCredits = Number(plan?.planInfo?.monthlyPromptCredits ?? 0);
  const availableCreditsValue =
    plan?.availablePromptCredits ?? plan?.availableFlexCredits;
  // Number(null) is 0: an explicit JSON null must skip the window rather
  // than render the credits as fully used.
  const availableCredits = Number(availableCreditsValue);
  if (
    monthlyCredits > 0 &&
    availableCreditsValue != null &&
    Number.isFinite(availableCredits)
  ) {
    // No billing reset exists in GetUserStatus, so this is a balance-style
    // window (windowSeconds 0, null reset) like Codex/OpenRouter credits.
    // kind:"counts" keeps this on the real-counts path even when
    // monthlyPromptCredits is exactly 100.
    const usedCredits = Math.max(0, monthlyCredits - availableCredits);
    windows.push({
      provider: "devin",
      label: "Credits / month",
      usedPercent: safePercent(usedCredits, monthlyCredits),
      resetsAt: null,
      windowSeconds: 0,
      usedValue: usedCredits,
      limitValue: monthlyCredits,
      kind: "counts",
      showPace: false,
    });
  }

  return windows;
}
