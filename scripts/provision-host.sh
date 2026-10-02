#!/usr/bin/env bash
# dsh-browser-live manual host provisioning fallback.
#
# The plugin normally does this itself at activation (idempotent). Use this
# script when passwordless sudo is unavailable to the DSH process, or to
# re-run the host setup by hand. Run as a user with docker + sudo access.
set -euo pipefail

CONTAINER=neko
IMAGE=neko-chromium-cdp:latest
CDP_PORT=9222
WEB_PORT=8080
PUBLIC_PATH=/browser
UDP_MUX=52100
TCP_MUX=52101
HOST_DIR="$(cd "$(dirname "$0")/../host" && pwd)"

docker version >/dev/null

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  docker build -q -t "$IMAGE" "$HOST_DIR"
fi

ENV_FILE="${DSH_HOME:-$HOME/.dsh}/neko-browser-live.env"
if [ ! -f "$ENV_FILE" ]; then
  mkdir -p "$(dirname "$ENV_FILE")"
  PUBLIC_IP="$(curl -s --max-time 5 https://checkip.amazonaws.com || true)"
  {
    echo "NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD=$(openssl rand -hex 12)"
    echo "NEKO_MEMBER_MULTIUSER_USER_PASSWORD=$(openssl rand -hex 12)"
    [ -n "$PUBLIC_IP" ] && echo "NEKO_WEBRTC_NAT1TO1=$PUBLIC_IP"
    echo "NEKO_WEBRTC_UDPMUX=$UDP_MUX"
    echo "NEKO_WEBRTC_TCPMUX=$TCP_MUX"
    echo "NEKO_SERVER_PATH_PREFIX=$PUBLIC_PATH"
    echo "NEKO_SERVER_PROXY=true"
    echo "NEKO_SERVER_BIND=127.0.0.1:$WEB_PORT"
  } > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "wrote $ENV_FILE (neko passwords inside)"
fi

if ! docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -q true; then
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  docker run -d --name "$CONTAINER" --hostname "$CONTAINER" \
    --restart unless-stopped --network host --shm-size 1g \
    --env-file "$ENV_FILE" \
    -v neko-profile:/home/neko/.config/chromium \
    --health-cmd "wget -q -O - http://127.0.0.1:$WEB_PORT$PUBLIC_PATH/health || exit 1" \
    --health-interval 15s --health-timeout 5s --health-retries 4 \
    "$IMAGE"
fi

for _ in $(seq 1 20); do
  curl -s --max-time 2 "http://127.0.0.1:$CDP_PORT/json/version" >/dev/null && break
  sleep 2
done
curl -s --max-time 2 "http://127.0.0.1:$CDP_PORT/json/version" >/dev/null \
  && echo "CDP up on 127.0.0.1:$CDP_PORT" \
  || { echo "CDP did not come up; check: docker logs $CONTAINER"; exit 1; }

# nginx: patch the vhost that fronts the DSH web UI
VHOST=""
for f in /etc/nginx/sites-enabled/*; do
  [ -f "$f" ] && grep -q "proxy_pass http://127.0.0.1:3080" "$f" 2>/dev/null && VHOST="$f" && break
done
if [ -z "$VHOST" ]; then
  echo "no nginx vhost proxying 127.0.0.1:3080 found; add a $PUBLIC_PATH location manually"
  exit 0
fi
if grep -q "location $PUBLIC_PATH" "$VHOST"; then
  echo "nginx vhost already proxies $PUBLIC_PATH"
else
  sudo cp "$VHOST" "$VHOST.browser-live.bak"
  sudo python3 - "$VHOST" "$PUBLIC_PATH" "$WEB_PORT" <<'PY'
import sys
path, marker, web_port = sys.argv[1], sys.argv[2], sys.argv[3]
src = open(path).read()
lines = src.split('\n')
idx443 = next(i for i, l in enumerate(lines) if 'listen 443' in l)
idxloc = next(i for i, l in enumerate(lines) if i > idx443 and l.strip().startswith('location / {'))
block = (
    '    # browser-live: Neko virtual browser (managed by dsh-browser-live plugin)\n'
    '    location ' + marker + '/ {\n'
    '        proxy_pass http://127.0.0.1:' + web_port + ';\n'
    '        proxy_http_version 1.1;\n'
    '        proxy_set_header Host $host;\n'
    '        proxy_set_header X-Real-IP $remote_addr;\n'
    '        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n'
    '        proxy_set_header X-Forwarded-Proto $scheme;\n'
    '        proxy_set_header Upgrade $http_upgrade;\n'
    '        proxy_set_header Connection "upgrade";\n'
    '        proxy_buffering off;\n'
    '        proxy_cache off;\n'
    '        proxy_read_timeout 3600s;\n'
    '        proxy_send_timeout 3600s;\n'
    '    }\n'
    '\n'
)
lines.insert(idxloc, block)
open(path, 'w').write('\n'.join(lines))
print('patched')
PY
  sudo nginx -t
  sudo systemctl reload nginx
  echo "nginx: added $PUBLIC_PATH to $VHOST"
fi
