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
   SERVER=$(ssh ipromo-connector 'su - deploy -c "cd /home/deploy/app && git rev-parse --short HEAD"')
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

- Server: SSH alias `ipromo-connector` (Linode). App dir `/home/deploy/app`, a git
  checkout of `main` (read-only deploy key). PM2 process `email-connector`, runs as
  the `deploy` user — never as root.
- `deploy.sh` never touches `.env`, `connector.sqlite*`, or other runtime state
  (all gitignored).
- Config policy: daily send caps live in code defaults (`src/config.ts`), NOT in the
  server `.env` — don't re-add `PER_USER_DAILY_CAP`/`GLOBAL_DAILY_CAP` there.
- If the deploy fails at `npm ci`, suspect a native module (e.g. `sharp`) — check
  the output before retrying.
