/**
 * dsh-browser-live — gateway tool catalog.
 *
 * The gateway publishes a small fixed surface and discloses the rest by
 * capability group. This module is the single source of truth for both:
 *
 *  - `RESIDENT_TOOLS` (10) — always visible while the inner server is ready.
 *  - `GROUPS` (60) — visible only after `browser_gateway_enable({group})`.
 *  - `META_TOOLS` (3) — the gateway's own tools, always visible.
 *
 * Names verified against `@playwright/mcp` 0.0.80 on 2026-11-02 by listing
 * `tools/list` with no `--caps` and with each cap in turn:
 *   core 24 (10 resident + 14 here), storage +17, network +4, testing +5,
 *   pdf +1, vision +6, devtools +13 → 70 total.
 *
 * No imports: this file must stay loadable from the plugin host, from the
 * gateway process, and from tests.
 */

/** Tools the model can call without enabling anything (10 of the 24 core tools). */
export const RESIDENT_TOOLS = Object.freeze([
  'browser_navigate',
  'browser_snapshot',
  'browser_click',
  'browser_type',
  'browser_press_key',
  'browser_fill_form',
  'browser_take_screenshot',
  'browser_wait_for',
  'browser_tabs',
  'browser_evaluate',
])

/** The gateway's own tools: always published, handled locally. */
export const META_TOOLS = Object.freeze([
  'browser_gateway_groups',
  'browser_gateway_enable',
  'browser_gateway_call',
])

/**
 * Capability groups, in publication order. `core` is the rest of the default
 * Playwright MCP tool set; the other six are `--caps` values.
 */
export const GROUPS = Object.freeze({
  core: Object.freeze([
    'browser_close',
    'browser_resize',
    'browser_console_messages',
    'browser_handle_dialog',
    'browser_file_upload',
    'browser_drop',
    'browser_find',
    'browser_navigate_back',
    'browser_run_code_unsafe',
    'browser_network_requests',
    'browser_network_request',
    'browser_drag',
    'browser_hover',
    'browser_select_option',
  ]),
  storage: Object.freeze([
    'browser_cookie_list',
    'browser_cookie_get',
    'browser_cookie_set',
    'browser_cookie_delete',
    'browser_cookie_clear',
    'browser_storage_state',
    'browser_set_storage_state',
    'browser_localstorage_list',
    'browser_localstorage_get',
    'browser_localstorage_set',
    'browser_localstorage_delete',
    'browser_localstorage_clear',
    'browser_sessionstorage_list',
    'browser_sessionstorage_get',
    'browser_sessionstorage_set',
    'browser_sessionstorage_delete',
    'browser_sessionstorage_clear',
  ]),
  network: Object.freeze([
    'browser_network_state_set',
    'browser_route',
    'browser_route_list',
    'browser_unroute',
  ]),
  testing: Object.freeze([
    'browser_generate_locator',
    'browser_verify_element_visible',
    'browser_verify_text_visible',
    'browser_verify_list_visible',
    'browser_verify_value',
  ]),
  pdf: Object.freeze(['browser_pdf_save']),
  vision: Object.freeze([
    'browser_mouse_move_xy',
    'browser_mouse_click_xy',
    'browser_mouse_drag_xy',
    'browser_mouse_down',
    'browser_mouse_up',
    'browser_mouse_wheel',
  ]),
  devtools: Object.freeze([
    'browser_resume',
    'browser_highlight',
    'browser_hide_highlight',
    'browser_annotate',
    'browser_start_recording',
    'browser_stop_recording',
    'browser_start_tracing',
    'browser_stop_tracing',
    'browser_start_video',
    'browser_stop_video',
    'browser_video_chapter',
    'browser_video_show_actions',
    'browser_video_hide_actions',
  ]),
})

/** Group names in publication order. */
export const GROUP_NAMES = Object.freeze(Object.keys(GROUPS))

/** The groups that are `@playwright/mcp --caps` values (`core` is always on). */
export const CAP_GROUPS = Object.freeze(GROUP_NAMES.filter((name) => name !== 'core'))

const GROUP_OF = new Map()
for (const [group, tools] of Object.entries(GROUPS)) {
  for (const tool of tools) GROUP_OF.set(tool, group)
}

/**
 * Reverse lookup: the group a tool belongs to.
 * @param {string} tool - a tool name as published by the inner server.
 * @returns {string | null} the group name, or null for resident/unknown tools.
 */
export function groupOf(tool) {
  return GROUP_OF.get(tool) ?? null
}
