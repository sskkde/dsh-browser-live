# dsh-browser-live

One-command "ZCode-IAB-like" browser live view for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH), designed for headless servers whose web UI is reached over a public domain. v0.2.0 makes the browser **per-session**: every live session drives its own virtual Chromium while the user watches that same browser in the sidebar.

```bash
dsh plugin --profile web add /path/to/dsh-browser-live
# restart the harness (or run it via the web UI power button)
```

After install + restart, on a host with Docker and passwordless sudo, everything below happens automatically at plugin activation:

1. **Per-session Neko containers** — a `neko-chromium-cdp` image (upstream [m1k1o/neko](https://github.com/m1k1o/neko) `chromium` tag plus Chromium DevTools exposure) is built from `host/`. Each live session gets its own container on a bounded slot pool (`maxSessions`, default 3): its own CDP endpoint (`127.0.0.1:9222+n`), its own profile volume, its own viewer path, and its own WebRTC mux ports. The legacy single shared container `neko` (slot 0, viewer `/browser/`) is adopted as-is, and the first session reuses it. When the pool is full, the least-recently-used session's container is stopped and its nginx block removed (its profile volume is kept). An existing session map is honored across harness restarts.
2. **nginx reverse proxy** — the vhost fronting the DSH web UI gets one `location` block per session viewer (`/browser/<short>/` → `127.0.0.1:8080+2n`), WebSocket-capable and under the existing auth. Needs passwordless sudo; otherwise run `scripts/provision-host.sh` manually.
3. **Per-session browser provider** — the bundle patch mounts `@deepseek-ai/dsh-browser-use` (registry) and this plugin, and **disables** the official exclusive `browser-use-playwright-mcp-neko` attach row (that row lets only one session hold the browser). This plugin's own provider (lib/provider.js) spawns one `@playwright/mcp` attachment per live session against that session's CDP endpoint, so each session's agent drives the very browser its user watches. Containers are lazy: the MCP process (which publishes the tools) starts with the session; the container itself starts on the first browser tool call (`~5s` warm image).
4. **`browser_live_*` one-shot tools** — the high-frequency capabilities of the retired `@anweat/dsh-browser`, re-implemented against the session's own container: `browser_live_open` (open + read + screenshot, optional console/network capture), `browser_live_script` + `browser_live_script_catalog` (builtin read-only article-clean/links/jsonld/forms with pinned SHA-256), `browser_live_recipe` (declarative replay, ≤25 steps), `browser_live_status`, and `browser_live_fetch` (render a URL in a throwaway tab — the replacement for `web_fetch_pro`). Interactive control stays with the session's `mcp__playwright-mcp__browser_*` tools.
5. **Auto-popup live panel** — the client plugin registers a right-sidebar tab ("浏览器直播") whose iframe points at the **current session's** viewer (resolved via `/browser-live/session?session=<id>`, legacy `/browser/` as fallback), and opens it automatically for the first turn of each session in which the agent calls any browser tool — matching `browser_*`, `browser_live_*`, and MCP-namespaced `mcp__<server>__browser_*` tool names.

## Requirements

- DSH **0.1.7-rc.2** — the carried `@deepseek-ai/*` packages are version-locked to the harness; bump `dependencies`/`peerDependencies` in `package.json` in lockstep when upgrading DSH.
- **Linked-plugin resolution**: when installed via `link:` (this workspace), the harness resolves the plugin's bare imports by walking `node_modules` up from the workspace's *real* path — so this repo carries `node_modules/` as a symlink farm pointing at the same harness/profile copies (`scripts/link-peer-deps.sh` recreates it; run once after cloning, then restart). Without it the entry fails with "failed to import". A regular (non-link) install gets its peers from the profile instead.
- Linux host with Docker; passwordless sudo for nginx provisioning (optional, degrades to the manual script).
- The DSH web UI must be fronted by nginx (vhost containing `proxy_pass http://127.0.0.1:3080`).

## Notes

- Pool sizing: each slot costs one container (host networking, `--shm-size 1g`, WebRTC UDP `52100+n` / TCP `52101+n`). Default `maxSessions=3` (config `maxSessions`).
- Host-networking constraints handled per slot: Chromium DevTools port (`CDP_PORT` env → `%(ENV_CDP_PORT)s` in the image's supervisord conf), WebRTC mux ports, and the X11 **abstract socket** (`DISPLAY=:9n0.0` per slot — abstract sockets share the host network namespace, so the image-default `:99` would collide with the legacy container).
- The session→container map lives in `~/.dsh/neko-browser-live.map.json`; Neko passwords in `~/.dsh/neko-browser-live.env` (chmod 600). Screenshots from `browser_live_*` tools land in `~/.dsh/data/browser-live/<short>/`.
- The image is rebuilt (`docker build -q`, cached) at container start, so edits to `host/chromium.conf` self-heal on the next start; an already-running container keeps its image until restarted.
- The right pane opens automatically but never steals OS focus — it is in-page navigation only.

## Rollback

```bash
dsh plugin --profile web remove dsh-browser-live
# containers and nginx blocks are left running; remove manually if desired:
docker rm -f neko && docker volume rm neko-profile   # careful: volume holds browser profile
docker ps -a --format '{{.Names}}' | grep '^neko-' | xargs -r docker rm -f
# drop per-session location blocks from the vhost (markers: /browser/<short>/)
```

## Upgrading from v0.1.0

Re-run `dsh plugin --profile web add <path>` so the bundle patch re-merges (the v0.1.0 insert row for the official provider is replaced by the `disabled: true` override; verify the merged `cordis.patch.yml` no longer carries an active `browser-use-playwright-mcp-neko` row), then restart. The first run rebuilds the `neko-chromium-cdp` image (parameterized CDP port) and writes the new session map.
