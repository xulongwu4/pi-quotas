import { AuthStorage } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchAnthropicQuotasWithToken,
  fetchAntigravityQuotas,
  fetchAntigravityQuotasWithToken,
  fetchCodexQuotasWithToken,
  fetchDevinQuotasWithToken,
  fetchGitHubCopilotQuotas,
  fetchGitHubCopilotQuotasWithToken,
  fetchGrokQuotas,
  fetchGrokQuotasWithToken,
  fetchKimiCodingQuotasWithToken,
  fetchOpenCodeGoQuotas,
  fetchOpenRouterQuotasWithToken,
} from "./fetch.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("fetchAnthropicQuotasWithToken", () => {
  it("returns config error when token missing", async () => {
    const result = await fetchAnthropicQuotasWithToken(undefined);
    expect(result).toMatchObject({
      success: false,
      error: { kind: "config" },
    });
  });

  it("skips the OAuth usage call for a direct API key and returns not_applicable", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as any;

    const result = await fetchAnthropicQuotasWithToken("sk-ant-api03-direct-key");

    expect(result).toMatchObject({
      success: false,
      error: { kind: "not_applicable" },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not treat Anthropic OAuth tokens (sk-ant-oat01-...) as direct API keys", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          five_hour: { utilization: 21, resets_at: "2026-04-22T18:30:00Z" },
          seven_day: { utilization: 9, resets_at: "2026-04-25T08:30:00Z" },
        }),
        { status: 200 },
      ),
    ) as any;

    const result = await fetchAnthropicQuotasWithToken("sk-ant-oat01-token");
    expect(result.success).toBe(true);
  });

  it("fetches and parses quota windows", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          five_hour: { utilization: 21, resets_at: "2026-04-22T18:30:00Z" },
          seven_day: { utilization: 9, resets_at: "2026-04-25T08:30:00Z" },
        }),
        { status: 200 },
      ),
    ) as any;

    const result = await fetchAnthropicQuotasWithToken("token");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.provider).toBe("anthropic");
      expect(result.data.windows).toHaveLength(2);
    }
  });
});

describe("fetchCodexQuotasWithToken", () => {
  it("returns config error when account id missing", async () => {
    const result = await fetchCodexQuotasWithToken("token", undefined);
    expect(result).toMatchObject({
      success: false,
      error: { kind: "config" },
    });
  });

  it("fetches and parses codex windows", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          rate_limit: {
            primary_window: {
              used_percent: 44,
              reset_at: 1776880800,
              limit_window_seconds: 18000,
            },
            secondary_window: {
              used_percent: 12,
              reset_at: 1777485600,
              limit_window_seconds: 604800,
            },
          },
        }),
        { status: 200 },
      ),
    ) as any;

    const result = await fetchCodexQuotasWithToken("token", "acct_123");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.provider).toBe("openai-codex");
      expect(result.data.windows).toHaveLength(2);
    }
  });
});

describe("fetchGitHubCopilotQuotasWithToken", () => {
  it("exchanges token then fetches usage on happy path", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ token: "copilot-token" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            quota_reset_date: "2026-05-01T00:00:00Z",
            quota_snapshots: {
              premium_interactions: {
                entitlement: 300,
                remaining: 240,
                percent_remaining: 80,
              },
            },
          }),
          { status: 200 },
        ),
      ) as any;

    const result = await fetchGitHubCopilotQuotasWithToken("gh-token");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.provider).toBe("github-copilot");
      expect(result.data.windows).toHaveLength(1);
    }
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it("falls back to direct token when exchange returns 401", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            quota_reset_date: "2026-05-01T00:00:00Z",
            quota_snapshots: {
              premium_interactions: { entitlement: 300, remaining: 293 },
            },
          }),
          { status: 200 },
        ),
      ) as any;

    const result = await fetchGitHubCopilotQuotasWithToken("gh-token");
    expect(result.success).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it("uses the stored GitHub OAuth refresh token for Pi 0.74 Copilot quota checks", async () => {
    const auth = AuthStorage.inMemory({
      "github-copilot": {
        type: "oauth",
        refresh: "ghu-refresh-token",
        access: "tid=abc;proxy-ep=proxy.individual.githubcopilot.com;exp=1778611280",
        expires: Date.now() + 60_000,
      },
    });

    globalThis.fetch = vi.fn(async (_url, init) => {
      const authorization = new Headers(init?.headers).get("authorization");
      if (authorization === "Bearer ghu-refresh-token") {
        return new Response(
          JSON.stringify({
            quota_reset_date: "2026-05-01T00:00:00Z",
            quota_snapshots: {
              premium_interactions: { entitlement: 300, remaining: 210 },
            },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 });
    }) as any;

    const result = await fetchGitHubCopilotQuotas(auth);

    expect(result.success).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://api.github.com/copilot_internal/user",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer ghu-refresh-token" }),
      }),
    );
  });
});

describe("fetchDevinQuotasWithToken", () => {
  it("returns config error when token missing", async () => {
    const result = await fetchDevinQuotasWithToken(undefined);
    expect(result).toMatchObject({
      success: false,
      error: { kind: "config" },
    });
  });

  it("posts Connect metadata and parses planStatus windows", async () => {
    let requestUrl = "";
    let requestBody = "";
    globalThis.fetch = vi.fn(async (input: any, init?: RequestInit) => {
      requestUrl = String(input);
      requestBody = String(init?.body);
      return new Response(
        JSON.stringify({
          userStatus: {
            planStatus: {
              dailyQuotaRemainingPercent: 100,
              dailyQuotaResetAtUnix: "1789632000",
              weeklyQuotaRemainingPercent: 75,
              weeklyQuotaResetAtUnix: "1789891200",
              availableFlexCredits: 40,
              planInfo: { planName: "Free", monthlyPromptCredits: 100 },
            },
          },
        }),
        { status: 200 },
      );
    }) as any;

    const result = await fetchDevinQuotasWithToken("devin-session-token$abc");
    expect(requestUrl).toContain("server.codeium.com");
    expect(requestUrl).toContain("GetUserStatus");
    expect(requestBody).toContain("metadata");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.provider).toBe("devin");
      expect(result.data.windows).toHaveLength(3);
    }
  });

  it("honors the DEVIN_API_SERVER_URL endpoint override", async () => {
    process.env.DEVIN_API_SERVER_URL = "https://proxy.example";
    let requestUrl = "";
    globalThis.fetch = vi.fn(async (input: any) => {
      requestUrl = String(input);
      return new Response(
        JSON.stringify({ userStatus: { planStatus: {} } }),
        { status: 200 },
      );
    }) as any;

    try {
      const result = await fetchDevinQuotasWithToken("token");
      expect(requestUrl).toContain("proxy.example/exa.api_server_pb");
      expect(result.success).toBe(true);
    } finally {
      delete process.env.DEVIN_API_SERVER_URL;
    }
  });

  it("propagates http failures", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response("nope", { status: 401 })) as any;
    const result = await fetchDevinQuotasWithToken("token");
    expect(result).toMatchObject({ success: false, error: { kind: "http" } });
  });
});

describe("fetchKimiCodingQuotasWithToken", () => {
  it("returns config error when token missing", async () => {
    const result = await fetchKimiCodingQuotasWithToken(undefined);
    expect(result).toMatchObject({
      success: false,
      error: { kind: "config" },
    });
  });

  it("fetches and parses Kimi Code subscription windows", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          usage: {
            limit: "100",
            used: "20",
            remaining: "80",
            resetTime: "2026-08-10T10:01:47.875212Z",
          },
          limits: [
            {
              window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
              detail: {
                limit: "100",
                used: "45",
                resetTime: "2026-08-03T15:01:47.875212Z",
              },
            },
          ],
        }),
        { status: 200 },
      ),
    ) as any;

    const result = await fetchKimiCodingQuotasWithToken("kimi-token");

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.provider).toBe("kimi-coding");
      expect(result.data.windows).toHaveLength(2);
    }
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://api.kimi.com/coding/v1/usages",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer kimi-token",
        }),
      }),
    );
  });
});

describe("fetchOpenRouterQuotasWithToken", () => {
  it("returns config error when token missing", async () => {
    const result = await fetchOpenRouterQuotasWithToken(undefined);
    expect(result).toMatchObject({
      success: false,
      error: { kind: "config" },
    });
  });

  it("fetches and parses OpenRouter key info with budget", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            label: "Test Key",
            limit: 50,
            limit_remaining: 35,
            limit_reset: "monthly",
            usage: 15,
            usage_daily: 2.5,
            usage_weekly: 12,
            usage_monthly: 15,
            byok_usage: 0,
            byok_usage_daily: 0,
            byok_usage_weekly: 0,
            byok_usage_monthly: 0,
            is_free_tier: false,
          },
        }),
        { status: 200 },
      ),
    ) as any;

    const result = await fetchOpenRouterQuotasWithToken("sk-or-test");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.provider).toBe("openrouter");
      expect(result.data.windows).toHaveLength(4);
      expect(result.data.windows[0]).toMatchObject({
        label: "Monthly Budget",
        usedValue: 15,
        limitValue: 50,
      });
    }
  });

  it("handles HTTP error", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("Unauthorized", { status: 401 }),
    ) as any;

    const result = await fetchOpenRouterQuotasWithToken("bad-key");
    expect(result).toMatchObject({
      success: false,
      error: { kind: "http" },
    });
  });

  it("extracts a clean message from a JSON error body instead of raw JSON", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { type: "authentication_error", message: "invalid x-api-key" },
        }),
        { status: 401 },
      ),
    ) as any;

    const result = await fetchOpenRouterQuotasWithToken("bad-key");
    expect(result).toMatchObject({ success: false, error: { kind: "http" } });
    if (!result.success) {
      expect(result.error.message).toBe("invalid x-api-key");
      expect(result.error.message).not.toContain("{");
    }
  });
});

describe("fetchGrokQuotasWithToken", () => {
  it("returns config error when token missing", async () => {
    const result = await fetchGrokQuotasWithToken(undefined);
    expect(result).toMatchObject({
      success: false,
      error: { kind: "config" },
    });
  });

  it("fetches and parses Grok subscription windows", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          config: {
            creditUsagePercent: 35.5,
            currentPeriod: { end: "2026-06-01T00:00:00Z" },
            subscriptionTier: "supergrok",
          },
        }),
        { status: 200 },
      ),
    ) as any;

    const result = await fetchGrokQuotasWithToken("grok-token");

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.provider).toBe("grok");
      expect(result.data.windows).toHaveLength(1);
      expect(result.data.windows[0]).toMatchObject({
        label: "Subscription",
        usedPercent: 35.5,
      });
    }
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://cli-chat-proxy.grok.com/v1/billing?format=credits",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer grok-token",
          "x-xai-token-auth": "xai-grok-cli",
        }),
      }),
    );
  });

  it("handles HTTP error cleanly", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ error: "Invalid access token" }),
        { status: 401 },
      ),
    ) as any;

    const result = await fetchGrokQuotasWithToken("bad-token");
    expect(result).toMatchObject({
      success: false,
      error: { kind: "http", message: "Invalid access token" },
    });
  });
});

describe("fetchGrokQuotas", () => {
  it("uses authStorage grok key if available", async () => {
    const auth = AuthStorage.inMemory({
      grok: { type: "api_key", key: "auth-grok-key" },
    });

    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          config: {
            creditUsagePercent: 10,
            currentPeriod: { end: "2026-06-01T00:00:00Z" },
          },
        }),
        { status: 200 },
      ),
    ) as any;

    const result = await fetchGrokQuotas(auth);
    expect(result.success).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://cli-chat-proxy.grok.com/v1/billing?format=credits",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer auth-grok-key",
        }),
      }),
    );
  });

  it("falls back to authStorage xai key if grok key is absent", async () => {
    const auth = AuthStorage.inMemory({
      xai: { type: "api_key", key: "auth-xai-key" },
    });

    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          config: {
            creditUsagePercent: 15,
            currentPeriod: { end: "2026-06-01T00:00:00Z" },
          },
        }),
        { status: 200 },
      ),
    ) as any;

    const result = await fetchGrokQuotas(auth);
    expect(result.success).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://cli-chat-proxy.grok.com/v1/billing?format=credits",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer auth-xai-key",
        }),
      }),
    );
  });
});

describe("fetchAntigravityQuotasWithToken", () => {
  it("returns config error when token missing", async () => {
    const result = await fetchAntigravityQuotasWithToken(undefined);
    expect(result).toMatchObject({
      success: false,
      error: { kind: "config" },
    });
  });

  it("fetches and parses Antigravity quota windows", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          response: {
            groups: [
              {
                displayName: "Gemini Models",
                buckets: [
                  {
                    bucketId: "gemini-5h",
                    displayName: "Five Hour Limit",
                    remaining: { remainingFraction: 0.85 },
                    resetTime: "2026-06-15T11:39:34Z",
                  },
                ],
              },
            ],
          },
        }),
        { status: 200 },
      ),
    ) as any;

    const result = await fetchAntigravityQuotasWithToken("antigravity-token");

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.provider).toBe("antigravity");
      expect(result.data.windows).toHaveLength(1);
      expect(result.data.windows[0]).toMatchObject({
        label: "Gemini 5h",
        usedPercent: 15,
      });
    }
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer antigravity-token",
          "User-Agent": expect.stringContaining("antigravity/cli/"),
        }),
      }),
    );
  });

  it("falls back to fetchAvailableModels with project id when summary is unlicensed", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: "SUBSCRIPTION_REQUIRED" } }), { status: 403 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            models: {
              "gemini-2.5-pro": { quotaInfo: { remainingFraction: 0.99, resetTime: "2099-01-01T00:00:00Z" } },
              "claude-sonnet-4-6": { quotaInfo: { remainingFraction: 1, resetTime: "2099-01-01T00:00:00Z" } },
              chat_20706: { quotaInfo: { remainingFraction: 1 } },
            },
          }),
          { status: 200 },
        ),
      ) as any;

    const result = await fetchAntigravityQuotasWithToken("antigravity-token", undefined, "proj-123");

    expect(globalThis.fetch).toHaveBeenLastCalledWith(
      "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
      expect.objectContaining({ body: JSON.stringify({ project: "proj-123" }) }),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.windows.map((w) => [w.label, w.usedPercent])).toEqual([
        ["Gemini 7d", 1],
        ["Claude/GPT 7d", 0],
      ]);
    }
  });

  it("handles HTTP error", async () => {
    globalThis.fetch = vi.fn().mockImplementation(async () =>
      new Response(
        JSON.stringify({ error: { message: "Permission denied" } }),
        { status: 403 },
      ),
    ) as any;

    const result = await fetchAntigravityQuotasWithToken("bad-token");
    expect(result).toMatchObject({
      success: false,
      error: { kind: "http", message: "Permission denied" },
    });
  });
});

describe("fetchAntigravityQuotas", () => {
  it("uses authStorage antigravity token if available", async () => {
    const auth = AuthStorage.inMemory({
      antigravity: { type: "api_key", key: JSON.stringify({ token: "auth-antigravity-key", projectId: "proj-1" }) },
    });

    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          response: {
            groups: [
              {
                displayName: "Gemini Models",
                buckets: [
                  {
                    bucketId: "gemini-5h",
                    displayName: "Five Hour Limit",
                    remaining: { remainingFraction: 0.9 },
                    resetTime: "2026-06-15T11:39:34Z",
                  },
                ],
              },
            ],
          },
        }),
        { status: 200 },
      ),
    ) as any;

    const result = await fetchAntigravityQuotas(auth);
    expect(result.success).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer auth-antigravity-key",
        }),
      }),
    );
  });

  it("ignores a plain google API key and falls back to the stored antigravity access token", async () => {
    const auth = AuthStorage.inMemory({
      google: { type: "api_key", key: "AIza-not-an-oauth-token" },
      antigravity: { type: "oauth", access: "stored-access", refresh: "r", expires: Date.now() + 60_000 } as any,
    });

    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          response: {
            groups: [
              {
                displayName: "Gemini Models",
                buckets: [
                  {
                    bucketId: "gemini-5h",
                    displayName: "Five Hour Limit",
                    remaining: { remainingFraction: 0.9 },
                    resetTime: "2026-06-15T11:39:34Z",
                  },
                ],
              },
            ],
          },
        }),
        { status: 200 },
      ),
    ) as any;

    const result = await fetchAntigravityQuotas(auth);
    expect(result.success).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer stored-access",
        }),
      }),
    );
  });
});

describe("fetchOpenCodeGoQuotas", () => {
  it("returns config error when no credentials are found", async () => {
    const auth = AuthStorage.inMemory({});
    const origEnv = process.env;
    process.env = { ...origEnv };
    delete process.env.OPENCODE_API_KEY;
    delete process.env.OPENCODE_GO_API_KEY;
    delete process.env.OPENCODE_GO_AUTH_COOKIE;
    delete process.env.OPENCODE_GO_WORKSPACE_ID;

    const result = await fetchOpenCodeGoQuotas(auth);
    process.env = origEnv;

    expect(result).toMatchObject({
      success: false,
      error: { kind: "config" },
    });
  });

  it("fetches OpenCode Go usage via https://opencode.ai/zen/go/v1/usage with API key", async () => {
    const auth = AuthStorage.inMemory({
      "opencode-go": { type: "api_key", key: "opencode-key-123" },
    });

    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          usage: {
            rolling: { status: "ok", percent: 8, resetsAt: "2026-08-19T23:27:57.317Z" },
            weekly: { status: "ok", percent: 61, resetsAt: "2026-08-24T00:00:00.317Z" },
            monthly: { status: "ok", percent: 30, resetsAt: "2026-09-18T02:21:08.317Z" },
          },
        }),
        { status: 200 },
      ),
    ) as any;

    const result = await fetchOpenCodeGoQuotas(auth);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.provider).toBe("opencode-go");
      expect(result.data.windows).toHaveLength(3);
      expect(result.data.windows[0]).toMatchObject({
        label: "5h Rolling",
        usedPercent: 8,
      });
      expect(result.data.windows[1]).toMatchObject({
        label: "Weekly",
        usedPercent: 61,
      });
      expect(result.data.windows[2]).toMatchObject({
        label: "Monthly",
        usedPercent: 30,
      });
    }

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://opencode.ai/zen/go/v1/usage",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer opencode-key-123",
          Accept: "application/json",
        }),
      }),
    );
  });
});
