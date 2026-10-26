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
   SERVER=$(ssh ipromo-apps-deploy 'cd /home/deploy/app && git rev-parse --short HEAD')
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
  by Apache). App dir `/home/deploy/app`, a git checkout of `main` (read-only deploy
  key). PM2 process `email-connector`.
- **Two SSH aliases, same box, same key:**
  - `ipromo-apps-deploy` logs in **as `deploy`**. Deploys use only this one, so they
    never touch root. Run remote commands through `bash -lc "…"` when they need
    node, npm or pm2 on the PATH (a login shell, same as `su - deploy` gave).
  - `ipromo-apps` logs in **as root**. Only for server-level work (Apache config,
    Node upgrades, system packages), never for app commands.

  ```
  Host ipromo-apps-deploy
    HostName 172.232.20.34
    User deploy
    IdentityFile ~/.ssh/<your-key>
    IdentitiesOnly yes

  Host ipromo-apps
    HostName 172.232.20.34
    User root
    IdentityFile ~/.ssh/<your-key>
    IdentitiesOnly yes
  ```

  Both are key-only (no password). `Permission denied (publickey)` means the key
  isn't on this machine or isn't in `/home/deploy/.ssh/authorized_keys` for the
  deploy alias. Don't fall back to a password. If only the root alias works, the
  deploy can still run as `deploy` via
  `ssh ipromo-apps 'su - deploy -c "cd /home/deploy/app && ./deploy.sh"'`, but say so
  and fix the deploy alias afterwards.

  DNS won't tell you the box: `connector.ipromo.com` is proxied through Cloudflare,
  so it resolves to Cloudflare addresses, not the Linode.
- **Nothing in the app runs as root.** The connector, PM2, `node_modules/`, `dist/`
  and `connector.sqlite*` are all owned by `deploy`. Never run `npm` or `pm2` as root
  (it leaves root-owned files the next deploy can't touch, and root's PM2 is a
  separate daemon that doesn't control the connector).
- This IP must be on SendGrid → IP Access Management, since it's what every send
  leaves from. If the connector ever moves boxes, add the new IP there before
  cutting over or sends will fail.
- `deploy.sh` never touches `.env`, `connector.sqlite*`, or other runtime state
  (all gitignored).
- Config policy: daily send caps live in code defaults (`src/config.ts`), NOT in the
  server `.env` — don't re-add `PER_USER_DAILY_CAP`/`GLOBAL_DAILY_CAP` there.
- If the deploy fails at `npm ci`, suspect a native module (e.g. `sharp`) — check
  the output before retrying.
