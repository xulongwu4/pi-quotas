import { afterEach, describe, expect, it, vi } from "vitest";
import { formatWindowStatus, type WindowStatus } from "./format-status.js";
import type { SupportedQuotaProvider } from "../../types/quotas.js";
import { formatStatus, formatStatusForFooter, toStatusWindows, toWindowStatus } from "./index.js";

// Minimal fake theme that just returns text with markers for color assertions
function fakeTheme() {
  return {
    fg: (color: string, text: string) => `[${color}]${text}[/${color}]`,
  };
}

describe("formatWindowStatus", () => {
  const theme = fakeTheme() as any;

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows remaining/limit for windows with known limits (GitHub premium)", () => {
    const w: WindowStatus = {
      provider: "anthropic",
      label: "Premium / month",
      usedPercent: 2.3,
      severity: "none",
      resetsAt: new Date("2026-05-01T00:00:00Z"),
      limited: false,
      usedValue: 7,
      limitValue: 300,
      kind: "counts",
    };
    const result = formatWindowStatus(theme, w);
    expect(result).toContain("293/300");
    expect(result).toContain("[dim]░░░░░░░░[/dim]");
    expect(result).toContain("2%");
  });

  it("kind=counts renders real counts even when limitValue is 100 (Devin credits)", () => {
    const w: WindowStatus = {
      provider: "anthropic",
      label: "Credits / month",
      usedPercent: 60,
      severity: "warning",
      resetsAt: null,
      limited: false,
      usedValue: 60,
      limitValue: 100,
      kind: "counts",
    };
    const result = formatWindowStatus(theme, w);
    expect(result).toContain("40/100");
    expect(result).toContain("60%");
    expect(result).not.toContain("% left");
  });

  it("kind=percent renders a remaining percentage", () => {
    const w: WindowStatus = {
      provider: "anthropic",
      label: "Daily",
      usedPercent: 25,
      severity: "none",
      resetsAt: new Date("2026-09-20T08:00:00Z"),
      limited: false,
      kind: "percent",
    };
    const result = formatWindowStatus(theme, w);
    expect(result).toContain("25%");
    expect(result).toContain("[success]██[/success]");
    expect(result).toContain("[dim]░░░░░░[/dim]");
    expect(result).not.toContain("/100");
  });

  it("passes kind through toWindowStatus", () => {
    const status = toWindowStatus({
      provider: "devin",
      label: "Credits / month",
      usedPercent: 60,
      resetsAt: null,
      windowSeconds: 0,
      usedValue: 60,
      limitValue: 100,
      kind: "counts",
    });
    expect(status.kind).toBe("counts");
    expect(status.resetsAt).toBeNull();
  });

  it("shows remaining % for percentage-only windows (Anthropic 5h)", () => {
    const w: WindowStatus = {
      provider: "anthropic",
      label: "5h",
      usedPercent: 9,
      severity: "none",
      resetsAt: new Date("2026-04-22T18:00:00Z"),
      limited: false,
      kind: "percent",
    };
    const result = formatWindowStatus(theme, w);
    expect(result).toContain("9%");
    expect(result).toContain("[success]");
  });

  it("formats Grok subscription window using sub short label", () => {
    const w: WindowStatus = {
      provider: "anthropic",
      label: "Subscription",
      usedPercent: 40,
      severity: "none",
      resetsAt: new Date("2026-06-01T00:00:00Z"),
      limited: false,
      kind: "percent",
    };
    const result = formatWindowStatus(theme, w);
    expect(result).toContain("sub ");
    expect(result).toContain("40%");
  });

  it("formats Antigravity windows with custom short labels", () => {
    const w1: WindowStatus = {
      provider: "anthropic",
      label: "Gemini 5h",
      usedPercent: 20,
      severity: "none",
      resetsAt: new Date("2026-06-15T11:39:34Z"),
      limited: false,
      kind: "percent",
    };
    const w2: WindowStatus = {
      provider: "anthropic",
      label: "Claude/GPT 7d",
      usedPercent: 35,
      severity: "none",
      resetsAt: new Date("2026-06-20T00:39:54Z"),
      limited: false,
      kind: "percent",
    };
    expect(formatWindowStatus(theme, w1)).toContain("gem-5h ");
    expect(formatWindowStatus(theme, w2)).toContain("3p-7d ");
  });

  it("shows currency for currency windows (Anthropic extra)", () => {
    const w: WindowStatus = {
      provider: "anthropic",
      label: "Extra (AUD)",
      usedPercent: 71.8,
      severity: "warning",
      resetsAt: new Date("2026-05-01T00:00:00Z"),
      limited: false,
      kind: "currency",
      usedValue: 215,
      limitValue: 300,
    };
    const result = formatWindowStatus(theme, w);
    expect(result).toContain("$215.00/$300.00");
    expect(result).toContain("[warning]");
  });

  it("shows REACHED for spend cap", () => {
    const w: WindowStatus = {
      provider: "anthropic",
      label: "Spend cap",
      usedPercent: 100,
      severity: "critical",
      resetsAt: null,
      kind: "spend-cap",
      limited: true,
    };
    const result = formatWindowStatus(theme, w);
    expect(result).toContain("REACHED");
    expect(result).toContain("[error]");
  });

  it("colors label when severity is warning or worse", () => {
    const w: WindowStatus = {
      provider: "anthropic",
      label: "7d",
      usedPercent: 85,
      severity: "high",
      resetsAt: new Date("2026-04-23T23:00:00Z"),
      limited: false,
      kind: "percent",
    };
    const result = formatWindowStatus(theme, w);
    // label should be colored with error (high maps to error)
    expect(result).toContain("[error]7d ");
    expect(result).toContain("85%");
  });

  it("keeps label dim when severity is none", () => {
    const w: WindowStatus = {
      provider: "anthropic",
      label: "5h",
      usedPercent: 10,
      severity: "none",
      resetsAt: new Date("2026-04-22T18:00:00Z"),
      limited: false,
      kind: "percent",
    };
    const result = formatWindowStatus(theme, w);
    expect(result).toContain("[dim]5h ");
  });

  it("renders footer reset times with minute precision for every provider", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-06T05:28:37Z"));

    const providers: Array<{ provider: SupportedQuotaProvider; label: string }> = [
      { provider: "anthropic", label: "5h" },
      { provider: "openai-codex", label: "7d" },
      { provider: "github-copilot", label: "Premium / month" },
      { provider: "openrouter", label: "Monthly Budget" },
      { provider: "synthetic", label: "Subscription" },
    ];

    for (const { provider, label } of providers) {
      const status = toWindowStatus({
        provider,
        label,
        usedPercent: 50,
        resetsAt: new Date("2026-05-06T07:47:37Z"),
        windowSeconds: 5 * 60 * 60,
        kind: "percent",
      });

      const result = formatStatus({ ui: { theme } } as any, [status]);

      expect(result).toContain("(↺in 2h19m)");
      expect(result).not.toContain("(↺in 3h)");
    }
  });

  it("omits footer reset tags for windows without a real reset time", () => {
    const result = formatStatus(
      { ui: { theme } } as any,
      [
        {
          provider: "openai-codex",
          label: "Spend cap",
          usedPercent: 0,
          severity: "none",
          resetsAt: null,
          limited: false,
          kind: "spend-cap",
        },
      ],
    );

    expect(result).toContain("cap ");
    expect(result).not.toContain("↺");
    expect(result).not.toContain("soon");
  });

  it("clears the footer status when filtering removes all windows", () => {
    expect(formatStatusForFooter({ ui: { theme } } as any, [])).toBeUndefined();
  });

  it("includes Anthropic subscription windows in footer status alongside extra usage", () => {
    const windows = toStatusWindows([
      {
        provider: "anthropic",
        label: "5h",
        usedPercent: 10,
        resetsAt: new Date("2026-05-06T07:47:37Z"),
        windowSeconds: 5 * 60 * 60,
        kind: "percent",
      },
      {
        provider: "anthropic",
        label: "7d Sonnet",
        usedPercent: 20,
        resetsAt: new Date("2026-05-06T07:47:37Z"),
        windowSeconds: 7 * 24 * 60 * 60,
        kind: "percent",
      },
      {
        provider: "anthropic",
        label: "Extra (USD)",
        usedPercent: 30,
        resetsAt: new Date("2026-06-01T00:00:00Z"),
        windowSeconds: 30 * 24 * 60 * 60,
        usedValue: 30,
        limitValue: 100,
        kind: "currency",
      },
    ]);

    expect(windows).toHaveLength(3);
    expect(windows[0]).toMatchObject({ label: "5h", usedPercent: 10 });
    expect(windows[1]).toMatchObject({ label: "7d Sonnet", usedPercent: 20 });
    expect(windows[2]).toMatchObject({ label: "Extra (USD)", usedPercent: 30 });
  });

  it("does not prefix elapsed reset times with in", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-06T05:28:37Z"));

    const result = formatStatus(
      { ui: { theme } } as any,
      [
        {
          provider: "anthropic",
          label: "5h",
          usedPercent: 100,
          severity: "critical",
          resetsAt: new Date("2026-05-06T05:28:37Z"),
          limited: false,
          kind: "percent",
        },
      ],
    );

    expect(result).toContain("(↺now)");
    expect(result).not.toContain("(↺in now)");
  });
});
