---
name: deploy
description: Deploy origin/main to the production server (connector.ipromo.com) and verify health. Use when the user says "deploy", "push main to the server", "ship to prod", or similar.
---

Deploy the iPromo email connector's **origin/main** to production.

## Steps

1. **This ships `origin/main`, not the working tree.** If there are uncommitted or
   unmerged local changes the user seems to expect to ship, stop and confirm first.

2. **Show what will ship.** Compare the server's HEAD to origin/main:

   ```bash
   git fetch origin main
   SERVER=$(ssh ipromo-apps 'su - deploy -c "cd /home/deploy/app && git rev-parse --short HEAD"')
   git log --oneline "$SERVER"..origin/main
   ```

   - If the range is empty, the server is already up to date — say so and **skip the
     deploy** (don't restart production for nothing).
   - Otherwise, briefly tell the user which commits are going out.

3. **Deploy:** run `./scripts/deploy-remote.sh`. It executes `deploy.sh` on the box
   (pull → `npm ci` only if a lockfile changed → build backend + web → PM2 restart)
   and then polls `https://connector.ipromo.com/healthz`, retrying through the brief
   502 window that follows a restart.

4. **Report:** the deployed commit, the PM2 version/status line from the output, and
   the health result.

## Environment facts

- Server: the apps Linode at **172.232.20.34** (shared with `apps.ipromo.com`, fronted
  by Apache), reached via SSH alias `ipromo-apps`. App dir `/home/deploy/app`, a git
  checkout of `main` (read-only deploy key). PM2 process `email-connector`.
- **Only the SSH login is root.** Every command starts with `su - deploy -c`, so the
  pull, `npm ci`, both builds and the PM2 restart run as `deploy`. The connector, PM2,
  `node_modules/`, `dist/` and `connector.sqlite*` are all owned by `deploy`, and
  nothing in the app runs as root. Keep it that way: never run app commands as root
  (a root `npm ci` or `pm2` call leaves root-owned files the next deploy can't touch).
- If `ssh ipromo-apps` fails to resolve or connects to the wrong box, the alias is
  missing or stale. It must point at the IP above, logging in as root with Jose's SSH
  key only (no password):

  ```
  Host ipromo-apps
    HostName 172.232.20.34
    User root
    IdentityFile ~/.ssh/<your-key>
    IdentitiesOnly yes
  ```

  Without that key on the machine running the deploy, SSH fails with
  `Permission denied (publickey)`. Don't try to fall back to a password.

  DNS won't tell you the box: `connector.ipromo.com` is proxied through Cloudflare,
  so it resolves to Cloudflare addresses, not the Linode.
- This IP must be on SendGrid → IP Access Management, since it's what every send
  leaves from. If the connector ever moves boxes, add the new IP there before
  cutting over or sends will fail.
- `deploy.sh` never touches `.env`, `connector.sqlite*`, or other runtime state
  (all gitignored).
- Config policy: daily send caps live in code defaults (`src/config.ts`), NOT in the
  server `.env` — don't re-add `PER_USER_DAILY_CAP`/`GLOBAL_DAILY_CAP` there.
- If the deploy fails at `npm ci`, suspect a native module (e.g. `sharp`) — check
  the output before retrying.
