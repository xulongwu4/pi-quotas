/**
 * OpenCode Go client.
 *
 * Fetches usage data from OpenCode Go API (https://opencode.ai/zen/go/v1/usage)
 * with fallback to the dashboard webscraper if workspace ID is provided.
 *
 * Configuration:
 * - Environment: OPENCODE_API_KEY, OPENCODE_GO_API_KEY, or OPENCODE_GO_AUTH_COOKIE
 * - Config file: ~/.config/opencode/opencode-quota/opencode-go.json
 */

const USAGE_API_URL = "https://opencode.ai/zen/go/v1/usage";
const DASHBOARD_URL_PREFIX = "https://opencode.ai/workspace/";
const DASHBOARD_URL_SUFFIX = "/go";
const USER_AGENT = "pi-quotas";
const REQUEST_TIMEOUT_MS = 10_000;

const SCRAPED_NUMBER_PATTERN = String.raw`(-?\d+(?:\.\d+)?)`;

const RE_ROLLING_PCT_FIRST = new RegExp(
  String.raw`rollingUsage:\$R\[\d+\]=\{[^}]*usagePercent:${SCRAPED_NUMBER_PATTERN}[^}]*resetInSec:${SCRAPED_NUMBER_PATTERN}[^}]*\}`,
);
const RE_ROLLING_RESET_FIRST = new RegExp(
  String.raw`rollingUsage:\$R\[\d+\]=\{[^}]*resetInSec:${SCRAPED_NUMBER_PATTERN}[^}]*usagePercent:${SCRAPED_NUMBER_PATTERN}[^}]*\}`,
);

const RE_WEEKLY_PCT_FIRST = new RegExp(
  String.raw`weeklyUsage:\$R\[\d+\]=\{[^}]*usagePercent:${SCRAPED_NUMBER_PATTERN}[^}]*resetInSec:${SCRAPED_NUMBER_PATTERN}[^}]*\}`,
);
const RE_WEEKLY_RESET_FIRST = new RegExp(
  String.raw`weeklyUsage:\$R\[\d+\]=\{[^}]*resetInSec:${SCRAPED_NUMBER_PATTERN}[^}]*usagePercent:${SCRAPED_NUMBER_PATTERN}[^}]*\}`,
);

const RE_MONTHLY_PCT_FIRST = new RegExp(
  String.raw`monthlyUsage:\$R\[\d+\]=\{[^}]*usagePercent:${SCRAPED_NUMBER_PATTERN}[^}]*resetInSec:${SCRAPED_NUMBER_PATTERN}[^}]*\}`,
);
const RE_MONTHLY_RESET_FIRST = new RegExp(
  String.raw`monthlyUsage:\$R\[\d+\]=\{[^}]*resetInSec:${SCRAPED_NUMBER_PATTERN}[^}]*usagePercent:${SCRAPED_NUMBER_PATTERN}[^}]*\}`,
);

interface ScrapedWindowUsage {
  usagePercent: number;
  resetInSec: number;
}

export interface OpenCodeGoWindow {
  usagePercent?: number;
  percent?: number;
  resetInSec?: number;
  percentRemaining?: number;
  resetTimeIso?: string;
  resetsAt?: string;
  status?: string;
}

export interface OpenCodeGoQuotaResult {
  success: true;
  usage?: {
    rolling?: OpenCodeGoWindow;
    weekly?: OpenCodeGoWindow;
    monthly?: OpenCodeGoWindow;
  };
  rolling?: OpenCodeGoWindow;
  weekly?: OpenCodeGoWindow;
  monthly?: OpenCodeGoWindow;
}

export interface OpenCodeGoQuotaError {
  success: false;
  error: string;
}

export type OpenCodeGoResult = OpenCodeGoQuotaResult | OpenCodeGoQuotaError;

export interface OpenCodeGoConfig {
  apiKey?: string;
  authCookie?: string;
  workspaceId?: string;
}

function parseWindowUsage(
  html: string,
  rePctFirst: RegExp,
  reResetFirst: RegExp,
): ScrapedWindowUsage | null {
  const pctFirstMatch = rePctFirst.exec(html);
  if (pctFirstMatch) {
    const usagePercent = Number(pctFirstMatch[1]);
    const resetInSec = Number(pctFirstMatch[2]);
    if (Number.isFinite(usagePercent) && Number.isFinite(resetInSec)) {
      return { usagePercent, resetInSec };
    }
  }

  const resetFirstMatch = reResetFirst.exec(html);
  if (resetFirstMatch) {
    const resetInSec = Number(resetFirstMatch[1]);
    const usagePercent = Number(resetFirstMatch[2]);
    if (Number.isFinite(usagePercent) && Number.isFinite(resetInSec)) {
      return { usagePercent, resetInSec };
    }
  }

  return null;
}

function normalizeWindowUsage(
  window: ScrapedWindowUsage,
  now: number,
): OpenCodeGoWindow {
  const usagePercent = Math.max(0, window.usagePercent);
  const resetInSec = Math.max(0, window.resetInSec);
  return {
    usagePercent,
    percent: usagePercent,
    resetInSec,
    percentRemaining: 100 - usagePercent,
    resetTimeIso: new Date(now + resetInSec * 1000).toISOString(),
    resetsAt: new Date(now + resetInSec * 1000).toISOString(),
  };
}

async function scrapeDashboardQuota(
  config: OpenCodeGoConfig,
  combinedSignal: AbortSignal,
): Promise<OpenCodeGoResult> {
  if (!config.workspaceId || !config.authCookie) {
    return {
      success: false,
      error: "OpenCode Go dashboard scraping requires workspace ID and auth cookie",
    };
  }

  const url = `${DASHBOARD_URL_PREFIX}${encodeURIComponent(config.workspaceId)}${DASHBOARD_URL_SUFFIX}`;
  const response = await fetch(url, {
    method: "GET",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Gecko/20100101 Firefox/148.0",
      Accept: "text/html",
      Cookie: `auth=${config.authCookie}`,
    },
    signal: combinedSignal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    return {
      success: false,
      error: `OpenCode Go dashboard error ${response.status}: ${text.slice(0, 120)}`,
    };
  }

  const html = await response.text();
  const rolling = parseWindowUsage(
    html,
    RE_ROLLING_PCT_FIRST,
    RE_ROLLING_RESET_FIRST,
  );
  const weekly = parseWindowUsage(
    html,
    RE_WEEKLY_PCT_FIRST,
    RE_WEEKLY_RESET_FIRST,
  );
  const monthly = parseWindowUsage(
    html,
    RE_MONTHLY_PCT_FIRST,
    RE_MONTHLY_RESET_FIRST,
  );

  if (!rolling && !weekly && !monthly) {
    return {
      success: false,
      error: "Could not parse OpenCode Go dashboard usage windows",
    };
  }

  const now = Date.now();
  return {
    success: true,
    ...(rolling ? { rolling: normalizeWindowUsage(rolling, now) } : {}),
    ...(weekly ? { weekly: normalizeWindowUsage(weekly, now) } : {}),
    ...(monthly ? { monthly: normalizeWindowUsage(monthly, now) } : {}),
  };
}

export async function queryOpenCodeGoQuota(
  config: OpenCodeGoConfig,
  signal?: AbortSignal,
): Promise<OpenCodeGoResult> {
  const signals: AbortSignal[] = [AbortSignal.timeout(REQUEST_TIMEOUT_MS)];
  if (signal) signals.push(signal);
  const combined = AbortSignal.any(signals);

  try {
    // 1) Primary path: Direct usage API (https://opencode.ai/zen/go/v1/usage)
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    };
    if (config.apiKey) {
      headers["Authorization"] = `Bearer ${config.apiKey}`;
    }
    if (config.authCookie) {
      headers["Cookie"] = `auth=${config.authCookie}`;
    }

    const apiResponse = await fetch(USAGE_API_URL, {
      method: "GET",
      headers,
      signal: combined,
    }).catch(() => null);

    if (apiResponse && apiResponse.ok) {
      const data = (await apiResponse.json()) as any;
      if (data && typeof data === "object") {
        if (data.usage || data.rolling || data.weekly || data.monthly) {
          return {
            success: true,
            ...(data.usage ? { usage: data.usage } : {}),
            ...(data.rolling ? { rolling: data.rolling } : {}),
            ...(data.weekly ? { weekly: data.weekly } : {}),
            ...(data.monthly ? { monthly: data.monthly } : {}),
          };
        }
      }
    }

    // 2) Fallback path: If API call failed and workspaceId + authCookie exist, try dashboard scraper
    if (config.workspaceId && config.authCookie) {
      return await scrapeDashboardQuota(config, combined);
    }

    if (apiResponse && !apiResponse.ok) {
      const text = await apiResponse.text().catch(() => "");
      return {
        success: false,
        error: `OpenCode Go usage API error ${apiResponse.status}: ${text.slice(0, 120)}`,
      };
    }

    return {
      success: false,
      error: "Could not fetch OpenCode Go usage from API",
    };
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      return { success: false, error: "Request timed out" };
    }
    if (err instanceof Error && err.name === "AbortError") {
      return { success: false, error: "Request cancelled" };
    }
    return {
      success: false,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}
