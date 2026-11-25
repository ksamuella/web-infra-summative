#!/usr/bin/env bash
# Deploy QuakeWatch Africa to one or more web servers over SSH.
#
# Usage:   ./deploy/deploy.sh user@WEB01_IP user@WEB02_IP
# Needs:   ssh + rsync locally; on each server: sudo, nginx, rsync and Node.js >= 18
#          (see README, "Prepare the servers").
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $0 user@host [user@host ...]" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
i=0

for target in "$@"; do
  i=$((i + 1))
  name="$(printf 'web-%02d' "$i")"
  host="${target#*@}"
  echo "==> [$name] Uploading code to $target"

  rsync -az --delete \
    --exclude node_modules --exclude .git --exclude .env --exclude test \
    "$ROOT"/ "$target":/tmp/quakewatch_release/

  echo "==> [$name] Installing and (re)starting services"
  ssh "$target" "set -e
    sudo mkdir -p /opt/quakewatch
    sudo rsync -a --delete /tmp/quakewatch_release/ /opt/quakewatch/
    sudo chown -R www-data:www-data /opt/quakewatch
    echo 'SERVER_NAME=$name' | sudo tee /etc/quakewatch.env >/dev/null
    sudo cp /opt/quakewatch/deploy/quakewatch.service /etc/systemd/system/quakewatch.service
    sudo cp /opt/quakewatch/deploy/nginx-web.conf /etc/nginx/sites-available/quakewatch
    sudo ln -sf /etc/nginx/sites-available/quakewatch /etc/nginx/sites-enabled/quakewatch
    sudo rm -f /etc/nginx/sites-enabled/default
    sudo nginx -t
    sudo systemctl daemon-reload
    sudo systemctl enable quakewatch
    sudo systemctl restart quakewatch
    sudo systemctl reload nginx"

  echo "==> [$name] Health check"
  sleep 2
  curl -fsS "http://$host/health" && echo
done

echo "Done. Now configure the load balancer (deploy/nginx-lb.conf or deploy/haproxy.cfg)."
