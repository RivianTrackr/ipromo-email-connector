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

**If your HTML pipeline strips `<img>` tags** (some upstream composers sanitize author-supplied
image tags, even safe `cid:` ones, before the HTML reaches the connector), write a plain-text
**token** where the image should sit instead — it survives sanitizing and is swapped for the
`cid:` image at the last hop before SendGrid:

```html
[[IMG:logo]]                        <!-- becomes <img src="cid:logo" alt=""> -->
[[IMG:logo|alt=iPromo|width=160]]   <!-- optional alt / width attributes -->
```

A token is replaced only when the message carries an **inline** attachment whose `contentId`
matches; unmatched or malformed tokens are left untouched (so mistakes stay visible rather than
rendering a broken image). Token ids are restricted to `[A-Za-z0-9_-]` and attribute values are
HTML-escaped. See `renderImageTokens` in [`src/email.ts`](src/email.ts).

**If you only have image URLs, not bytes** (e.g. assets in S3), pass an `images` array and the
server fetches each URL and inlines it for you — no base64 on your side:

```jsonc
{
  "html": "<p>Our new cap:</p>[[IMG:cap]]",
  "images": [
    { "url": "https://<allowed-host>/poster.png", "contentId": "cap" }
  ]
}
```

The server attaches each as an inline image under its `contentId`; place it with the same
`[[IMG:contentId]]` token (or `<img src="cid:contentId">`). This is a server-side outbound
fetch, so it's locked down: **https only**, the host must be on `ALLOWED_IMAGE_HOSTS` (the SSRF
control — defaults to the merchAI S3 bucket), redirects off that host are refused, the response
must be `image/*`, size is capped at `MAX_IMAGE_BYTES` (10 MB), and the request times out
(`IMAGE_FETCH_TIMEOUT_MS`). A failed fetch fails just that message with a clear error rather than
sending a half-built body. See [`src/images.ts`](src/images.ts).

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
The box runs at `/home/deploy/app` as the `deploy` user, under **PM2** (process
`email-connector` → `dist/server.js` on `:8080`), fronted by **Caddy** (auto HTTPS,
`:443 → 127.0.0.1:8080`). The app dir is a git checkout tracking `origin/main`, pulling
via a read-only GitHub deploy key.

**Deploy a change** (after it's merged to `main`):
```bash
ssh <server>
su - deploy -c "cd /home/deploy/app && ./deploy.sh"
```
`deploy.sh` pulls `origin/main`, reinstalls deps only when a lockfile changed, rebuilds the
backend + web assets (`dist/` is gitignored, so a build is always required), and restarts
PM2. Runtime state (`.env`, `connector.sqlite*`, `node_modules/`, `dist/`) is gitignored, so
the pull never touches it.

**First-time server setup:**
- Node 20+. Clone to `/home/deploy/app`; register a read-only deploy key so the box can pull.
- `npm ci && npm run build` **and** `cd web && npm ci && npm run build`.
- `pm2 start dist/server.js --name email-connector`, then `pm2 save` + `pm2 startup`. Run it
  from the repo root so it can serve `web/dist` for /authorize, /login, /authenticate.
- Front with Caddy; point `connector.ipromo.com` (A record, Cloudflare DNS-only) at the box.
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
