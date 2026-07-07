# iPromo Email Connector — Architecture & Build Plan

**Goal:** A shared Claude (Team) custom connector that lets ~40 iPromo employees send
email **as their own `@ipromo.com` address** through **SendGrid**, from a Linode server
whose static IP is whitelisted in SendGrid's IP Access Management. Microsoft 365 is used
**only to prove identity** (so nobody can send as a colleague). All list-building,
personalization, and unsubscribe handling live in the separate HubSpot Cowork skill —
the connector is a **dumb send-and-log service**.

---

## 1. How the pieces fit

```
 ┌─────────────┐   OAuth login (once)     ┌──────────────────────┐
 │  Claude     │ ───────────────────────► │ Microsoft Entra ID   │
 │  (Team)     │   "who are you?"         │ (ipromo.com tenant)  │
 │  + Cowork   │ ◄─────────────────────── │  returns identity    │
 │    skill    │   identity: jose.castillo└──────────────────────┘
 └─────┬───────┘
       │ send_email(to, subject, html)   Bearer token = verified user
       ▼
 ┌────────────────────────────────────────────────┐
 │  Linode server  (connector.ipromo.com)         │
 │  • MCP server (Node/TS) + OAuth                 │
 │  • forces  from = authenticated identity        │
 │  • rate caps + audit log (SQLite)               │
 │  • holds SendGrid API key (never exposed)       │
 │  • STATIC IP ──► whitelisted in SendGrid        │
 └───────────────────────┬────────────────────────┘
                          │ SendGrid API (from whitelisted IP)
                          ▼
                 ┌──────────────────┐
                 │    SendGrid      │  DKIM-signs as em45.ipromo.com
                 │  (shared IP pool)│  → passes DMARC quarantine
                 └──────────────────┘
```

**Identity is the whole security model:** the server reads the authenticated user from
the OAuth token and injects `from` itself. Any `from` in the tool call is ignored. That's
what stops user A sending as user B.

---

## 2. Confirmed facts (from our review)

| Item | Status |
|------|--------|
| Volume | ~100 recipients/person/month × 40 ≈ **4,000 emails/month** (low) |
| Sending IP | **Shared IP pool** — do **NOT** buy a dedicated IP at this volume |
| SendGrid plan | **Essentials** tier is plenty (free tier's 100/day will choke on bursts) |
| Domain auth | ✅ `em45.ipromo.com` verified — covers **all** `@ipromo.com` senders |
| DMARC | `p=quarantine; aspf=r;` adkim defaults to **relaxed** → DKIM aligns → **passes** ✅ |
| Single Sender Verifications | Irrelevant to this connector (domain auth already covers everyone) |
| Unsubscribe / lists / personalization | Out of scope — handled by the HubSpot Cowork skill |
| Claude plan | **Team** — owner adds connector once; each user logs in individually |
| Entra admin | You have it |
| Linode server | Not yet created — provisioning steps in §6 |

---

## 3. The connector's tool surface (dumb pass-through)

One tool. The skill hands it fully-rendered messages; the server only injects identity,
enforces limits, sends, and logs.

**`send_email`**

| Field | Notes |
|-------|-------|
| `messages[]` | Batch of fully-rendered messages (avoids 100 round-trips) |
| `messages[].to` | `[{ email, name? }]` |
| `messages[].subject` | string |
| `messages[].html` | rendered HTML (skill already injected unsubscribe link + address) |
| `messages[].text` | optional plaintext alternative |
| `messages[].cc` / `bcc` | optional |
| ~~`from`~~ | **NOT accepted** — server sets it to the authenticated user |
| `replyTo` | optional; defaults to the sender's own address |

Returns per-message `{ status, sendgridMessageId }`. Tracking (open/click) **on** by
default, using the already-verified `url9892.ipromo.com` link-branding domain.

---

## 4. Authentication / OAuth flow

The connector is an **OAuth-protected remote MCP server** that **federates login to
Microsoft Entra ID**. Claude never sees a Microsoft token; it only ever holds a token
your server issues.

Flow when a user first connects:
1. User enables the connector in Claude → Claude discovers the server's OAuth metadata.
2. Claude sends the user to the server's `/authorize`.
3. Server redirects the user to **Microsoft Entra** (OIDC authorization-code flow).
4. User logs in with their `@ipromo.com` account (MFA, etc., per your tenant policy).
5. Entra redirects back to the server's `/oauth/callback` with a code; the server
   exchanges it, reads the verified identity (`jose.castillo@ipromo.com`), and confirms
   the tenant.
6. Server issues **its own** access token to Claude, bound to that identity.
7. Every `send_email` call carries that token → server maps token → user → `from`.

**Scopes needed from Entra: `openid profile email User.Read` only.** No `Mail.Send`,
no mailbox access — smaller security surface and easier consent.

**Build option:** the MCP TypeScript SDK includes OAuth-provider scaffolding
(authorization endpoints, dynamic client registration, token issuance); you implement the
Entra federation in the login step. *Alternative if you'd rather not own auth code:* put a
managed IdP with native MCP support (Stytch / WorkOS / Auth0) in front as the
authorization server and federate **it** to Entra. Baseline plan below assumes
self-hosted on the Linode box.

---

## 5. Microsoft Entra app registration (you, as admin)

1. Entra admin center → **App registrations → New registration**.
   - Name: `iPromo Email Connector`
   - Supported account types: **Single tenant** (ipromo.com only).
   - Redirect URI (Web): `https://connector.ipromo.com/oauth/callback`
2. **API permissions** → Microsoft Graph → **Delegated**: `openid`, `profile`, `email`,
   `User.Read` → **Grant admin consent** for iPromo.
3. **Certificates & secrets** → new client secret → store it on the Linode box as an env
   var (`ENTRA_CLIENT_SECRET`). Note **Tenant ID** and **Client ID**.
4. **Gate access to the 40 people:** in **Enterprise applications → this app →
   Properties**, set **Assignment required = Yes**, then assign a security group
   (e.g. `sg-email-connector`). Only assigned users can log in — clean on/offboarding via
   group membership.

---

## 6. Linode provisioning walkthrough

**Create the server**
- Distribution: **Ubuntu 24.04 LTS**. Plan: **Shared CPU / Nanode 1 GB** is ample.
  Region: closest to your users (e.g. Newark/us-east).
- Linode gives a **static public IPv4** by default. For a standard single-NIC Linode,
  **outbound traffic uses that same public IP** — that's the IP you whitelist in SendGrid.
  Note it now.

**DNS**
- Add an **A record** `connector.ipromo.com → <Linode IP>`.
- You're on Cloudflare: set this record **DNS-only (grey cloud)** to avoid proxy quirks
  with OAuth/streaming, and let the origin terminate TLS. (Whitelisting still uses the
  Linode IP regardless — outbound to SendGrid goes direct from the box.)

**Harden**
- Create a non-root sudo user; **SSH keys only** (disable password auth).
- `ufw`: allow 22, 80, 443; deny the rest. Enable `fail2ban` and `unattended-upgrades`.

**Runtime**
- Install **Node LTS** + **PM2** (matches your existing stack).
- **TLS/reverse proxy:** use **Caddy** for automatic Let's Encrypt HTTPS (simplest), or
  nginx + certbot if you prefer. Caddy reverse-proxies `:443 → 127.0.0.1:<app port>`.
- Deploy the app, `pm2 start`, `pm2 startup` + `pm2 save` so it survives reboot.

**Secrets on the box** (env file, not in code / git):
`ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID`, `ENTRA_CLIENT_SECRET`, `SENDGRID_API_KEY`,
`TOKEN_SIGNING_SECRET`.

---

## 7. SendGrid configuration

1. **API key:** create a **restricted key with Mail Send only** (not Full Access). Store
   as `SENDGRID_API_KEY` on the Linode box. Users never see it.
2. **IP Access Management:** add the **Linode static IP** to the allowlist.
   - ⚠️ Add the server IP **first**, and keep a break-glass path (e.g. your own IP) —
     enabling IP Access Management without the right IP present locks everyone out of the API.
3. Keep sending on the **shared IP pool**. No dedicated IP.
4. Confirm **click/open tracking** uses `url9892.ipromo.com` (link branding already verified).

---

## 8. Security & operational controls

- **Identity lock** — server injects `from` from the token; input `from` ignored. (Core control.)
- **Per-user rate cap** — generous vs. real usage, e.g. 200/day per user; global cap e.g.
  2,000/day; plus a short-window burst limit. Backstop against a misused session.
- **Audit log (SQLite)** — one row per message: timestamp, user, to, subject,
  SendGrid message ID, status. This is your record since these **won't appear in Outlook
  Sent** (they bypass M365). Consider an optional auto-BCC-sender toggle later.
- **Data model** (SQLite is plenty at this scale):
  - `users` — entra_oid, email, first_seen, active
  - `tokens` — issued token ↔ user mapping, expiry (encrypted at rest)
  - `send_log` — the audit rows above
- **Secrets** — env/secret file with tight perms; restricted SendGrid key; rotate the
  Entra client secret on a calendar reminder.
- **Health check** — a `/healthz` endpoint + PM2 restart-on-crash.

---

## 9. Rollout on Claude Team

1. As Team owner: **Settings → Connectors → Add custom connector**, point it at
   `https://connector.ipromo.com` (the MCP endpoint), enable it for the workspace.
2. Each of the 40 users enables it and does the **Microsoft login once** (that's what maps
   them to their verified `from`). Only users in the `sg-email-connector` group can complete login.
3. Short user guide: *Add connector → Connect → sign in with your iPromo Microsoft
   account → done.*

---

## 10. Build order (suggested)

1. Provision + harden Linode, DNS, Caddy/TLS. *(we can do this hands-on)*
2. Entra app registration + admin consent + assignment group.
3. MCP server skeleton with OAuth (Entra federation) — verify a test login issues a token.
4. `send_email` tool → SendGrid restricted key → one real test send from your own address;
   confirm it lands and passes DMARC (check headers: `dmarc=pass`, `dkim=pass`).
5. Rate caps + audit log.
6. Enable IP Access Management (server IP added first).
7. Add connector to Team, pilot with 2–3 people, then roll to all 40.

---

## Open items / decisions still to confirm
- Self-hosted OAuth AS (baseline) vs. managed IdP (Stytch/WorkOS/Auth0) front-end — §4.
- Optional auto-BCC-sender so users have a personal copy/record — §8.
- Exact per-user/global rate-cap numbers — §8.
```
