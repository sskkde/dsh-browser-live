#!/usr/bin/env bash
# dsh-browser-live manual host provisioning fallback.
#
# The plugin normally does this itself at activation (idempotently, per
# session). Use this script when passwordless sudo is unavailable to the DSH
# process, or to re-run the host setup by hand. Run as a user with docker +
# sudo access.
#
# Usage:
#   provision-host.sh                # adopt/verify the legacy slot-0 container
#   provision-host.sh <short> <slot> # start one per-session container + nginx block
set -euo pipefail

CONTAINER0=neko
IMAGE=neko-chromium-cdp:latest
CDP_PORT0=9222
WEB_PORT0=8080
PUBLIC_PATH0=/browser
UDP_MUX0=52100
TCP_MUX0=52101
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
    echo "NEKO_WEBRTC_UDPMUX=$UDP_MUX0"
    echo "NEKO_WEBRTC_TCPMUX=$TCP_MUX0"
    echo "NEKO_SERVER_PATH_PREFIX=$PUBLIC_PATH0"
    echo "NEKO_SERVER_PROXY=true"
    echo "NEKO_SERVER_BIND=127.0.0.1:$WEB_PORT0"
  } > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "wrote $ENV_FILE (neko passwords inside)"
fi

start_container() { # name volume web_port public_path udp tcp
  local name="$1" volume="$2" web_port="$3" public_path="$4" udp="$5" tcp="$6"
  local cdp_port="$CDP_PORT0"
  [ "$name" != "$CONTAINER0" ] && cdp_port=$((CDP_PORT0 + SLT))
  # The env file must carry CDP_PORT for the image's %(ENV_CDP_PORT)s expansion.
  grep -q '^CDP_PORT=' "$ENV_FILE" || echo "CDP_PORT=$CDP_PORT0" >> "$ENV_FILE"
  if ! docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null | grep -q true; then
    docker rm -f "$name" >/dev/null 2>&1 || true
    local -a extra=()
    if [ "$name" != "$CONTAINER0" ]; then
      extra=(-e "NEKO_WEBRTC_UDPMUX=$udp" -e "NEKO_WEBRTC_TCPMUX=$tcp"
             -e "NEKO_SERVER_PATH_PREFIX=$public_path" -e NEKO_SERVER_PROXY=true
             -e "NEKO_SERVER_BIND=127.0.0.1:$web_port"
             # X11 abstract sockets share the host network namespace; avoid the
             # legacy container's DISPLAY=:99.
             -e "DISPLAY=:$((900 + SLT * 10)).0")
    fi
    docker run -d --name "$name" --hostname "$name" \
      --restart unless-stopped --network host --shm-size 1g \
      --env-file "$ENV_FILE" "${extra[@]}" \
      -e "CDP_PORT=$cdp_port" \
      -v "$volume:/home/neko/.config/chromium" \
      --health-cmd "wget -q -O - http://127.0.0.1:$web_port$public_path/health || exit 1" \
      --health-interval 15s --health-timeout 5s --health-retries 4 \
      "$IMAGE"
  fi

  for _ in $(seq 1 20); do
    curl -s --max-time 2 "http://127.0.0.1:$cdp_port/json/version" >/dev/null && break
    sleep 2
  done
  curl -s --max-time 2 "http://127.0.0.1:$cdp_port/json/version" >/dev/null \
    && echo "CDP up on 127.0.0.1:$cdp_port ($name)" \
    || { echo "CDP did not come up; check: docker logs $name"; exit 1; }
}

# nginx: patch the vhost that fronts the DSH web UI
ensure_nginx() { # public_path web_port
  local public_path="$1" web_port="$2"
  local vhost=""
  for f in /etc/nginx/sites-enabled/*; do
    [ -f "$f" ] && grep -q "proxy_pass http://127.0.0.1:3080" "$f" 2>/dev/null && vhost="$f" && break
  done
  if [ -z "$vhost" ]; then
    echo "no nginx vhost proxying 127.0.0.1:3080 found; add a $public_path location manually"
    return 0
  fi
  if grep -q "location $public_path/ {" "$vhost"; then
    echo "nginx vhost already proxies $public_path"
    return 0
  fi
  sudo cp "$vhost" "$vhost.browser-live.bak"
  sudo python3 - "$vhost" "$public_path" "$web_port" <<'PY'
import sys
path, marker, web_port = sys.argv[1], sys.argv[2], sys.argv[3]
src = open(path).read()
lines = src.split('\n')
idx443 = next((i for i, l in enumerate(lines) if 'listen 443' in l), None)
idxloc = next((i for i, l in enumerate(lines) if idx443 is None or (i > idx443 and l.strip().startswith('location / {'))), len(lines))
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
  echo "nginx: added $public_path to $vhost"
}

if [ $# -eq 0 ]; then
  # Legacy slot 0: adopt or start the shared container and its viewer path.
  start_container "$CONTAINER0" neko-profile "$WEB_PORT0" "$PUBLIC_PATH0" "$UDP_MUX0" "$TCP_MUX0"
  ensure_nginx "$PUBLIC_PATH0" "$WEB_PORT0"
  exit 0
fi

if [ $# -ne 2 ]; then
  echo "usage: $0 [short slot]" >&2
  exit 2
fi

SHORT="$1"
SLT="$2"
NAME="neko-$SHORT"
VOLUME="neko-profile-$SHORT"
CDP_PORT=$((CDP_PORT0 + SLT))
WEB_PORT=$((WEB_PORT0 + 2 * SLT))
PUBLIC_PATH="/browser/$SHORT"
UDP_MUX=$((UDP_MUX0 + SLT))
TCP_MUX=$((TCP_MUX0 + SLT))

start_container "$NAME" "$VOLUME" "$WEB_PORT" "$PUBLIC_PATH" "$UDP_MUX" "$TCP_MUX"
ensure_nginx "$PUBLIC_PATH" "$WEB_PORT"
