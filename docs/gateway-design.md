# MCP Gateway Design — progressive browser tool disclosure

Status: approved 2026-11-02 (grilling rounds 1–3). Target version 0.5.0.

## 1. Goal / non-goals

- Goal: shrink the default model-visible MCP surface from 24 browser tools to
  **10 resident tools + 3 gateway meta tools**, and disclose the other 60
  on demand by capability group. The gateway becomes the only MCP entry point.
- Non-goals: rewriting browser capability; a generic MCP gateway for arbitrary
  servers; touching the 8 native `browser_live_*` tools.

## 2. Decisions

| # | Decision | Ruling |
|---|---|---|
| 1 | Resident set | `navigate, snapshot, click, type, press_key, fill_form, take_screenshot, wait_for, tabs, evaluate` |
| 2 | Gateway form | plugin spawns a stdio gateway process; the gateway spawns `@playwright/mcp` |
| 3 | Inner startup | inner always starts with all six caps; **enable never restarts it** |
| 4 | Groups | `core(14), storage(17), network(4), testing(5), pdf(1), vision(6), devtools(13)`; all off by default |
| 5 | Meta tools | `browser_gateway_groups`, `browser_gateway_enable`, `browser_gateway_call`; no disable |
| 6 | `call` semantics | may invoke any tool, regardless of visibility |
| 7 | State scope | session-only, gateway memory, reset on reconnect |
| 8 | Failure semantics | meta tools always published; resident 10 only when inner ready; structured errors |
| 9 | Rollout | `toolGateway` config, default `false`; this profile on first, 7-day observation |
| 10 | Config conflict | `toolGateway: true` ignores `mcpCaps` and logs a warning |
| 11 | Delivery | plugin source + unit tests + smoke/sweep scripts + README, 0.5.0 |
| 12 | Scope | this plugin only; naming leaves room for generic reuse |

## 3. Process topology

```
dsh-mcp-client (stdio, SERVER_NAME = "playwright-mcp")
   └─ lib/gateway/server.js            ← the MCP surface the model sees
        └─ @playwright/mcp 0.0.80      ← spawned with
             --browser chromium --cdp-endpoint <proxy> --caps storage,network,testing,pdf,vision,devtools
```

- The gateway is both an MCP **server** (to dsh-mcp-client) and an MCP
  **client** (to `@playwright/mcp`).
- It answers `initialize` itself, so the session handshake never depends on
  inner readiness; `failOnStartupError` therefore cannot mask browser failures.
- It performs the inner handshake (`initialize` → `notifications/initialized`
  → paginated `tools/list`) and caches the inner tool catalog.

## 4. Protocol rules

- Framing: newline-delimited JSON-RPC 2.0 in both directions.
- Client `initialize` / `ping` / `tools/list`: answered locally.
- Client `tools/list`: filtered from the inner cache — resident 10 (present in
  inner) + enabled groups' tools + the 3 meta tools. `nextCursor` is dropped.
- Client `tools/call` with a `browser_gateway_*` name: handled locally.
- Client `tools/call` otherwise: forwarded with an id map; the inner response
  (content blocks, `structuredContent`, `isError`) is passed through verbatim.
- `notifications/cancelled`: the client request id is translated to the inner
  request id and forwarded.
- After `enable`: state updates, then `notifications/tools/list_changed` is
  emitted to the client, then the tool result returns.
- Inner crash: `status: degraded`; respawn with backoff; on ready emit
  `tools/list_changed` again. If inner cannot start, `tools/list` still yields
  the 3 meta tools.
- Gateway shutdown (stdin EOF, SIGTERM/SIGINT): SIGTERM inner, exit.

## 5. Tool catalog

Resident (10 of the 24 core tools):

`browser_navigate, browser_snapshot, browser_click, browser_type,
browser_press_key, browser_fill_form, browser_take_screenshot,
browser_wait_for, browser_tabs, browser_evaluate`

Groups (60 tools; names verified against 0.0.80 on 2026-11-02):

- `core` (14): `browser_close, browser_resize, browser_console_messages,
  browser_handle_dialog, browser_file_upload, browser_drop, browser_find,
  browser_navigate_back, browser_run_code_unsafe, browser_network_requests,
  browser_network_request, browser_drag, browser_hover, browser_select_option`
- `storage` (17): cookie ×5, `storage_state`/`set_storage_state`, localstorage
  values ×5, sessionstorage values ×5
- `network` (4): `network_state_set, route, route_list, unroute`
- `testing` (5): `generate_locator` + `verify_*` ×4
- `pdf` (1): `pdf_save`
- `vision` (6): `mouse_*` ×6
- `devtools` (13): resume, highlight ×2, annotate, recording ×2, tracing ×2,
  video ×5

Any inner tool absent from the catalog is unmapped: hidden, counted, and
reported in `browser_gateway_groups` (version-drift guard). Any catalog entry
missing from inner is reported as unavailable by `enable`.

## 6. Meta tool contracts

- `browser_gateway_groups` (no args) → JSON: `status`, `visible`, `resident`,
  `enabled`, `groups: [{name, count, enabled, available}]`, `unmapped`.
- `browser_gateway_enable({group})` → validates against the catalog; unknown
  group is an error listing valid names; idempotent; returns
  `{enabled, added, visible}`.
- `browser_gateway_call({tool, arguments?})` → forwards to inner regardless of
  visibility; unknown tool is an error listing a close match when possible;
  inner errors are returned as-is with `isError`.

Errors use `{content:[{type:"text",text:...}], isError:true}`.

## 7. Wiring

`lib/provider.js`:

- `options.toolGateway === true` → spawn `[gatewayPath, '--', cli, ...innerArgs]`
  where `innerArgs` always carry all six caps; log a warning when `mcpCaps` is
  also set.
- otherwise the current direct path is untouched.

`lib/index.js`: `toolGateway: Schema.boolean().default(false)`.

## 8. Acceptance

1. 73-tool transport sweep: every tool answered by inner (no gateway-level
   unknown-tool error). Automated by `scripts/gateway-sweep.mjs`; 0.5.0 run:
   23 result, 46 inner errors, 3 meta validations, 1 blocking timeout
   (`browser_annotate` waits for a human gesture), 0 gateway errors.
2. 12 semantic smoke calls: resident 10 + `storage` + `network`.
3. Fidelity: screenshot image block, `structuredContent`/`outputSchema`, cancel.
4. State: unknown group rejected, double enable idempotent, reconnect resets,
   killed inner shows `degraded` and still lists meta tools.
5. Rollback: `toolGateway: false` restores the 24-tool direct path.
6. Unit tests cover catalog, filtering, enable/idempotency, call routing,
   id mapping, cancellation, inner crash.

Observation metrics for 7 days: gateway-routed success ≥ direct baseline;
first enable/call < 1.5 s; resident surface fixed at 13; no P0/P1.

## 9. Rollback

Set `toolGateway: false` and restart. No code rollback needed.

## 10. Known limitations

- Inner keeps 70 tool schemas in memory (unpublished ones cost no context).
- `enable` invalidates the prompt cache once.
- MCP progress notifications are not promised to be forwarded.
- Capability names are pinned to 0.0.80 behavior (the CLI `--help` is stale and
  unknown caps are silently ignored).
