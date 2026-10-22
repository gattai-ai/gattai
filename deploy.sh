#!/usr/bin/env bash
set -euo pipefail

cd /opt/gattai

git fetch origin
git switch main
git pull --ff-only origin main

bun install --frozen-lockfile

export VITE_DEFAULT_CHAIN_ID=4663
export VITE_RPC_URLS="4663=https://rpc.mainnet.chain.robinhood.com"
unset VITE_API_URL

bun run build

docker compose build backend
docker compose up -d --wait db
docker compose run --rm backend bun run db:migrate
docker compose up -d --wait backend caddy

docker compose ps
