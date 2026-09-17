import { describe, expect, it } from "vitest";
import { isConfiguredSnapshot } from "./command.js";
import type { QuotasResult } from "../../types/quotas.js";

const snap = (result: QuotasResult) =>
  ({ provider: "grok", result }) as const;

describe("isConfiguredSnapshot", () => {
  it("hides providers with no credentials", () => {
    expect(
      isConfiguredSnapshot(
        snap({ success: false, error: { kind: "config", message: "no token" } }),
      ),
    ).toBe(false);
  });

  it("keeps configured providers, including failures and not_applicable", () => {
    expect(
      isConfiguredSnapshot(
        snap({ success: true, data: { provider: "grok", windows: [] } }),
      ),
    ).toBe(true);
    for (const kind of ["http", "network", "timeout", "not_applicable"] as const) {
      expect(
        isConfiguredSnapshot(snap({ success: false, error: { kind, message: "x" } })),
      ).toBe(true);
    }
  });
});
