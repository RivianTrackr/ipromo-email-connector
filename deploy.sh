#!/usr/bin/env bash
#
# Deploy the iPromo email connector on the server.
#
#   Run ON the box, as the `deploy` user, from the app dir:
#     su - deploy -c "cd /home/deploy/app && ./deploy.sh"
#
# Pulls origin/main, reinstalls deps only when a lockfile changed, rebuilds the
# backend + web assets (dist/ is gitignored, so a build is always required), and
# restarts the PM2 process. Runtime state (.env, connector.sqlite*, node_modules,
# dist/) is gitignored, so `git reset --hard` never touches it.
#
set -euo pipefail
cd "$(dirname "$0")"

PM2_APP="email-connector"

# Record lockfile blobs before the pull so we can skip installs when unchanged.
before_root=$(git rev-parse HEAD:package-lock.json 2>/dev/null || echo none)
before_web=$(git rev-parse HEAD:web/package-lock.json 2>/dev/null || echo none)

echo "→ Pulling origin/main…"
git fetch --quiet origin main
git reset --hard origin/main

after_root=$(git rev-parse HEAD:package-lock.json 2>/dev/null || echo none)
after_web=$(git rev-parse HEAD:web/package-lock.json 2>/dev/null || echo none)

if [ "$before_root" != "$after_root" ]; then
  echo "→ Backend deps changed — npm ci"
  npm ci
fi
echo "→ Building backend…"
npm run build

if [ "$before_web" != "$after_web" ]; then
  echo "→ Web deps changed — npm ci (web)"
  ( cd web && npm ci )
fi
echo "→ Building web…"
( cd web && npm run build )

echo "→ Restarting PM2 process '$PM2_APP'…"
pm2 restart "$PM2_APP" --update-env

echo "✓ Deployed $(git rev-parse --short HEAD) — $(git log -1 --pretty=%s)"
