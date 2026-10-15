/**
 * dsh-browser-live — per-activation CDP proxy.
 *
 * The Playwright MCP server must spawn when the agent is created (that is when
 * its tools become visible in the agent's schema), but a session's slot — and
 * therefore its Neko CDP port — is only assigned on the first browser use, and
 * it can move when the pool re-allocates after an eviction.
 *
 * This proxy owns one stable loopback port per activation and resolves the
 * session's *current* CDP port per connection, which buys two things:
 *
 *  1. allocation stays lazy — an agent that never browses costs no slot, so
 *     creating a Session or a subagent can no longer evict a live session;
 *  2. a slot change can never point an MCP process at another session's
 *     container (the failure mode of a pinned `--cdp-endpoint`).
 *
 * The MCP client dials CDP lazily (a dead endpoint leaves the process alive),
 * and every browser tool call is preceded by `browserLive.ensure()`, so the
 * slot is assigned before the first byte is proxied.
 */

import net from 'node:net'

/**
 * Bind a loopback proxy in front of the session's current CDP port.
 * @param {() => number | null} resolvePort - current CDP port, or null while
 *   the session holds no slot.
 * @param {{ onError?: (error: Error) => void }} [options]
 * @returns {Promise<{ endpoint: string, port: number, close: () => Promise<void> }>}
 */
export async function createCdpProxy(resolvePort, options = {}) {
  const report = options.onError ?? (() => {})
  const sockets = new Set()

  const server = net.createServer((client) => {
    const port = resolvePort()
    if (typeof port !== 'number' || !Number.isFinite(port)) {
      // No slot yet: refuse the connection instead of hanging. The MCP client
      // reports the failure on the tool call that triggered it.
      report(new Error('CDP proxy: session has no slot allocated yet'))
      client.destroy()
      return
    }
    const upstream = net.connect({ host: '127.0.0.1', port })
    let closed = false
    const drop = (error) => {
      if (closed) return
      closed = true
      if (error !== undefined && error !== null) report(error)
      client.destroy()
      upstream.destroy()
    }
    client.on('error', drop)
    upstream.on('error', drop)
    client.on('close', () => drop(undefined))
    upstream.on('close', () => drop(undefined))
    client.pipe(upstream)
    upstream.pipe(client)
  })

  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  server.on('error', (error) => report(error))

  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error)
    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', onError)
      resolve()
    })
  })

  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    port,
    endpoint: `http://127.0.0.1:${port}`,
    /**
     * Stop accepting and drop live connections. Destroying the sockets first
     * keeps `close()` from waiting on a client that holds a keep-alive CDP
     * connection, which would stall the owning agent's disposal.
     */
    close: () => new Promise((resolve) => {
      for (const socket of [...sockets]) socket.destroy()
      sockets.clear()
      server.close(() => resolve())
    }),
  }
}
