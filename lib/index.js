/**
 * dsh-browser-live — server half.
 *
 * Provisions (or adopts) the host-side pieces the live browser panel needs:
 *  - a Neko virtual Chromium container with CDP enabled (image built from the
 *    bundled host/ context),
 *  - an nginx `location <publicPath>/` reverse-proxy block in the vhost that
 *    fronts the DSH web UI.
 *
 * The bundle patch separately mounts the official browser-use provider stack
 * in attach mode, so the agent drives the same browser the user watches.
 *
 * Provisioning is best-effort and idempotent: it never blocks boot, never
 * throws into the harness, and an existing healthy deployment is adopted as
 *-is (container kept, nginx block left alone). Failures are logged with the
 * `[browser-live]` prefix; nginx work needs passwordless sudo and degrades to
 * a manual instruction when unavailable.
 */

import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** Cordis identity for the provisioning plugin. */
export const name = 'browser-live'

/** Provisioning shells out to docker/nginx directly; no host services needed. */
export const inject = []

const CONTAINER = 'neko'
const IMAGE = 'neko-chromium-cdp:latest'
const CDP_PORT = 9222
const WEB_PORT = 8080
const PUBLIC_PATH = '/browser'
const DSH_WEB_PORT = 3080
const UDP_MUX = 52100
const TCP_MUX = 52101

function log(...args) {
  console.log('[browser-live]', ...args)
}

function warn(...args) {
  console.warn('[browser-live]', ...args)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function hostDir() {
  // lib/index.js lives beside host/ in the package (link: installs keep this layout).
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'host')
}

function dshHome() {
  return process.env.DSH_HOME ? path.resolve(process.env.DSH_HOME) : path.join(os.homedir(), '.dsh')
}

async function cdpAlive(timeoutMs = 3000) {
  try {
    const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, { signal: AbortSignal.timeout(timeoutMs) })
    return response.ok
  } catch {
    return false
  }
}

async function containerRunning() {
  try {
    const { stdout } = await run('docker', ['inspect', '-f', '{{.State.Running}}', CONTAINER], { timeout: 10_000 })
    return stdout.trim() === 'true'
  } catch {
    return false
  }
}

async function ensureEnvFile() {
  const envPath = path.join(dshHome(), 'neko-browser-live.env')
  if (fs.existsSync(envPath)) return envPath
  let publicIp = ''
  try {
    const { stdout } = await run('curl', ['-s', '--max-time', '5', 'https://checkip.amazonaws.com'], { timeout: 8_000 })
    publicIp = stdout.trim()
  } catch {
    warn('public IP detection failed; set NEKO_WEBRTC_NAT1TO1 manually in', envPath, 'if WebRTC video fails')
  }
  const lines = [
    `NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD=${crypto.randomBytes(12).toString('hex')}`,
    `NEKO_MEMBER_MULTIUSER_USER_PASSWORD=${crypto.randomBytes(12).toString('hex')}`,
    ...(publicIp ? [`NEKO_WEBRTC_NAT1TO1=${publicIp}`] : []),
    `NEKO_WEBRTC_UDPMUX=${UDP_MUX}`,
    `NEKO_WEBRTC_TCPMUX=${TCP_MUX}`,
    `NEKO_SERVER_PATH_PREFIX=${PUBLIC_PATH}`,
    'NEKO_SERVER_PROXY=true',
    `NEKO_SERVER_BIND=127.0.0.1:${WEB_PORT}`,
    '',
  ]
  fs.writeFileSync(envPath, lines.join('\n'), { mode: 0o600 })
  log('wrote', envPath, '(neko passwords live here, chmod 600)')
  return envPath
}

async function ensureImage() {
  try {
    await run('docker', ['image', 'inspect', IMAGE], { timeout: 10_000 })
    return
  } catch {
    // image missing: build below
  }
  log('building image', IMAGE, 'from', hostDir())
  await run('docker', ['build', '-q', '-t', IMAGE, hostDir()], { timeout: 300_000 })
}

async function startContainer(envPath) {
  await run('docker', ['rm', '-f', CONTAINER], { timeout: 30_000 }).catch(() => undefined)
  await run('docker', ['run', '-d',
    '--name', CONTAINER,
    // Fixed hostname: the profile volume's chromium SingletonLock records it;
    // a changing hostname would make every restart refuse the profile.
    '--hostname', CONTAINER,
    '--restart', 'unless-stopped',
    // Chrome enforces loopback-only DevTools binds, so host networking is the
    // only way the host-side CDP attach (127.0.0.1:CDP_PORT) can reach it.
    '--network', 'host',
    '--shm-size', '1g',
    '--env-file', envPath,
    '-v', 'neko-profile:/home/neko/.config/chromium',
    '--health-cmd', `wget -q -O - http://127.0.0.1:${WEB_PORT}${PUBLIC_PATH}/health || exit 1`,
    '--health-interval', '15s', '--health-timeout', '5s', '--health-retries', '4',
    IMAGE,
  ], { timeout: 60_000 })
  for (let attempt = 0; attempt < 20; attempt++) {
    await sleep(2_000)
    if (await cdpAlive(2_000)) {
      log('container CDP is up on', `127.0.0.1:${CDP_PORT}`)
      return
    }
  }
  throw new Error('container CDP did not come up within 40s; check docker logs ' + CONTAINER)
}

// Runs as root via `sudo -n python3 -c <script> <vhost> <publicPath> <webPort>`.
// Idempotent: exits reporting "present" when the marker location already exists.
const NGINX_PATCH_PY = [
  'import sys',
  'path, marker, web_port = sys.argv[1], sys.argv[2], sys.argv[3]',
  'src = open(path).read()',
  "if ('location %s' % marker) in src:",
  "    print('present'); sys.exit(0)",
  "lines = src.split('\\n')",
  "idx443 = next(i for i, l in enumerate(lines) if 'listen 443' in l)",
  "idxloc = next(i for i, l in enumerate(lines) if i > idx443 and l.strip().startswith('location / {'))",
  'block = (',
  "    '    # browser-live: Neko virtual browser (managed by dsh-browser-live plugin)\\n'",
  "    '    location ' + marker + '/ {\\n'",
  "    '        proxy_pass http://127.0.0.1:' + web_port + ';\\n'",
  "    '        proxy_http_version 1.1;\\n'",
  "    '        proxy_set_header Host $host;\\n'",
  "    '        proxy_set_header X-Real-IP $remote_addr;\\n'",
  "    '        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\\n'",
  "    '        proxy_set_header X-Forwarded-Proto $scheme;\\n'",
  "    '        proxy_set_header Upgrade $http_upgrade;\\n'",
  "    '        proxy_set_header Connection \"upgrade\";\\n'",
  "    '        proxy_buffering off;\\n'",
  "    '        proxy_cache off;\\n'",
  "    '        proxy_read_timeout 3600s;\\n'",
  "    '        proxy_send_timeout 3600s;\\n'",
  "    '    }\\n'",
  "    '\\n'",
  ')',
  'backup = path + ".browser-live.bak"',
  'open(backup, "w").write(src)',
  'lines.insert(idxloc, block)',
  "open(path, 'w').write('\\n'.join(lines))",
  "print('patched')",
].join('\n')

async function ensureNginx() {
  const sitesDir = '/etc/nginx/sites-enabled'
  let vhost
  try {
    for (const entry of fs.readdirSync(sitesDir).sort()) {
      const full = path.join(sitesDir, entry)
      let content = ''
      try {
        content = fs.readFileSync(full, 'utf8')
      } catch {
        continue
      }
      if (content.includes(`proxy_pass http://127.0.0.1:${DSH_WEB_PORT}`)) {
        vhost = full
        break
      }
    }
  } catch (error) {
    warn('cannot read', sitesDir, '-', error.message, '; skip reverse-proxy setup')
    return
  }
  if (!vhost) {
    warn('no nginx vhost proxying the DSH web UI (127.0.0.1:' + DSH_WEB_PORT + ') found; skip reverse-proxy setup')
    return
  }
  let outcome
  try {
    const { stdout } = await run('sudo', ['-n', 'python3', '-c', NGINX_PATCH_PY, vhost, PUBLIC_PATH, String(WEB_PORT)], { timeout: 15_000 })
    outcome = stdout.trim()
  } catch (error) {
    warn('nginx patch skipped (passwordless sudo unavailable?):', error.message)
    warn('run scripts/provision-host.sh manually to finish the reverse-proxy setup')
    return
  }
  if (outcome === 'present') {
    log('nginx vhost already proxies', PUBLIC_PATH)
    return
  }
  try {
    await run('sudo', ['-n', 'nginx', '-t'], { timeout: 15_000 })
    await run('sudo', ['-n', 'systemctl', 'reload', 'nginx'], { timeout: 15_000 })
    log('nginx: added', PUBLIC_PATH, 'location to', vhost, 'and reloaded')
  } catch (error) {
    warn('nginx -t failed after patch; restoring backup:', error.message)
    await run('sudo', ['-n', 'cp', vhost + '.browser-live.bak', vhost], { timeout: 10_000 }).catch(() => undefined)
  }
}

async function ensureHost() {
  let dockerAvailable = true
  try {
    await run('docker', ['version', '--format', '{{.Server.Version}}'], { timeout: 10_000 })
  } catch (error) {
    dockerAvailable = false
    warn('docker unavailable (' + error.message + '); container provisioning skipped')
  }
  if (dockerAvailable) {
    const running = await containerRunning()
    if (running && await cdpAlive()) {
      log('adopted existing container "' + CONTAINER + '" (CDP OK on 127.0.0.1:' + CDP_PORT + ')')
    } else {
      const envPath = await ensureEnvFile()
      await ensureImage()
      await startContainer(envPath)
    }
  }
  await ensureNginx()
}

/**
 * Kick off best-effort provisioning shortly after activation so harness boot
 * is never delayed; the timer is cancelled if the plugin unloads first.
 * @param {import('@deepseek-ai/cordis').Context} ctx - root plugin context.
 */
export function apply(ctx) {
  ctx.effect(() => {
    const timer = setTimeout(() => {
      void ensureHost().catch((error) => warn('provisioning failed:', error.message))
    }, 5_000)
    return () => clearTimeout(timer)
  }, 'browser-live: host provisioning')
}
