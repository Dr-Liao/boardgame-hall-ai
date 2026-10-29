import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createRelay } from '../../../relay/server.js'
import { createServer } from '../../../lib/server.js'
import { loadTestMods } from './mods.mjs'

export const listen = server => new Promise(resolve => {
  server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`))
})

export const stop = server => new Promise(resolve => {
  server.stopRelay?.()
  server.online?.close()
  server.closeAllConnections()
  server.close(resolve)
})

export async function waitFor(check, timeout = 8000, label = '状态同步') {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const value = await check()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`等待${label}超时`)
}

export function createOnlineClient(origin, { details = false } = {}) {
  const call = async (route, body) => {
    const response = await fetch(origin + '/api/online/' + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'x-boardgame-online': '1', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    })
    if (!details) return response.json()
    const text = await response.text()
    return { json: JSON.parse(text), bytes: Buffer.byteLength(text), res: response }
  }
  return {
    call,
    command: (action, body = {}) => call('command', {
      action,
      body: { operationId: randomUUID(), ...body },
    }),
  }
}

export async function createOnlineFixture(t, {
  count = 2,
  env = {},
  homePrefix = 'hall-online-',
  relayOptions = {},
  persistHost = false,
  details = false,
  mods = null,
} = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), homePrefix))
  const previousEnv = { DSH_HOME: process.env.DSH_HOME }
  process.env.DSH_HOME = home
  for (const [key, value] of Object.entries(env || {})) {
    previousEnv[key] = process.env[key]
    process.env[key] = value
  }

  const halls = []
  let relay = null
  t.after(async () => {
    await Promise.all(halls.map(hall => stop(hall.server)))
    if (relay) await stop(relay)
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    fs.rmSync(home, { recursive: true, force: true })
  })

  const loadedMods = mods || await loadTestMods()
  relay = createRelay(relayOptions)
  const relayUrl = await listen(relay)
  for (let index = 0; index < count; index++) {
    const server = createServer({ mods: loadedMods, persist: persistHost && index === 0 })
    await server.ready
    const origin = await listen(server)
    const client = createOnlineClient(origin, { details })
    halls.push({ server, origin, ...client, ...(details ? { request: client.call } : {}) })
  }

  return { halls, relay, relayUrl, mods: loadedMods }
}
