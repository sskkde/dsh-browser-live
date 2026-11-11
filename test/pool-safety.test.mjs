/**
 * dsh-browser-live — pool safety tests (P1 gates).
 *
 * These exercise the real BrowserLiveService against an injected docker runner:
 * generation must distinguish a rebuilt instance, a lease must defer a release,
 * LRU must never take a leased/busy slot, a failed reclaim must keep the entry
 * and its slot, and reconciliation must report unknown containers without
 * touching them.
 *
 * Run with `node --test test/pool-safety.test.mjs`.
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { BrowserLiveCapacityError, BrowserLiveService } from '../lib/service.js'
import { registerLiveTools } from '../lib/tools.js'

function freshHome() {
  const home = mkdtempSync(join(tmpdir(), 'dshbl-pool-'))
  process.env.DSH_HOME = home
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'neko-browser-live.env'), [
    'NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD=x',
    'NEKO_MEMBER_MULTIUSER_USER_PASSWORD=y',
    'NEKO_SERVER_PATH_PREFIX=/browser',
    'NEKO_SERVER_PROXY=true',
    'NEKO_SERVER_BIND=127.0.0.1:8080',
    'CDP_PORT=9222',
    'CHROMIUM_PROXY=direct://',
    '',
  ].join('\n'), { mode: 0o600 })
  return home
}

function fakeDocker() {
  const containers = new Map()
  const calls = []
  const labelsOf = (args) => {
    const labels = {}
    for (let index = 0; index < args.length; index++) {
      if (args[index] === '--label') {
        const [key, value] = String(args[index + 1]).split('=')
        labels[key] = value
      }
    }
    return labels
  }
  const runner = async (command, args) => {
    calls.push([command, ...args])
    if (command !== 'docker') throw new Error(`unexpected command ${command}`)
    const action = args[0]
    if (action === 'inspect') {
      const name = args[args.length - 1]
      const container = containers.get(name)
      if (container === undefined) throw new Error(`Error: No such object: ${name}`)
      return { stdout: container.state === 'running' ? 'true\n' : 'false\n', stderr: '' }
    }
    if (action === 'run') {
      const name = args[args.indexOf('--name') + 1]
      containers.set(name, { state: 'running', labels: labelsOf(args) })
      return { stdout: `${name}-cid\n`, stderr: '' }
    }
    if (action === 'rm') {
      const name = args[1] === '-f' ? args[2] : args[1]
      if (!containers.has(name)) throw new Error(`Error: No such container: ${name}`)
      containers.delete(name)
      return { stdout: name + '\n', stderr: '' }
    }
    if (action === 'restart') {
      const container = containers.get(args[1])
      if (container === undefined) throw new Error('missing container')
      container.state = 'running'
      return { stdout: args[1] + '\n', stderr: '' }
    }
    if (action === 'ps') {
      if (args.includes('label=dsh.browser-live.managed=true')) {
        const lines = [...containers.entries()]
          .filter(([, container]) => container.labels['dsh.browser-live.managed'] === 'true')
          .map(([name, container]) => [name, container.state, container.labels['dsh.browser-live.session'] ?? '', container.labels['dsh.browser-live.generation'] ?? ''].join('\t'))
        return { stdout: lines.join('\n') + (lines.length > 0 ? '\n' : ''), stderr: '' }
      }
      return { stdout: [...containers.keys()].join('\n') + (containers.size > 0 ? '\n' : ''), stderr: '' }
    }
    if (action === 'build' || action === 'image') return { stdout: '', stderr: '' }
    throw new Error(`unexpected docker ${args.join(' ')}`)
  }
  return { runner, containers, calls }
}

const service = (runner, options = {}) => new BrowserLiveService(new Context(), {
  maxSessions: 2,
  runner,
  nginx: false,
  probe: async () => true,
  ...options,
})

async function settle(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  return predicate()
}

test('a pre-migration map is backed up and legacy entries are retired only', () => {
  const home = freshHome()
  writeFileSync(join(home, 'neko-browser-live.map.json'), JSON.stringify({
    version: 1,
    sessions: {
      legacy: { slot: 0, container: 'neko', volume: 'neko-profile', cdpPort: 9222, lastUsed: 1 },
      old: { slot: 1, short: 'old00001', container: 'neko-old00001', volume: 'neko-profile-old00001', cdpPort: 9301, lastUsed: 2 },
    },
  }))
  const docker = fakeDocker()
  const pool = service(docker.runner)
  assert.equal(existsSync(join(home, 'neko-browser-live.map.json.v1.bak')), true)
  assert.equal(pool.entryFor('legacy'), null)
  assert.equal(pool.status().retired.some((item) => item.container === 'neko'), true)
  assert.equal(pool.entryFor('old').container, 'neko-old00001')
})

test('re-allocating a released container advances its generation', async () => {
  freshHome()
  const docker = fakeDocker()
  const pool = service(docker.runner)
  const first = pool.allocate('session-a')
  assert.equal(first.generation, 1)
  const short = first.short
  pool.release('session-a')
  assert.equal(await settle(() => pool.entryFor('session-a') === null), true, 'an allocated-but-never-started slot releases without a container')
  const second = pool.allocate('session-a')
  assert.equal(second.short, short)
  assert.equal(second.generation, 2)
})

test('a lease defers an explicit release until the operation ends', async () => {
  freshHome()
  const docker = fakeDocker()
  const pool = service(docker.runner)
  pool.allocate('session-a')
  const release = pool.lease('session-a')
  pool.release('session-a')
  const entry = pool.entryFor('session-a')
  assert.equal(entry.state, 'active')
  assert.equal(entry.releaseRequested, true)
  assert.equal(docker.containers.size, 0)
  release()
  assert.equal(await settle(() => pool.entryFor('session-a') === null), true, 'the pending release ran after the lease ended')
})

test('a rebuild after the container stopped advances the generation', async () => {
  freshHome()
  const docker = fakeDocker()
  const pool = service(docker.runner)
  const first = await pool.ensure('session-a')
  assert.equal(first.generation, 1)
  assert.equal(pool.consumeRestart('session-a'), false)
  docker.containers.get(first.container).state = 'stopped'
  const second = await pool.ensure('session-a')
  assert.equal(second.generation, 2)
  assert.equal(pool.consumeRestart('session-a'), true)
})

test('LRU eviction never takes a leased slot and never reuses a slot before it is gone', async () => {
  freshHome()
  const docker = fakeDocker()
  const pool = service(docker.runner)
  await pool.ensure('session-a')
  pool.allocate('session-b')
  const held = pool.lease('session-a')
  assert.throws(() => pool.allocate('session-c'), BrowserLiveCapacityError)
  assert.equal(pool.entryFor('session-a').state, 'active', 'the leased session is not the victim')
  assert.equal(pool.entryFor('session-b').state, 'deleting', 'the idle session is reclaimed instead')
  assert.throws(() => pool.allocate('session-c'), BrowserLiveCapacityError, 'slot is not reused before the container is gone')
  assert.equal(await settle(() => pool.entryFor('session-b') === null), true)
  held()
  const allocated = pool.allocate('session-c')
  assert.notEqual(allocated.slot, pool.entryFor('session-a').slot)
})

test('a failed reclaim keeps the entry, the slot and the error for retry', async () => {
  freshHome()
  const docker = fakeDocker()
  const pool = service(async (command, args) => {
    if (args[0] === 'rm') throw new Error('docker daemon unavailable')
    return docker.runner(command, args)
  })
  pool.allocate('session-b')
  pool.release('session-b')
  assert.equal(await settle(() => pool.entryFor('session-b')?.lastError !== undefined), true)
  const kept = pool.entryFor('session-b')
  assert.equal(kept.state, 'deleting')
  assert.match(kept.lastError, /docker daemon unavailable/)
  assert.equal(Number.isFinite(kept.retryAt), true)
  assert.equal(pool.status().sessions.some((item) => item.state === 'deleting'), true)
})

test('reconciliation reports unknown managed containers and never deletes them', async () => {
  freshHome()
  const docker = fakeDocker()
  const pool = service(docker.runner)
  const entry = pool.allocate('session-a')
  docker.containers.set(entry.container, { state: 'running', labels: { 'dsh.browser-live.managed': 'true', 'dsh.browser-live.session': entry.short, 'dsh.browser-live.generation': '1' } })
  docker.containers.set('neko-orphan999', { state: 'running', labels: { 'dsh.browser-live.managed': 'true', 'dsh.browser-live.session': 'orphan999', 'dsh.browser-live.generation': '3' } })
  const report = await pool.reconcile()
  assert.equal(report.unknown.some((item) => item.container === 'neko-orphan999'), true)
  assert.equal(report.missing.length, 0)
  assert.equal(docker.containers.has('neko-orphan999'), true, 'unknown containers are left untouched')
  assert.match(readFileSync(join(process.env.DSH_HOME, 'neko-browser-live.map.json'), 'utf8'), /containerGenerations/)
})


test('release collects the session output once before the container goes away', async () => {
  freshHome()
  const docker = fakeDocker()
  const pool = service(docker.runner)
  const collected = []
  pool.beforeRelease = async (sessionId) => { collected.push(sessionId) }
  pool.allocate('session-a')
  pool.release('session-a')
  assert.equal(await settle(() => pool.entryFor('session-a') === null), true)
  assert.deepEqual(collected, ['session-a'])
})

test('status never allocates a slot, starts a browser or refreshes lastUsed', async () => {
  freshHome()
  const docker = fakeDocker()
  const pool = service(docker.runner)
  const tools = []
  const ctx = new Context()
  ctx.get = () => undefined
  ctx.tools = { register(tool) { tools.push(tool) } }
  registerLiveTools(ctx, pool, {})
  const statusTool = tools.find((tool) => tool.name === 'browser_live_status')
  const exec = { agent: { session: { id: 'session-a', header: { cwd: process.env.DSH_HOME } } } }
  const before = await statusTool.execute({}, exec)
  assert.equal(before.ready, false)
  assert.equal(pool.entryFor('session-a'), null, 'status did not allocate')
  const entry = pool.allocate('session-a')
  const lastUsed = entry.lastUsed
  await new Promise((resolve) => setTimeout(resolve, 10))
  const after = await statusTool.execute({}, exec)
  assert.equal(after.ready, false, 'an absent container is reported as not ready, not started')
  assert.equal(pool.entryFor('session-a').lastUsed, lastUsed, 'status did not refresh the idle timer')
  assert.deepEqual(after.tabs, [])
})

test('a Docker inspection failure is not treated as an absent container', async () => {
  freshHome()
  const docker = fakeDocker()
  const first = service(docker.runner)
  const entry = first.allocate('session-a')
  const broken = service(async (command, args) => {
    if (args[0] === 'inspect') throw new Error('permission denied while connecting to the Docker daemon')
    return docker.runner(command, args)
  })
  await broken.adoptExisting()
  const kept = broken.entryFor('session-a')
  assert.notEqual(kept, null, 'the entry is kept for a later retry')
  assert.match(kept.lastError, /could not be determined/)
  assert.equal(kept.state, 'active')
  await assert.rejects(() => broken.ensure('session-a'), /cannot determine whether/)
  assert.equal(kept.container, entry.container)
})

test('a failed reclaim keeps its slot out of a capacity-1 pool', async () => {
  freshHome()
  const docker = fakeDocker()
  const pool = new BrowserLiveService(new Context(), {
    maxSessions: 1,
    runner: async (command, args) => {
      if (args[0] === 'rm') throw new Error('docker daemon unavailable')
      return docker.runner(command, args)
    },
    nginx: false,
    probe: async () => true,
  })
  pool.allocate('session-a')
  pool.release('session-a')
  assert.equal(await settle(() => pool.entryFor('session-a')?.lastError !== undefined), true)
  assert.throws(() => pool.allocate('session-b'), BrowserLiveCapacityError)
  assert.equal(pool.entryFor('session-b'), null)
})

test('collection runs before the container is removed', async () => {
  freshHome()
  const docker = fakeDocker()
  const order = []
  const runner = async (command, args) => {
    if (args[0] === 'rm') order.push('docker-rm')
    return docker.runner(command, args)
  }
  const pool = service(runner)
  pool.beforeRelease = async () => { order.push('collect') }
  await pool.ensure('session-a')
  const entry = pool.entryFor('session-a')
  assert.equal(docker.containers.has(entry.container), true)
  pool.release('session-a')
  assert.equal(await settle(() => pool.entryFor('session-a') === null), true)
  assert.deepEqual(order.slice(0, 2), ['collect', 'docker-rm'])
})

test('a stopped container that cannot be removed is kept instead of started over', async () => {
  const home = freshHome()
  const docker = fakeDocker()
  let failRm = false
  const runner = async (command, args) => {
    if (failRm && args[0] === 'rm') throw new Error('device or resource busy')
    return docker.runner(command, args)
  }
  const svc = service(runner)
  const created = await svc.ensure('s1')
  docker.containers.get(created.container).state = 'stopped'
  failRm = true
  await assert.rejects(() => svc.ensure('s1'), /cannot remove stopped container/)
  const map = JSON.parse(readFileSync(join(home, 'neko-browser-live.map.json'), 'utf8'))
  assert.equal(map.sessions.s1.container, created.container)
  assert.match(map.sessions.s1.lastError, /cannot remove stopped container/)
})
