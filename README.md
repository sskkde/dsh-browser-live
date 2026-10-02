# dsh-browser-live

One-command "ZCode-IAB-like" browser live view for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH), designed for headless servers whose web UI is reached over a public domain.

```bash
dsh plugin --profile web add /path/to/dsh-browser-live
# restart the harness (or run it via the web UI power button)
```

After install + restart, on a host with Docker and passwordless sudo, everything below happens automatically at plugin activation:

1. **Neko virtual Chromium** — a `neko-chromium-cdp` image (upstream [m1k1o/neko](https://github.com/m1k1o/neko) `chromium` tag plus Chromium DevTools exposure) is built from `host/` and run with host networking, a persistent profile volume, and CDP on `127.0.0.1:9222`. An already-running healthy `neko` container is adopted as-is.
2. **nginx reverse proxy** — the vhost fronting the DSH web UI gets a `location /browser/` block (WebSocket-capable, inherits the existing auth) pointing at Neko. Needs passwordless sudo; otherwise run `scripts/provision-host.sh` manually.
3. **Official browser-use provider** — the bundle patch mounts `@deepseek-ai/dsh-browser-use` + `@deepseek-ai/dsh-experimental-browser-use-playwright-mcp` (carried as this package's dependencies) in `mode: attach` against the same CDP endpoint, so the agent drives the very browser the user watches.
4. **Auto-popup live panel** — a client plugin registers a right-sidebar tab ("浏览器直播") rendering a same-origin iframe over `<origin>/browser/`, and opens it automatically for the first turn of each session in which the agent calls any `browser_*` tool.

## Requirements

- DSH **0.1.7-rc.2** — the two carried provider packages are version-locked to the harness; bump `dependencies` in `package.json` in lockstep when upgrading DSH.
- Linux host with Docker; passwordless sudo for nginx provisioning (optional, degrades to the manual script).
- The DSH web UI must be fronted by nginx (vhost containing `proxy_pass http://127.0.0.1:3080`).

## Notes

- WebRTC needs UDP 52100 (and optionally TCP 52101 fallback) reachable from clients; WebRTC-over-TCP works without any firewall change.
- Neko UI passwords live in `~/.dsh/neko-browser-live.env` (chmod 600) on fresh installs; existing deployments are adopted untouched.
- The right pane opens automatically but never steals OS focus — it is in-page navigation only.

## Rollback

```bash
dsh plugin --profile web remove dsh-browser-live
# container and nginx block are left running; remove manually if desired:
docker rm -f neko && docker volume rm neko-profile   # careful: volume holds browser profile
```
