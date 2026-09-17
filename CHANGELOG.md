# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

## [0.6.0] - 2026-09-17

### Changed
- **`/quotas` only lists configured providers**: providers with no credentials anywhere Pi looks (`auth.json`, resolved provider auth, environment variables, CLI config files) are hidden from the combined dashboard instead of rendering a "No … token found" row. Detection reuses the existing `config` error kind, which every fetcher returns before making a network call, so nothing extra is requested. Single-provider commands (`/grok:quotas`, `/devin:quotas`, …) still report missing credentials, since the user asked for that provider by name; an all-unconfigured dashboard shows "No configured providers".

## [0.5.0] - 2026-09-17

### Added
- **Devin provider**: Daily and Weekly quota windows (used percentages with reset times) plus the monthly prompt-credit balance, surfaced in the dashboard, `/devin:quotas`, footer status, and quota warnings. Queries the Connect `GetUserStatus` endpoint on the Windsurf backend pi-devin streams through (catalog-class routing: always the Codeium host, not the inference `models.json` baseUrl), using the `devin` OAuth credential Pi stores after `/login devin`; `DEVIN_API_KEY` is a token fallback and `DEVIN_API_SERVER_URL` an endpoint override.
- **Anthropic 7d Fable quota**: the dashboard, `/anthropic:quotas`, footer status, and warnings now surface the per-model weekly Fable window. Verified against a live `/api/oauth/usage` payload: Fable arrives as a `limits[]` entry with `kind: "weekly_scoped"` and `scope.model.display_name: "Fable"`; the legacy flat `seven_day_fable` key is still honoured, and generic `session`/`weekly_all` limit kinds are not duplicated. Scoped windows only appear when the subscription includes the model, so other plans are unchanged.

## [0.4.1] - 2026-09-16

### Fixed
- **Antigravity quotas**: `/antigravity:quotas` now returns data. Quota calls target `daily-cloudcode-pa.googleapis.com` (the host pi-antigravity actually sends traffic to; production only echoes a static catalog) with the CLI User-Agent and `{ project }` body, honouring `ANTIGRAVITY_BASE_URL`. Token resolution now goes through `authStorage.getApiKey()` (which refreshes expired OAuth tokens) and unwraps pi-antigravity's JSON `{ token, projectId }` key; plain `google`/`gemini` API keys are no longer tried since the endpoint is OAuth-only. `retrieveUserQuotaSummary` is tried first for exact 5h/7d buckets, falling back to per-model `fetchAvailableModels`. The parser no longer discards fully-unused (100% remaining) pools.
- **Stale extension ctx errors on session replacement**: the token status footer no longer throws "This extension ctx is stale after session replacement or reload" when a session replacement (`/new`, `/fork`, `/resume`) lands while a token-status update — or the shutdown handler itself — is touching the previous session's context. All context accesses now degrade gracefully, matching the guards already used by the usage-status extension.

## [0.4.0] - 2026-08-04

### Added
- **Kimi Code provider**: rolling five-hour and weekly Coding Plan usage windows, with the `/kimi:quotas` command, dashboard, footer status, and quota warnings. Contributed by @tdslot in #19.

### Fixed
- **Modern Pi authentication compatibility**: quota checks now resolve provider credentials through `ModelRegistry` instead of relying on its removed public `authStorage` property. This restores footer quota status, quota warnings, and `/codex:quotas` on newer Pi releases while remaining compatible with older releases, preserving stored OAuth metadata (GitHub Copilot `refresh`, Codex `accountId`) and adding `getProviderAuth()` header-based Bearer extraction. Contributed by @tdslot in #18.
- **Codex quota window labels**: footer and dashboard labels now follow the server-provided window duration instead of assuming every primary window is 5h. Weekly-only responses now correctly show `7d` alongside their reset countdown. Contributed by @tdslot in #20.

## [0.3.1] - 2026-07-09

### Fixed
- **Direct Anthropic API key users**: quota monitoring no longer fails for users who registered a direct API key (`sk-ant-...`) via `pi /login` rather than an OAuth subscription token. The `/api/oauth/usage` endpoint requires OAuth credentials, so the fetch is now skipped for direct keys with a silent "not applicable" result — the footer shows nothing instead of a persistent "usage unavailable" warning, and the dashboard shows a dim note instead of a raw JSON error body. Fixes #14 (reported by @vkarasen).
- **Raw JSON error bodies**: HTTP error responses that return a JSON object (e.g. `{"error":{"message":"..."}}`) are now reduced to a clean, human-readable message across all providers, so the dashboard and notifications no longer leak raw JSON.
- **Non-interactive `/quotas` fallback**: when the TUI custom view is unavailable, the command now renders a readable per-provider summary instead of dumping raw JSON snapshots (which previously included raw HTTP error bodies).

## [0.3.0] - 2026-07-09

### Added
- **Z.ai (GLM Coding Plan) provider**: 5h/7d rolling token windows and a monthly web-search count window, with the `/zai:quotas` command and footer status. Contributed by @tdslot in #15.
- **OpenCode Go provider**: dashboard scraper for rolling 5h / weekly / monthly USD usage against Go tier limits, with the `/opencode-go:quotas` command and a token-status footer for `opencode-go*` models. Configured via `OPENCODE_GO_WORKSPACE_ID` + `OPENCODE_GO_AUTH_COOKIE` (env or config file). Contributed by @gretel (DO2THX) in #11.
- **Token usage tracking**: `/tokens` command with cross-session token/cost aggregation from JSONL session files. Contributed by @gretel (DO2THX) in #11.
- **Token usage status** footer extension and a per-feature toggle in `/quotas:settings`.
- ESLint linting is now part of the repo (`npm run lint` / `npm run lint:fix`), codifying the existing 2-space / double-quote / semicolon style as the enforced default.

### Fixed
- **Stale usage-status context**: the footer no longer repaints stale provider data after a session reload or a switch to a deferred Synthetic footer, using a generation token to cancel in-flight fetches and guarding status writes against stale-context errors. Fix contributed by @aserper in #13, with an independent approach by @Fadouse in #12 (superseded by #13 and credited here).
- Quota warning labels now use `PROVIDER_LABELS` instead of a hardcoded Anthropic label. Contributed by @gretel in #11.
- `formatTimeRemaining` now shows days when the remaining time is >= 24h (e.g. `649h30m` → `27d1h30m`). Contributed by @gretel in #11.

### Changed
- Lint conformance is now required before merge; PR #11 was converted from tab to 2-space indentation to match the repo style.

## [0.2.6] - 2026-05-14

### Added
- Quotas dashboard footer now shows the running `pi-quotas` package version.
- Dashboard render tests cover version display and pace-marker edge cases.

### Fixed
- Pace-aware quota windows now still switch to warning/high/critical colors at absolute 80%/90%/100% usage thresholds, preventing high-usage monthly quotas from staying green.
- Quotas dashboard progress bars no longer show stray accent-colored pace markers inside filled warning bars or on zero-usage bars.

## [0.2.5] - 2026-05-14

### Fixed
- Pi startup and turn handling no longer wait for footer quota refreshes or quota warning checks; remote quota requests now run in the background.
- GitHub Copilot quota checks now use Pi's stored GitHub OAuth token for the `/copilot_internal/user` endpoint, fixing `401 Bad credentials` failures with Pi 0.74 auth credentials. Reported by @6aKa in #8.

## [0.2.4] - 2026-05-06

### Added
- **Defer to Synthetic**: When pi-synthetic's usage footer is active, pi-quotas now hides its own Synthetic footer to avoid duplicate quota displays. This behavior is enabled by default and can be toggled via `/quotas:settings` → "Defer to Synthetic".

## [0.2.3] - 2026-05-06

### Changed
- Version bump only.

## [0.2.2] - 2026-05-06

### Fixed
- Anthropic subscription quota windows are hidden from the footer status line while remaining available in quota dashboards and warnings.
- README updated with Synthetic provider commands, quota windows, and credential setup.

## [0.2.1] - 2026-05-06

### Added
- Synthetic quota monitoring support, including the `/synthetic:quotas` command.
- Synthetic quota parsing for subscription requests, hourly search limits, free tool calls, weekly tokens, and rolling five-hour limits.
- Synthetic API quota fetching via the `SYNTHETIC_API_KEY` environment variable.

### Fixed
- Footer reset times now use minute precision across supported providers, matching quota warning output.
- Footer status no longer shows misleading reset tags for non-reset windows such as Codex spend cap and credit balances.
- Elapsed reset times render as `now` instead of `in now`.

## [0.2.0] - 2026-04-22

### Added
- OpenRouter quota monitoring support
- `/openrouter:quotas` command
- OpenRouter footer usage status for active OpenRouter sessions
- OpenRouter daily, weekly, and monthly USD usage tracking
- Optional OpenRouter monthly budget display when per-key spending limits are configured
- OpenRouter fetch and parser test coverage

### Improved
- Currency values now display with cents precision across the UI
- Tracking-only usage windows now show `$X.XX used` instead of confusing `$X.XX/$0.00`
- OpenRouter tracking labels are clearer: `Daily`, `Weekly`, `Monthly`
- OpenRouter period rollover times use UTC-based calculations
- README updated with OpenRouter commands, credentials, and provider details

### Fixed
- Footer status formatting for OpenRouter currency windows
- Clarity of OpenRouter tracking window presentation in the TUI
- Package lockfile version synced for the 0.2.0 release
