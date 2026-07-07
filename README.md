# iPromo Email Connector

A Claude (Team) custom connector that lets each employee send email **as their own
`@ipromo.com` address** through SendGrid. Identity is verified via **Stytch Connected
Apps** (federated to Microsoft Entra); this server is a **resource server only** — it
validates the Stytch-issued token, forces `from` = the verified identity, enforces send
caps, sends via SendGrid, and logs every message.

List-building, personalization, and unsubscribe/compliance are handled upstream by the
HubSpot Cowork skill. This connector is a dumb "send exactly this, as me" service.

## Layout
```
src/
  config.ts   env loading + guardrail settings
  auth.ts     Stytch token validation + Protected Resource Metadata  ← verify the email-claim TODO
  email.ts    SendGrid send (from = verified identity, tracking on)
  store.ts    SQLite audit log + per-user/global daily caps
  server.ts   Express + MCP streamable-HTTP endpoint + send_email tool
```

## Attachments & inline images
The `send_email` tool accepts an optional `attachments` array on each message. Each entry
carries the file as **base64** in `content`:

```jsonc
{
  "content": "<base64 bytes>",   // required
  "filename": "quote.pdf",        // required
  "type": "application/pdf",       // MIME type (recommended)
  "disposition": "attachment",     // or "inline" (default: "attachment")
  "contentId": "logo"              // required for inline images only
}
```

**Inline images must use the `cid:` pattern.** Do not embed images as `data:` URIs or
hotlinked URLs — most clients (Outlook especially) strip both, which is why they "don't go
through." Instead, attach the image with `disposition: "inline"` and a `contentId`, then
reference that id in the HTML:

```html
<img src="cid:logo" alt="logo">
```

with the matching attachment `{ "disposition": "inline", "contentId": "logo", ... }`.

**Size:** the request body limit is 30MB (SendGrid's total-message ceiling). Base64 inflates
files ~33%, so keep original attachments under ~20MB.

## Local run
```bash
npm install
cp .env.example .env    # fill in Stytch + SendGrid values
npm run dev
```
Health check: `GET /healthz`. Discovery: `GET /.well-known/oauth-protected-resource`.

## Frontend (`web/`)
The hosted authorization/consent page Stytch requires (set as the "Authorization URL").
Small React app; `IdentityProvider` handles consent after a Microsoft login.
```bash
cd web && npm install
cp .env.example .env      # set VITE_STYTCH_PUBLIC_TOKEN (Stytch public token)
npm run build             # outputs web/dist, served by the backend at /authorize etc.
```
Note: `createStytchUIClient` is imported from `@stytch/react/ui` (not `@stytch/vanilla-js`).

### Stytch dashboard settings the frontend needs
- **Frontend SDKs → Authorized domains:** add `connector.ipromo.com` (and `localhost` for dev).
- **Redirect URLs:** add login+signup `https://connector.ipromo.com/authenticate`.
- **Connected Apps → Authorization URL:** `https://connector.ipromo.com/authorize` (already set).

## Deploy (Linode)
- Node 20+. Build both: root `npm run build` **and** `cd web && npm run build`.
- Run `dist/server.js` under **PM2** (`pm2 start dist/server.js --name email-connector`,
  then `pm2 save` + `pm2 startup`). The server serves `web/dist` for /authorize, /login,
  /authenticate, so run it from the repo root.
- Front with **Caddy** (auto HTTPS) reverse-proxying `:443 → 127.0.0.1:8080`.
- Point `connector.ipromo.com` (A record, Cloudflare DNS-only) at the box.
- **Last:** add the Linode static IP to SendGrid → IP Access Management (server IP first,
  keep a break-glass IP).

## Add to Claude Team
Settings → Connectors → Add custom connector → `https://connector.ipromo.com/mcp`.
Each user connects once and signs in with their iPromo Microsoft account.

## Known integration point to confirm
`src/auth.ts` — the exact token claim carrying the user's email depends on your Stytch
project's scope config. With the `email` scope it's in the token; otherwise resolve once
via `client.users.get(subject)` and cache. Verify against your Stytch dashboard before go-live.
```
