#!/usr/bin/env bash
#
# Deploy origin/main to production from a workstation.
#
#   ./scripts/deploy-remote.sh
#
# Requires the `ipromo-apps-deploy` SSH host alias, which logs in straight as the
# `deploy` user (see README → Deploy), so deploys never touch root. Runs
# deploy.sh on the box (pull → conditional npm ci → build → PM2 restart), then
# polls the public health endpoint — a brief 502 right after restart is normal,
# so we retry before declaring failure.
set -euo pipefail

echo "→ Deploying origin/main to connector.ipromo.com…"
# bash -l gives the same login environment (PATH for node/pm2) that su - did.
ssh ipromo-apps-deploy 'bash -lc "cd /home/deploy/app && ./deploy.sh"'

echo "→ Verifying health…"
code=""
for _ in 1 2 3 4 5; do
  sleep 2
  code=$(curl -s -o /dev/null -w "%{http_code}" https://connector.ipromo.com/healthz || true)
  if [ "$code" = "200" ]; then
    echo "✓ Healthy (HTTP 200)"
    exit 0
  fi
done
echo "✗ Health check failed (last HTTP ${code:-none})"
exit 1
