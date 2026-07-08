# Changelog

All notable changes to the iPromo email connector are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
All dates are UTC; this is an internal service without tagged releases.

## [0.2.2] - 2026-07-08

### Added
- **Server-side image fetch via an `images: [{ url, contentId }]` parameter.** For
  callers who have image URLs but can't attach the bytes themselves (e.g. S3
  assets), the connector fetches each URL and inlines it under its `contentId`;
  place it with the existing `[[IMG:contentId]]` token or `<img src="cid:...">`.
- Config for the fetch: `ALLOWED_IMAGE_HOSTS` (allowlist / SSRF control, defaults
  to the merchAI S3 bucket), `MAX_IMAGE_BYTES` (10 MB), `IMAGE_FETCH_TIMEOUT_MS`.

### Security
- The image fetch is deliberately narrow: https-only, host must be allowlisted,
  redirects off the allowlisted host are refused, `Content-Type` must be `image/*`,
  body size is capped, and the request times out. A failed fetch fails only that
  message (with a clear error) instead of sending a partial body.

## [0.2.1] - 2026-07-08

### Added
- **Inline-image placement via `[[IMG:contentId]]` body tokens.** Some upstream
  HTML composers strip author-supplied `<img>` tags — even safe `cid:` references —
  before the message reaches the connector, so an inline image would deliver as a
  file but not sit at its spot in the body. A plain-text token survives sanitizing
  and is swapped for `<img src="cid:contentId">` at the last hop before SendGrid.
  Supports optional `[[IMG:logo|alt=iPromo|width=160]]` attributes. Only tokens with
  a matching **inline** attachment are replaced; ids are restricted to
  `[A-Za-z0-9_-]` and attribute values are HTML-escaped (`renderImageTokens`).

## [0.2.0] - 2026-07-07

### Added
- `send_email` now supports **file attachments** and **inline images**. Each
  message accepts an `attachments` array (base64 `content`, `filename`, `type`,
  `disposition`, `contentId`). Inline images use the `cid:` pattern
  (`disposition: "inline"` + `contentId`, referenced as `<img src="cid:ID">`).
- `deploy.sh` — one-command server deploy: pulls `origin/main`, reinstalls deps
  only when a lockfile changed, rebuilds backend + web, restarts the PM2 process.
- `CHANGELOG.md` (this file).

### Changed
- Raised the MCP request body limit from **5 MB to 30 MB** so base64-encoded
  attachments aren't rejected (SendGrid's total-message ceiling is ~30 MB).
- The production server (`/home/deploy/app`) is now a **git checkout tracking
  `origin/main`**, pulling via a read-only GitHub deploy key (previously a manual
  file-copy deploy). README documents the git-checkout + `deploy.sh` workflow.

### Fixed
- Attachments and embedded images were silently dropped in team testing — the
  tool schema, `OutgoingMessage`, and the SendGrid call had no attachments field,
  so `cid:`-referenced images had no matching message parts. Now wired end-to-end.

## [0.1.0] - 2026-07-07

Initial release — a Claude (Team) custom connector that lets each employee send
email **as their own `@ipromo.com` address** through SendGrid, with identity
verified via Stytch. The server is a resource server only: it validates the
Stytch-issued token, forces `from` = the verified identity, enforces send caps,
sends via SendGrid, and logs every message.

### Added
- **MCP `send_email` tool** over streamable HTTP (`POST /mcp`), accepting a batch
  of fully-rendered messages (`to`/`cc`/`bcc`, `subject`, `html`, `text`,
  `replyTo`). Callers never supply `from` — it is set to the verified identity.
- **Identity & auth** (`src/auth.ts`) — Stytch Connected Apps (federated to
  Microsoft Entra); validates the token and serves OAuth Protected Resource
  Metadata at `/.well-known/oauth-protected-resource`.
- **Sender guardrails** — approved sender domains (default `ipromo.com`), a
  per-user daily cap (default 200/day) and a global daily cap (default 2000/day),
  enforced before send (`src/config.ts`, `src/store.ts`).
- **Audit log & accounting** (`src/store.ts`) — single-file SQLite store with
  `send_log`, `connections`, and `auth_failures` tables; caps counted per UTC day.
- **Delivery** (`src/email.ts`) — SendGrid send with open/click tracking on via
  the branded link domain.
- **Hosted consent UI** (`web/`) — React + Stytch `IdentityProvider` authorization/
  consent page served at `/authorize`, `/login`, `/authenticate`.
- **Operator scripts** (`scripts/`) — `test-send` (deliverability check),
  `inspect-user`, `latest-user`, `delete-user`, and a `report` summary.
- Health check at `GET /healthz`.
