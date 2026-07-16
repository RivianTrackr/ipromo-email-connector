#!/usr/bin/env bash
#
# Deploy origin/main to production from a workstation.
#
#   ./scripts/deploy-remote.sh
#
# Requires the `ipromo-connector` SSH host alias (see README → Deploy). Runs
# deploy.sh on the box (pull → conditional npm ci → build → PM2 restart), then
# polls the public health endpoint — a brief 502 right after restart is normal,
# so we retry before declaring failure.
set -euo pipefail

echo "→ Deploying origin/main to connector.ipromo.com…"
ssh ipromo-connector 'su - deploy -c "cd /home/deploy/app && ./deploy.sh"'

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
