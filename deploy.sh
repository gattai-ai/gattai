#!/usr/bin/env bash
#
# Safe one-command deploy for GATTAI.
#
# Defaults:
#   - holder runs stay disabled unless .env explicitly enables them and the
#     operator passes ENABLE_HOLDER=1
#   - database, frontend dist, .env, Caddyfile, and current backend image are
#     backed up before anything is changed
#   - web services are stopped while building and migrating
#   - a failed deploy restores the previous frontend, database, and code
#
# Usage:
#   ./deploy.sh
#   ENABLE_HOLDER=1 ./deploy.sh   # only after the holder soak has passed;
#                                 # this only unlocks an already-true .env
#
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/gattai}"
DEPLOY_REMOTE="${DEPLOY_REMOTE:-origin}"
DEPLOY_BRANCH="${DEPLOY_BRANCH:-main}"
SMOKE_BASE_URL="${SMOKE_BASE_URL:-https://www.gattai.tech}"
BACKUP_ROOT="${BACKUP_ROOT:-/opt/gattai-backups}"
ENABLE_HOLDER="${ENABLE_HOLDER:-0}"

export APP_DIR DEPLOY_REMOTE DEPLOY_BRANCH SMOKE_BASE_URL BACKUP_ROOT ENABLE_HOLDER

# `git pull` can replace this file while bash is still reading it. Re-exec from
# a temporary copy so the running script cannot be changed mid-deploy.
if [ "${GATTAI_DEPLOY_REEXEC:-0}" != "1" ]; then
  self_path="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
  if [ -f "$self_path" ]; then
    deploy_tmp="$(mktemp "${TMPDIR:-/tmp}/gattai-deploy.XXXXXX.sh")"
    cp "$self_path" "$deploy_tmp"
    chmod 700 "$deploy_tmp"
    export GATTAI_DEPLOY_REEXEC=1
    export GATTAI_DEPLOY_TMP="$deploy_tmp"
    exec bash "$deploy_tmp" "$@"
  fi
fi

if [ "${GATTAI_DEPLOY_REEXEC:-0}" = "1" ] && [ -n "${GATTAI_DEPLOY_TMP:-}" ]; then
  trap 'rm -f "$GATTAI_DEPLOY_TMP"' EXIT
fi

log()  { printf '\n==> %s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "command not found: $1"
}

env_get() {
  local key="$1"
  if [ -f .env ]; then
    grep -E "^${key}=" .env 2>/dev/null | tail -n 1 | cut -d= -f2- | tr -d '\r' \
      | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//" || true
  fi
}

require_env() {
  local key="$1"
  [ -n "$(env_get "$key")" ] || die ".env is missing required key: $key"
}

# ---------------------------------------------------------------------------
# rollback state
# ---------------------------------------------------------------------------
DEPLOY_ACTIVE=0
ROLLING_BACK=0
MIGRATION_STARTED=0
MIGRATION_APPLIED=0
PREV_SHA=""
RELEASE_SHA=""
BACKUP_DIR=""
BACKEND_IMAGE_ID=""

rollback() {
  ROLLING_BACK=1
  set +e

  printf '\n==> Rolling back\n' >&2

  docker compose stop caddy backend

  if [ -n "${BACKUP_DIR:-}" ] && [ -d "$BACKUP_DIR/frontend-dist" ]; then
    printf 'Restoring frontend/dist...\n' >&2
    rm -rf frontend/dist
    cp -a "$BACKUP_DIR/frontend-dist" frontend/dist
  fi

  if [ -n "${BACKUP_DIR:-}" ] && [ -f "$BACKUP_DIR/Caddyfile" ]; then
    cp -p "$BACKUP_DIR/Caddyfile" Caddyfile
  fi
  if [ -n "${BACKUP_DIR:-}" ] && [ -f "$BACKUP_DIR/docker-compose.yml" ]; then
    cp -p "$BACKUP_DIR/docker-compose.yml" docker-compose.yml
  fi

  if [ "$MIGRATION_STARTED" = "1" ] || [ "$MIGRATION_APPLIED" = "1" ]; then
    if [ -n "${BACKUP_DIR:-}" ] && [ -s "$BACKUP_DIR/gattai.dump" ]; then
      printf 'Restoring database from backup...\n' >&2
      if ! docker compose exec -T db pg_restore \
        -U gattai -d gattai --clean --if-exists --no-owner --no-privileges \
        < "$BACKUP_DIR/gattai.dump"; then
        printf 'WARNING: database restore failed. Restore manually from %s\n' \
          "$BACKUP_DIR/gattai.dump" >&2
      fi
    else
      printf 'WARNING: no database backup available for rollback.\n' >&2
    fi
  fi

  if [ -n "${PREV_SHA:-}" ]; then
    printf 'Restoring previous commit %s...\n' "$PREV_SHA" >&2
    git switch --detach "$PREV_SHA" || \
      printf 'WARNING: could not switch to previous commit.\n' >&2
  fi

  docker compose build backend || \
    printf 'WARNING: could not rebuild previous backend image.\n' >&2

  docker compose up -d --wait backend || \
    printf 'WARNING: previous backend did not become healthy.\n' >&2
  docker compose up -d --wait --force-recreate caddy || \
    printf 'WARNING: could not restart Caddy.\n' >&2

  docker compose ps || true

  printf '\nRollback attempted. Inspect logs with:\n' >&2
  printf '  docker compose logs --tail=200 backend caddy\n' >&2
  exit 1
}

on_error() {
  local line="$1"
  trap - ERR
  printf '\nERROR at line %s\n' "$line" >&2
  if [ "$DEPLOY_ACTIVE" = "1" ] && [ "$ROLLING_BACK" = "0" ]; then
    rollback
  fi
  exit 1
}
trap 'on_error $LINENO' ERR

# ---------------------------------------------------------------------------
# preflight
# ---------------------------------------------------------------------------
log "Preflight"
[ -d "$APP_DIR" ] || die "app directory not found: $APP_DIR"
cd "$APP_DIR"

need_cmd git
need_cmd bun
need_cmd docker
need_cmd curl
need_cmd mktemp

docker compose version >/dev/null 2>&1 || die "docker compose v2 is required"
[ -f .env ] || die ".env not found in $APP_DIR"
[ -f Caddyfile ] || die "Caddyfile not found in $APP_DIR"
[ -f frontend/dist/index.html ] || die "frontend/dist/index.html not found"

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  die "working tree has tracked changes. Commit/stash them before deploying."
fi

PREV_SHA="$(git rev-parse HEAD)"

require_env POSTGRES_PASSWORD
require_env NODE_ENV
require_env CHAIN_ID
require_env DATABASE_URL
require_env FRONTEND_URL
require_env SIWE_DOMAIN
require_env SESSION_SECRET
require_env PUBLIC_BASE_URL
require_env FRONTEND_DIST_DIR
require_env ROBINHOOD_RPC_URL
require_env DEPOSIT_MANAGER_ADDRESS
require_env USDG_TOKEN_ADDRESS

[ "$(env_get NODE_ENV)" = "production" ] || die "NODE_ENV must be production"
[ "$(env_get CHAIN_ID)" = "4663" ] || die "CHAIN_ID must be 4663 (mainnet)"

case "$(env_get PUBLIC_BASE_URL)" in
  https://*) ;;
  *) die "PUBLIC_BASE_URL must start with https://" ;;
esac

conf="$(env_get HOLDER_SNAPSHOT_CONFIRMATIONS)"
conf="${conf:-60}"
case "$conf" in
  ''|*[!0-9]*) die "HOLDER_SNAPSHOT_CONFIRMATIONS must be an integer" ;;
esac
[ "$conf" -ge 12 ] || die "HOLDER_SNAPSHOT_CONFIRMATIONS must be >= 12"

if grep -qE '^HOLDER_SNAPSHOT_INTERVAL_MINUTES=' .env; then
  die "HOLDER_SNAPSHOT_INTERVAL_MINUTES is staging-only; remove it from production .env"
fi
if grep -qE '^HOLDER_TIER_MIN_GAP_MINUTES=' .env; then
  die "HOLDER_TIER_MIN_GAP_MINUTES is staging-only; remove it from production .env"
fi

# Backend treats anything other than "false"/"0" as enabled. Match that rule
# here so values like "yes", "on", or an empty assignment cannot silently turn
# holder runs on during a deploy.
if grep -qE '^HOLDER_RUNS_ENABLED=' .env; then
  holder_enabled="$(env_get HOLDER_RUNS_ENABLED)"
  case "$holder_enabled" in
    false|FALSE|False|0)
      log "Holder runs: disabled"
      ;;
    *)
      if [ "$ENABLE_HOLDER" != "1" ]; then
        die "HOLDER_RUNS_ENABLED is on. Set it to false, or run ENABLE_HOLDER=1 ./deploy.sh after the holder soak passes."
      fi
      log "Holder runs: enabled"
      ;;
  esac
else
  log "Holder runs: disabled (docker-compose default)"
fi

log "Updating source"
git fetch "$DEPLOY_REMOTE"
git switch "$DEPLOY_BRANCH"
git pull --ff-only "$DEPLOY_REMOTE" "$DEPLOY_BRANCH"
RELEASE_SHA="$(git rev-parse HEAD)"
log "Release commit: $RELEASE_SHA (previous: $PREV_SHA)"

docker compose config --quiet

log "Validating Caddyfile"
docker compose run --rm --no-deps caddy \
  caddy validate --config /etc/caddy/Caddyfile

log "Installing dependencies"
bun install --frozen-lockfile

log "Starting database"
docker compose up -d --wait db

# ---------------------------------------------------------------------------
# backup
# ---------------------------------------------------------------------------
umask 077
mkdir -p "$BACKUP_ROOT"
BACKUP_DIR="$(mktemp -d "$BACKUP_ROOT/deploy-$(date -u +%Y%m%d-%H%M%S)-XXXXXX")"
chmod 700 "$BACKUP_DIR"

log "Backing up database and release artifacts to $BACKUP_DIR"
docker compose exec -T db pg_dump -U gattai -d gattai -Fc > "$BACKUP_DIR/gattai.dump"
[ -s "$BACKUP_DIR/gattai.dump" ] || die "database backup is empty"

cp -p .env "$BACKUP_DIR/env"
chmod 600 "$BACKUP_DIR/env"
cp -p Caddyfile "$BACKUP_DIR/Caddyfile"
cp -p docker-compose.yml "$BACKUP_DIR/docker-compose.yml"
cp -a frontend/dist "$BACKUP_DIR/frontend-dist"

BACKEND_IMAGE_ID="$(docker compose images -q backend | head -n 1 || true)"
if [ -n "$BACKEND_IMAGE_ID" ]; then
  docker tag "$BACKEND_IMAGE_ID" "gattai-backend:rollback-$PREV_SHA"
fi
printf '%s\n' "$PREV_SHA" > "$BACKUP_DIR/previous-sha"
printf '%s\n' "$RELEASE_SHA" > "$BACKUP_DIR/release-sha"
umask 022

log "Building backend image"
docker compose build backend

DEPLOY_ACTIVE=1
log "Stopping web services (brief maintenance window)"
docker compose stop caddy backend

log "Building frontend"
export VITE_DEFAULT_CHAIN_ID=4663
export VITE_RPC_URLS="4663=https://rpc.mainnet.chain.robinhood.com"
# Force same-origin API base. An absolute cross-origin URL would break the
# SameSite SIWE cookie; `/api` is the path Caddy/Vite proxy to the backend.
# Explicit `/api` also protects against builds that mishandle an empty value.
export VITE_API_URL="/api"
bun run build

log "Applying database migrations"
MIGRATION_STARTED=1
docker compose run --rm backend bun run db:migrate
MIGRATION_STARTED=0
MIGRATION_APPLIED=1

log "Starting backend"
docker compose up -d --wait backend

log "Starting Caddy"
docker compose up -d --wait --force-recreate caddy

log "Running smoke tests against $SMOKE_BASE_URL"
smoke() {
  local url="$1"
  if ! curl -fsS --max-time 20 -o /dev/null "$url"; then
    printf 'Smoke test failed: %s\n' "$url" >&2
    return 1
  fi
  printf '  ok %s\n' "$url"
}
smoke "$SMOKE_BASE_URL/health"
smoke "$SMOKE_BASE_URL/health/holder"
smoke "$SMOKE_BASE_URL/api/v1/public/stats"
smoke "$SMOKE_BASE_URL/api/v1/public/leaderboard"
smoke "$SMOKE_BASE_URL/holders"
smoke "$SMOKE_BASE_URL/stats"

DEPLOY_ACTIVE=0

log "Deploy complete"
printf 'Release: %s\n' "$RELEASE_SHA"
printf 'Backup:  %s\n' "$BACKUP_DIR"
docker compose ps
