import type { Theme } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import type { Component } from "@mariozechner/pi-tui";
import { Loader, matchesKey, truncateToWidth } from "@mariozechner/pi-tui";
import pkg from "../../../../package.json" with { type: "json" };
import { PROVIDER_LABELS } from "../../../lib/quotas.js";
import { formatQuotaDisplay } from "../../../utils/quotas-format.js";
import type { QuotasResult, SupportedQuotaProvider } from "../../../types/quotas.js";
import {
  assessWindow,
  formatResetTiming,
  getSeverityColor,
} from "../../../utils/quotas-severity.js";

type Snapshot = {
  provider: SupportedQuotaProvider;
  result: QuotasResult;
};

type QuotasState =
  | { type: "loading" }
  | { type: "streaming"; snapshots: Snapshot[]; pending: number }
  | { type: "loaded"; snapshots: Snapshot[] };

function renderProgressBar(
  percent: number,
  width: number,
  theme: Theme,
  fillColor: "success" | "warning" | "error",
  pacePercent?: number | null,
): string {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  const filled = Math.round((clamped / 100) * width);
  const showPace =
    percent > 0 &&
    pacePercent !== null &&
    pacePercent !== undefined &&
    pacePercent >= 5 &&
    Math.abs(pacePercent - percent) >= 5;
  const paceIndex = showPace
    ? Math.min(width - 1, Math.round((Math.max(0, Math.min(100, pacePercent ?? 0)) / 100) * width))
    : null;
  const parts: string[] = [];
  for (let idx = 0; idx < width; idx++) {
    if (paceIndex !== null && idx === paceIndex) {
      if (idx < filled) {
        parts.push(theme.fg(fillColor, "█"));
      } else {
        parts.push(theme.fg(fillColor, "|"));
      }
    } else if (idx < filled) {
      parts.push(theme.fg(fillColor, "█"));
    } else {
      parts.push(theme.fg("dim", "░"));
    }
  }
  return parts.join("");
}

export class QuotasComponent implements Component {
  private state: QuotasState = { type: "loading" };
  private loader: Loader | null = null;

  constructor(
    private theme: Theme,
    private tui: any,
    private title: string,
    private onClose: () => void,
    private onRefetch: () => void,
  ) {
    this.startLoader();
  }

  private startLoader(): void {
    this.loader = new Loader(
      this.tui,
      (s: string) => this.theme.fg("accent", s),
      (s: string) => this.theme.fg("muted", s),
      "Fetching quotas...",
    );
  }

  destroy(): void {
    this.loader?.stop();
    this.loader = null;
  }

  setState(state: QuotasState): void {
    if (state.type === "loading") {
      this.loader?.stop();
      this.startLoader();
    } else if (this.state.type === "loading") {
      this.loader?.stop();
      this.loader = null;
    }
    this.state = state;
  }

  handleInput(data: string): boolean {
    if (matchesKey(data, "escape") || data === "q") {
      this.onClose();
      return true;
    }
    if (data === "r") {
      this.onRefetch();
      return true;
    }
    return false;
  }

  render(width: number): string[] {
    const lines: string[] = [];
    const border = new DynamicBorder((s: string) => this.theme.fg("border", s));
    lines.push(...border.render(width));
    lines.push(truncateToWidth(` ${this.theme.fg("accent", this.theme.bold(this.title))}`, width));

    if (this.state.type === "loading") {
      lines.push(...(this.loader ? this.loader.render(width) : [this.theme.fg("muted", "  Fetching quotas...")]));
    } else {
      lines.push(
        ...this.renderLoaded(
          this.state.snapshots,
          this.state.type === "streaming" ? this.state.pending : 0,
          width,
        ),
      );
    }

    lines.push("");
    lines.push(this.theme.fg("dim", `  pi-quotas v${pkg.version}  ·  r to refresh  q/Esc to close`));
    lines.push(...border.render(width));
    return lines;
  }

  private renderLoaded(
    snapshots: Snapshot[],
    pending: number,
    maxWidth: number,
  ): string[] {
    const lines: string[] = [""];
    for (const snapshot of snapshots) {
      lines.push(...this.renderProvider(snapshot, maxWidth));
      lines.push("");
    }
    // Incomplete combined views keep an explicit "still loading" note so a
    // slow provider (e.g. Devin GetUserStatus) is not mistaken for done.
    if (pending > 0) {
      lines.push(
        truncateToWidth(
          `  ${this.theme.fg("dim", `${pending} provider${pending > 1 ? "s" : ""} still loading…`)}`,
          maxWidth,
        ),
      );
    }
    if (snapshots.length === 0 && pending === 0) {
      lines.push(
        truncateToWidth(
          `  ${this.theme.fg("dim", "No configured providers")}`,
          maxWidth,
        ),
      );
    }
    if (lines.at(-1) === "") lines.pop();
    return lines;
  }

  private renderProvider(snapshot: Snapshot, maxWidth: number): string[] {
    const lines: string[] = [];
    const title = PROVIDER_LABELS[snapshot.provider];
    lines.push(truncateToWidth(`  ${this.theme.fg("accent", title)}`, maxWidth));

    if (!snapshot.result.success) {
      // "not applicable" is an expected, non-error state (e.g. a direct
      // Anthropic API key with no subscription usage) — show a dim note,
      // not a warning-coloured error.
      const { error } = snapshot.result;
      const tone = error.kind === "not_applicable" ? "dim" : "warning";
      lines.push(
        truncateToWidth(`  ${this.theme.fg(tone, error.message)}`, maxWidth),
      );
      return lines;
    }

    const windows = snapshot.result.data.windows;
    if (windows.length === 0) {
      lines.push(truncateToWidth(`  ${this.theme.fg("dim", "No quota windows available")}`, maxWidth));
      return lines;
    }

    const barWidth = Math.min(42, Math.max(18, maxWidth - 28));
    for (const window of windows) {
      const assessment = assessWindow(window);
      const color = getSeverityColor(assessment.severity);

      // Shared value + suffix (types/quotas) keeps dashboard, footer,
      // and notify fallback in agreement.
      const usedStr = formatQuotaDisplay(window);

      const bar = renderProgressBar(window.usedPercent, barWidth, this.theme, color, assessment.pacePercent);
      const limitedBadge = window.limited ? this.theme.fg("error", " LIMITED") : "";
      // Color the label based on severity: dim when safe, colored when at risk
      const isAtRisk = assessment.severity !== "none";
      const labelColor = isAtRisk ? color : "dim";
      lines.push(truncateToWidth(`    ${this.theme.fg(labelColor, `${window.label}:`)}`, maxWidth));
      lines.push(truncateToWidth(`    ${bar} ${this.theme.fg(color, usedStr)}${limitedBadge}`, maxWidth));

      // Subtitle: next event info + overage
      const subtitleParts: string[] = [];
      if (window.resetsAt != null) {
        subtitleParts.push(`${window.nextLabel ?? "Resets"} ${formatResetTiming(window.resetsAt)}`);
      } else if (window.nextLabel) {
        subtitleParts.push(window.nextLabel);
      }
      if (window.nextAmount) {
        subtitleParts.push(window.nextAmount);
      }
      if (subtitleParts.length > 0) {
        lines.push(
          truncateToWidth(
            `    ${this.theme.fg("dim", subtitleParts.join("  ·  "))}`,
            maxWidth,
          ),
        );
      }
    }

    return lines;
  }

  invalidate(): void {}
}
