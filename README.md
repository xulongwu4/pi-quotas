# @latentminds/pi-quotas

Quota monitoring for Pi. Shows remaining usage and rate limits for Anthropic, OpenAI Codex, GitHub Copilot, OpenRouter, Synthetic, Z.ai, OpenCode Go, Kimi Code, Grok (xAI), Antigravity, and ClinePass — directly in your Pi session.

## Screenshots


| `/quotas` dashboard | Footer status |
| ------------------- | ------------- |
| Quotas dashboard    | Footer status |


## Install

**From npm** (recommended):

```bash
pi install npm:@latentminds/pi-quotas
```

**From source:**

```bash
git clone https://github.com/latentminds-ai/pi-quotas.git
pi install ./pi-quotas
```

**Try without installing:**

```bash
pi -e npm:@latentminds/pi-quotas
```

## Commands


| Command              | Description                                |
| -------------------- | ------------------------------------------ |
| `/quotas`            | Combined quota dashboard for all providers |
| `/anthropic:quotas`  | Anthropic quotas only                      |
| `/codex:quotas`      | OpenAI Codex quotas only                   |
| `/github:quotas`     | GitHub Copilot quotas only                 |
| `/openrouter:quotas` | OpenRouter quotas only                     |
| `/synthetic:quotas`  | Synthetic quotas only                      |
| `/zai:quotas`        | Z.ai quotas only                           |
| `/opencode-go:quotas`| OpenCode Go quotas only                    |
| `/kimi:quotas`       | Kimi Code quotas only                      |
| `/grok:quotas`       | Grok quotas only                           |
| `/antigravity:quotas`| Antigravity quotas only                    |
| `/devin:quotas`      | Devin quotas only                          |
| `/cursor:quotas`     | Cursor quotas only                         |
| `/cline:quotas`      | ClinePass quotas only                      |
| `/tokens`            | Cross-session token/cost usage            |
| `/quotas:settings`   | Toggle individual features on or off       |


## Features

### Quota dashboard

Run `/quotas` to open a bordered TUI view showing all providers side by side, with progress bars, used/remaining counts, and reset times. Press `r` to refresh, `q` or `Esc` to close.

### Footer status widget

When your active model is from a supported provider, the Pi footer shows real-time quota headroom - updated every 60 seconds and on each turn. Colours shift from green → amber → red as usage climbs.

### Quota warnings

Automatic notifications when projected usage is on track to exceed limits before the window resets. Warnings escalate from `warning` → `high` → `critical` based on your consumption pace.

### Per-feature toggles

Use `/quotas:settings` to enable or disable:

- Combined `/quotas` command
- Per-provider commands (`/anthropic:quotas`, `/codex:quotas`, `/github:quotas`, `/openrouter:quotas`, `/synthetic:quotas`, `/zai:quotas`, `/opencode-go:quotas`, `/kimi:quotas`, `/grok:quotas`, `/antigravity:quotas`, `/devin:quotas`, `/cursor:quotas`, `/cline:quotas`)
- Footer status widget
- Quota warning notifications
- **Defer to Synthetic** — when both pi-quotas and [pi-synthetic](https://www.npmjs.com/package/@aliou/pi-synthetic) are loaded, pi-quotas hides its own Synthetic footer to avoid showing duplicate quota information. Enabled by default; disable if you prefer to see both footers.

Settings can be saved globally (`$PI_CODING_AGENT_DIR/quotas.json`, defaulting to `~/.pi/agent/quotas.json`) or per-project (`.pi/quotas.json`). Run `/reload` after changing command visibility.

## Supported providers


| Provider       | Windows                                                        | Details                                                                                             |
| -------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Anthropic      | 5h, 7d, per-model 7d, extra usage                              | Utilization percentages; optional overage budget in local currency                                  |
| OpenAI Codex   | 5h, 7d, credits, spend cap                                     | Rate-limit percentages; credit balance; spend-cap reached/OK                                        |
| GitHub Copilot | Premium/chat/completions per month                             | Remaining/entitlement counts with overage indicators                                                |
| OpenRouter     | Monthly budget, daily/weekly/monthly usage                     | USD spending tracking with cents precision; optional per-key budget limits; UTC-based period resets |
| Synthetic      | Subscription, search/hour, free tools, weekly tokens, 5h limit | Request counts and token budgets; rolling five-hour rate limit; weekly token regen                  |
| Z.ai           | 5h, 7d, monthly web searches                                  | Token utilisation percentages (rolling 5h/7d windows); monthly web-search count limit               |
| OpenCode Go    | Rolling 5h, weekly, monthly USD                              | USD spend tracking against tier limits; cross-session token/cost aggregation via the `/tokens` command |
| Kimi Code      | Rolling 5h, weekly                                           | Coding Plan request allowances with reset times                                                        |
| Grok           | Subscription                                                 | SuperGrok and SuperGrok Heavy credit utilization with billing period reset times                       |
| Antigravity    | Gemini 5h/7d, Claude/GPT 5h/7d                               | Google Antigravity and agy CLI quota tracking with Gemini and Claude/GPT model group buckets             |
| Devin          | Daily, weekly, credits / month                               | Daily/weekly quota percentages with reset times and monthly prompt-credit balance from the same Windsurf backend pi-devin uses |
| Cursor         | Total, cursor models, other models, on-demand                 | Cursor's combined usage counter, the `dashboard/spending` Auto-selected vs named-model percent splits, and on-demand spend |
| ClinePass      | 5h, 7d, 30d                                                   | `/api/v1/users/me/plan/usage-limits` — the same percentages the Cline web dashboard shows, with their reset times |


## Credentials

pi-quotas reads existing Pi auth entries from `~/.pi/agent/auth.json`:

- `anthropic` — Anthropic OAuth token
- `openai-codex` — Codex access token (also reads `~/.codex/auth.json` for the account ID)
- `github-copilot` — GitHub Copilot OAuth token (falls back to `gh auth token` if needed)
- `openrouter` — OpenRouter API key (Bearer token)
- `synthetic` — Synthetic API key (set the `SYNTHETIC_API_KEY` environment variable)
- `zai` — Z.ai (Zhipu AI / GLM Coding Plan) API key
- `opencode-go` — OpenCode Go API key (set the `OPENCODE_API_KEY` or `OPENCODE_GO_API_KEY` environment variable, or configure in Pi auth or OpenCode Go config file; legacy workspace ID and auth cookie also supported)
- `kimi-coding` — Kimi Code OAuth access token
- `grok` (or `xai`) — Grok OAuth access token (also automatically reads `~/.grok/auth.json` created by `grok login`)
- `antigravity` — Google Antigravity OAuth token from `/login antigravity` (also reads `~/.codexbar/antigravity/oauth_creds.json`)
- `cursor` — Cursor access token from `/login cursor` (the pi-cursor extension); `CURSOR_ACCESS_TOKEN` as a token fallback and `CURSOR_USAGE_SESSION_TOKEN` (dashboard cookie) as a last resort
- `cline-pass` (or `cline`) — Cline API key from `/login` → ClinePass (the pi-cline-pass extension); `CLINE_API_KEY` as a fallback
- `devin` — Devin session token from `/login devin` (the pi-devin extension); `DEVIN_API_KEY` as a token fallback and `DEVIN_API_SERVER_URL` as an endpoint override

No additional setup is required - if Pi can use the provider, pi-quotas can check its quotas. For Synthetic, export `SYNTHETIC_API_KEY` in your shell or Pi environment.

### Multiple accounts (pi-multiprovider)

With [pi-multiprovider](https://github.com/monotykamary/pi-multiprovider) loaded, quotas follow the session's `/switch-account` pin or session-affinity selection. No extra dependency or configuration is required.

- The account label appears in the footer, `/quotas`, provider commands, and quota warnings.
- Quota caches and warning state are separated by provider and account ID. Explicit `/switch-account` changes and restored pins clear the previous footer and refresh it. Implicit-affinity failovers are not announced by pi-multiprovider 0.10.1; they appear on the next turn-end refresh or 60-second footer tick.
- **Explicit-pin failover limitation:** while a pinned account is cooling down, pi-multiprovider can serve a request with another account without changing the explicit pin. Its service still reports the pinned account, so pi-quotas cannot identify that request's actual account, even after refreshing. The display follows the service-reported selection, not a guaranteed record of the last request. Accurate reporting requires upstream last-used account information.
- Fresh cached quotas and in-flight requests are reused after identity lookup, without resolving OAuth credentials or taking the auth-store lock again. Credential-resolution failures back off for 10 seconds per account without destroying warm quotas. Manual refresh bypasses the backoff/cache; expired entries resolve credentials normally.
- Pooled credentials are used directly, including Synthetic keys and the account ID inside Codex tokens. Unresolvable credentials report unavailable rather than borrowing another login, environment key, or dashboard cookie.
- Pooled GitHub Copilot accounts show their label but not quotas: the service exposes a model token, not the GitHub OAuth token needed for usage lookup.

Before a pin or session-affinity selection exists (including when session affinity is disabled), pi-quotas shows **account unknown** and withholds quotas rather than showing a potentially unrelated default login. If the provider has a configured pool, use `/switch-account` to identify the selection.

**Pool-presence capability:** with a pi-multiprovider service exposing `hasPool(providerId)`, confirmed unpooled providers keep normal Pi credentials, quotas, and warnings. `undefined` means initialization/reconciliation is incomplete: quota fetching returns `account_pending` rather than using another login. Routine same-service reconciliation retains the last footer paint and respects the 30-second warning interval; startup recovery and explicit account switches refresh immediately. A genuinely lost selection still clears the old display and reports `account unknown`. The current model provider takes precedence over alias pools; aliases are probed for providers other than the current model.

**Older services (including stock 0.10.1):** without `hasPool`, no pool and no selection are indistinguishable. Such providers remain `account unknown`; `/switch-account` only helps configured pools. Use a pi-multiprovider build with the new capability, or disable it to restore unpooled quotas. pi-quotas checks capabilities rather than version numbers and never treats a missing method as proof that no pool exists.

The combined `/quotas` view omits ambiguous `account_unknown` and transient `account_pending` rows instead of listing every unconfigured provider. Individual provider commands still explain the state.

When the credential resolver returns `accountId`, pi-quotas verifies it against the selected account and retries mismatches, including unannounced switches between identically named accounts. On older services without that field it checks labels and change notifications, but an unannounced switch away and back with identical labels remains unprovable. This identity check does not resolve the explicit-pin failover limitation described above.

### Cross-extension verification

With Bun and a pi-multiprovider source checkout (dependencies installed), run:

```sh
npm run test:multiprovider -- ../pi-multiprovider
```

This offline check uses the real service/scheduler with mocked HTTP responses. It covers startup readiness, missing selection, account-bound credentials, same-object announcements, and pool removal. It reads no live credentials and makes no provider requests.

## Requirements

- [Pi](https://github.com/mariozechner/pi) >= 0.61.0

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for release notes and recent changes.

## License

[MIT](LICENSE) © Latent Minds Pty Ltd

## Acknowledgements

This project was inspired by [@aliou/pi-synthetic](https://www.npmjs.com/package/@aliou/pi-synthetic).

