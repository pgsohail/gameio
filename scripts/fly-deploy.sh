#!/usr/bin/env bash
# Deploy buildupio to Fly.io (reads secrets from .env — never commit .env).
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v flyctl >/dev/null 2>&1; then
  echo "Install flyctl: https://fly.io/docs/hands-on/install-flyctl/"
  exit 1
fi

APP="${FLY_APP:-buildupio}"

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

if [[ -z "${JWT_SECRET:-}" || "${JWT_SECRET}" == "local-dev-secret-change-me" || "${JWT_SECRET}" == "dev-secret-change-in-production" ]]; then
  echo "Set JWT_SECRET in .env to a long random string (e.g. openssl rand -hex 32)"
  exit 1
fi

if [[ -z "${GOOGLE_CLIENT_ID:-}" ]]; then
  echo "Set GOOGLE_CLIENT_ID in .env (same value as VITE_GOOGLE_CLIENT_ID)"
  exit 1
fi

VITE_GOOGLE_CLIENT_ID="${VITE_GOOGLE_CLIENT_ID:-$GOOGLE_CLIENT_ID}"

echo "→ Setting runtime secrets on ${APP}..."
flyctl secrets set \
  "JWT_SECRET=${JWT_SECRET}" \
  "GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID}" \
  -a "$APP"

echo "→ Deploying (baking VITE_GOOGLE_CLIENT_ID into frontend)..."
flyctl deploy \
  -a "$APP" \
  --build-arg "VITE_GOOGLE_CLIENT_ID=${VITE_GOOGLE_CLIENT_ID}"

echo ""
echo "Done. Open https://${APP}.fly.dev"
echo "Add https://${APP}.fly.dev to Google OAuth → Authorized JavaScript origins"
