#!/usr/bin/env bash
# Deploy HarvestSky to Web01 and Web02 over SSH.
#
# Usage:   LB_IP=<Lb01 address> ./deploy/deploy.sh user@WEB01_IP user@WEB02_IP
#
# Needs locally:  ssh, rsync, curl, and a .env.production file (git-ignored) containing
#                 OPENWEATHER_API_KEY, AUTH_SECRET and SYNC_SECRET (see README).
# Needs on each server: sudo, nginx, rsync and Node.js >= 22.13 (see README, "Prepare the servers").
# Use IP addresses (not host names): they are written into the nginx access rules.
set -euo pipefail

if [ $# -ne 2 ]; then
  echo "Usage: LB_IP=<lb address> $0 user@WEB01_IP user@WEB02_IP" >&2
  exit 1
fi
: "${LB_IP:?Set LB_IP to the address of Lb01, e.g. LB_IP=10.0.0.5}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/.env.production}"
if [ ! -f "$ENV_FILE" ]; then
  echo "Missing $ENV_FILE. Create it from .env.example (OPENWEATHER_API_KEY, AUTH_SECRET, SYNC_SECRET)." >&2
  exit 1
fi
for key in OPENWEATHER_API_KEY AUTH_SECRET SYNC_SECRET; do
  grep -Eq "^${key}=.+" "$ENV_FILE" || { echo "$key is empty in $ENV_FILE" >&2; exit 1; }
done

targets=("$1" "$2")

for idx in 0 1; do
  target="${targets[$idx]}"
  peer="${targets[$((1 - idx))]}"
  name="$(printf 'web-%02d' $((idx + 1)))"
  host="${target#*@}"
  peer_host="${peer#*@}"

  echo "==> [$name] Uploading code to $target"
  rsync -az --delete \
    --exclude node_modules --exclude .git --exclude '.env*' --exclude data --exclude test \
    "$ROOT"/ "$target":/tmp/harvestsky_release/

  echo "==> [$name] Writing secrets (root-only file /etc/harvestsky.env)"
  { grep -vE '^(SERVER_NAME|PEERS)=' "$ENV_FILE"; echo "SERVER_NAME=$name"; echo "PEERS=http://$peer_host"; } \
    | ssh "$target" "sudo tee /etc/harvestsky.env >/dev/null && sudo chown root:root /etc/harvestsky.env && sudo chmod 600 /etc/harvestsky.env"

  echo "==> [$name] Installing nginx site"
  sed -e "s/__LB_IP__/$LB_IP/g" -e "s/__PEER_IP__/$peer_host/g" "$ROOT/deploy/nginx-web.conf" \
    | ssh "$target" "sudo tee /etc/nginx/sites-available/harvestsky >/dev/null"

  echo "==> [$name] Installing app and (re)starting services"
  ssh "$target" "set -e
    sudo mkdir -p /opt/harvestsky
    sudo rsync -a --delete /tmp/harvestsky_release/ /opt/harvestsky/
    sudo chown -R www-data:www-data /opt/harvestsky
    sudo cp /opt/harvestsky/deploy/harvestsky.service /etc/systemd/system/harvestsky.service
    sudo ln -sf /etc/nginx/sites-available/harvestsky /etc/nginx/sites-enabled/harvestsky
    sudo rm -f /etc/nginx/sites-enabled/default
    sudo nginx -t
    sudo systemctl daemon-reload
    sudo systemctl enable harvestsky
    sudo systemctl restart harvestsky
    sudo systemctl reload nginx"

  echo "==> [$name] Health check"
  ok=0
  for _ in 1 2 3 4 5 6 7 8; do
    if curl -fsS "http://$host/health"; then echo; ok=1; break; fi
    sleep 2
  done
  [ "$ok" = 1 ] || { echo "Health check failed on $host. Run: ssh $target 'sudo journalctl -u harvestsky -n 50'" >&2; exit 1; }
done

echo "Done. Now configure the load balancer (deploy/nginx-lb.conf or deploy/haproxy.cfg)."
