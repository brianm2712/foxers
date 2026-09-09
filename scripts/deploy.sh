#!/usr/bin/env bash
#
# Ship Foxxers to a server and restart it.
#
#   ./scripts/deploy.sh                 # to the default host below
#   FOXXERS_HOST_SSH=other ./scripts/deploy.sh
#
# What it does, in order: run the tests, rsync the source up, build the image
# there, and swap the container. The data volume is never touched.
#
# It runs the tests FIRST and stops if they fail. The suite binds localhost
# ports, so it needs to run outside any sandbox.
set -euo pipefail

SSH_HOST="${FOXXERS_HOST_SSH:-fenris01}"
REMOTE_DIR="${FOXXERS_REMOTE_DIR:-/home/brian/foxxers}"
IMAGE="${FOXXERS_IMAGE:-foxxers:latest}"
CONTAINER="${FOXXERS_CONTAINER:-foxxers}"
VOLUME="${FOXXERS_VOLUME:-foxxers_data}"
# Published on loopback only. Cloudflare's tunnel reaches it from the same box;
# nothing outside the machine can. Change it if 8120 is taken over there.
HOST_PORT="${FOXXERS_HOST_PORT:-8120}"
PUBLIC_URL="${FOXXERS_PUBLIC_URL:-https://foxxers.com}"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$here"

echo "==> tests"
failed=0
for t in tests/*.test.js; do
  if node "$t" >/tmp/foxxers-deploy-test.log 2>&1; then
    printf '    ok   %s\n' "$t"
  else
    printf '    FAIL %s\n' "$t"
    tail -20 /tmp/foxxers-deploy-test.log
    failed=1
  fi
done
[ "$failed" -eq 0 ] || { echo "Tests failed — not deploying."; exit 1; }

echo "==> sync to $SSH_HOST:$REMOTE_DIR"
ssh "$SSH_HOST" "mkdir -p '$REMOTE_DIR'"
# --delete so a file removed here is removed there. `data` is excluded twice
# over (here and in .dockerignore) because rsyncing over a live database is the
# one mistake in this script that cannot be undone.
rsync -az --delete \
  --exclude '.git/' \
  --exclude 'data/' \
  --exclude 'node_modules/' \
  --exclude '*.session-key' \
  ./ "$SSH_HOST:$REMOTE_DIR/"

echo "==> build and swap"
ssh "$SSH_HOST" bash -se <<EOF
set -euo pipefail
cd '$REMOTE_DIR'

docker build -t '$IMAGE' .

# The volume outlives the container. Created once; never deleted by this script.
docker volume create '$VOLUME' >/dev/null

docker rm -f '$CONTAINER' >/dev/null 2>&1 || true
docker run -d \
  --name '$CONTAINER' \
  --restart unless-stopped \
  -p 127.0.0.1:$HOST_PORT:8120 \
  -v '$VOLUME':/app/data \
  -e FOXXERS_PUBLIC_URL='$PUBLIC_URL' \
  \${FOXXERS_PAYMENTS:+-e FOXXERS_PAYMENTS="\$FOXXERS_PAYMENTS"} \
  \${FOXXERS_STRIPE_SECRET_KEY:+-e FOXXERS_STRIPE_SECRET_KEY="\$FOXXERS_STRIPE_SECRET_KEY"} \
  \${FOXXERS_STRIPE_WEBHOOK_SECRET:+-e FOXXERS_STRIPE_WEBHOOK_SECRET="\$FOXXERS_STRIPE_WEBHOOK_SECRET"} \
  '$IMAGE' >/dev/null

sleep 2
docker ps --filter "name=^/$CONTAINER\$" --format '    {{.Names}}  {{.Status}}  {{.Ports}}'
EOF

echo "==> health"
ssh "$SSH_HOST" "curl -fsS http://127.0.0.1:$HOST_PORT/api/v1/health" && echo
echo "Deployed. If $PUBLIC_URL does not answer, the tunnel is the next thing to check."
