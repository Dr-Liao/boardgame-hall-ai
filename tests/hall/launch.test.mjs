import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { once } from 'node:events'
import { hallUrl, isHallRunning } from '../../lib/launch.js'

const root = fileURLToPath(new URL('../../', import.meta.url))
const exec = promisify(execFile)
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
const close = server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) })
function environment(t, port) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hall-launch-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  return { ...process.env, DSH_HOME: home, BOARDGAME_HOST: '127.0.0.1', BOARDGAME_PORT: String(port), BOARDGAME_NO_OPEN: '1', BOARDGAME_PERSIST: '0' }
}

test('launcher opens an existing hall before restoring any sessions', async t => {
  const server = http.createServer((req, res) => {
    res.end(req.url === '/api/catalog' ? JSON.stringify({ ok: true, games: [{ id: 'ox', name: '井字棋' }] }) : '<title>桌游大厅</title>')
  })
  const port = await listen(server)
  t.after(() => close(server))
  const env = environment(t, port)
  const { stdout, stderr } = await exec(process.execPath, ['server.js'], { cwd: root, env, timeout: 15000 })
  assert.match(stdout, /大厅已在运行/)
  assert.doesNotMatch(stdout + stderr, /\[mods\]|\[sessions\]|\[online\]|EADDRINUSE/)
  if (process.platform === 'win32') {
    const batch = await exec('cmd.exe', ['/d', '/c', 'start.bat'], { cwd: root, env, timeout: 15000 })
    assert.match(batch.stdout, /大厅已在运行/)
    assert.equal(batch.stderr, '')
  }
})

test('launcher reports a port conflict instead of opening an unrelated website', async t => {
  const server = http.createServer((req, res) => res.end('another app'))
  const port = await listen(server)
  t.after(() => close(server))
  assert.equal(await isHallRunning(hallUrl('127.0.0.1', port)), false)
  await assert.rejects(exec(process.execPath, ['server.js'], { cwd: root, env: environment(t, port), timeout: 15000 }), error => {
    assert.equal(error.code, 1)
    assert.match(error.stderr, /端口 .* 已被其他程序占用/)
    assert.doesNotMatch(error.stderr, /Unhandled|node:events/)
    return true
  })
})

test('a fresh hall starts and a second launch reuses it without stopping it', async t => {
  const reservation = http.createServer()
  const port = await listen(reservation)
  await close(reservation)
  const env = environment(t, port)
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  t.after(async () => { if (child.exitCode === null) { const done = once(child, 'exit'); child.kill(); await done } })
  const url = hallUrl('127.0.0.1', port)
  const deadline = Date.now() + 15000
  while (!await isHallRunning(url)) {
    assert.equal(child.exitCode, null, output)
    assert.ok(Date.now() < deadline, output)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  const repeated = await exec(process.execPath, ['server.js'], { cwd: root, env, timeout: 15000 })
  assert.match(output, /大厅已启动/)
  assert.match(repeated.stdout, /大厅已在运行/)
  assert.equal(await isHallRunning(url), true)
  assert.equal(child.exitCode, null)
})

test('wildcard listen addresses open a usable local browser address', () => {
  assert.equal(hallUrl('0.0.0.0', 8787), 'http://127.0.0.1:8787')
  assert.equal(hallUrl('::', 8787), 'http://[::1]:8787')
})
