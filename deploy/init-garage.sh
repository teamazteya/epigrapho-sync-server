#!/usr/bin/env bash
# One-time Garage setup: gives the single node its storage, creates the
# "attachments" bucket and the key the sync server uses (S3_KEY_ID and
# S3_SECRET from .env). Safe to run again: each step skips what exists.
set -euo pipefail
cd "$(dirname "$0")"
set -a; . ./.env; set +a
g() { docker compose exec -T notesnook-s3 /garage "$@"; }

node=$(g node id -q | cut -d@ -f1)
if ! g layout show | grep -q "$node"; then
  g layout assign -z dc1 -c 100G "$node"
  g layout apply --version 1
fi
g bucket info attachments >/dev/null 2>&1 || g bucket create attachments
g key info "$S3_KEY_ID" >/dev/null 2>&1 || g key import --yes -n epigrapho-sync "$S3_KEY_ID" "$S3_SECRET"
g bucket allow --read --write --owner attachments --key "$S3_KEY_ID"
g bucket info attachments
