# Changelog

All notable changes to the iPromo email connector are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Entries are grouped by date; this is an internal service without tagged releases.

## [Unreleased]

## [2026-07-07]

### Added
- `send_email` now supports **file attachments** and **inline images**. Each
  message accepts an `attachments` array (base64 `content`, `filename`, `type`,
  `disposition`, `contentId`). Inline images use the `cid:` pattern
  (`disposition: "inline"` + `contentId`, referenced as `<img src="cid:ID">`).
- `deploy.sh` — one-command server deploy: pulls `origin/main`, reinstalls deps
  only when a lockfile changed, rebuilds backend + web, restarts the PM2 process.
- Server (`/home/deploy/app`) is now a **git checkout tracking `origin/main`**,
  pulling via a read-only GitHub deploy key.

### Changed
- Raised the MCP request body limit from **5 MB to 30 MB** so base64-encoded
  attachments aren't rejected (SendGrid's total-message ceiling is ~30 MB).

### Fixed
- Attachments and embedded images were silently dropped in team testing — the
  tool schema, `OutgoingMessage`, and the SendGrid call had no attachments field,
  so `cid:`-referenced images had no matching message parts. Now wired end-to-end.
