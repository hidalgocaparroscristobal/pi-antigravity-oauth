# pi-antigravity-oauth

Lightweight, subprocess-free Google Antigravity OAuth & HTTPS SSE provider extension for **Gentle Shell** (`@earendil-works/pi-coding-agent` / `@earendil-works/pi-ai`).

## Why this exists

Instead of wrapping `agy` / `agy_acp_server.par` subprocesses or spawning local MCP HTTP bridges, this extension talks directly to Google's Cloud Code Private API (`daily-cloudcode-pa.googleapis.com` with fallback to `cloudcode-pa.googleapis.com`) over `fetch` + Server-Sent Events:

- **Zero subprocesses (`agy`) & zero MCP bridge pollution**: No background binaries, no `mcp_config.json` mutations, and no runaway RAM spikes.
- **Accurate context-window token accounting**: Each SSE call reports `usageMetadata` for that single inference turn (avoiding cumulative multi-round `cacheRead` totals that trigger false auto-compactions at `>100%` context).
- **Dual independent Google accounts (`antigravity` + `antigravity-cli`)**:
  - `antigravity`: reads `~/.gemini/antigravity-acp/acp_token.json` or Gentle Shell `auth.json` (`/login antigravity`).
  - `antigravity-cli`: reads `~/.gemini/antigravity-cli/antigravity-oauth-token` or Gentle Shell `auth.json` (`/login antigravity-cli`).
- **Gemini-only model catalog**:
  - `gemini-4-hydrogen` (`low`, `medium`, `high`, `xhigh`, 1.0M context / 262.1K max output)
  - `gemini-4-argon` (`low`, `medium`, `high`, 1.0M context / 65.5K max output)
  - `gemini-3.8-flash` (`low`, `medium`, `high`, 1.0M context / 65.5K max output)
- **Native quota integration**:
  - `Alt+U` (`gentle-pi:usage-source/v1`) for both `antigravity` and `antigravity-cli`.
  - `/usage` and `/agy usage` commands showing both accounts side by side (Gemini Models `5h`/`weekly` + Gemini 4 Argon `weekly`, excluding 3P Claude/GPT buckets).

## Installation

Add to `~/.gentle-shell/agent/settings.json` under `"packages"`:

```json
{
  "packages": [
    "git:https://github.com/<your-user>/pi-antigravity-oauth"
  ]
}
```

Or load from a local clone path (e.g. `"/path/to/pi-antigravity-oauth"`).

## OAuth Client Configuration

No OAuth client secrets are committed to this repository. Client credentials are resolved automatically in order:

1. Environment variables: `ANTIGRAVITY_OAUTH_CLIENT_ID` and `ANTIGRAVITY_OAUTH_CLIENT_SECRET`
2. Existing `~/.gemini/antigravity-acp/acp_token.json` (`client_id`, `client_secret`)
3. Optional `~/.gentle-shell/agent/antigravity-oauth-client.json` (`{ "client_id": "...", "client_secret": "..." }`)

## Commands

- `/login antigravity` / `/login antigravity-cli` — Sign in via Google OAuth2 PKCE loopback (stored in Gentle Shell `auth.json`, without modifying `~/.gemini/`).
- `/usage` — Show Gemini quota for both accounts.
- `/agy status` — Show connection/account status for both providers.

## Architecture

- `src/entry.ts` — Extension entrypoint registering `ccpa-gemini`, `antigravity`, `antigravity-cli`, `Alt+U` sources, `/usage`, and `/agy`.
- `src/ccpa-auth.ts` — Dual-account OAuth2 PKCE login, token refresh, `loadCodeAssist` project resolution, and `0600` metadata cache.
- `src/ccpa-models.ts` — Gemini family catalog, thinking-level mapping, and tier slug resolution.
- `src/ccpa-stream.ts` — Direct HTTPS SSE client with idle-chunk watchdogs, `thoughtSignature` preservation, cross-provider `skip_thought_signature_validator` fallback, and orphaned tool-call recovery.
- `src/ccpa-usage.ts` — Quota polling (`retrieveUserQuotaSummary`), 3P filtering, `Alt+U` provider adapters, and `/usage` formatter.

## License

MIT
