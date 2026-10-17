import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

const root = path.resolve(process.argv[2])
const dataDir = path.join(root, 'user-data')
assert.ok(!fs.existsSync(dataDir), 'Verify only a fresh release with no user-data directory')
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AI_|BOARDGAME_|DSH_HOME$|NODE_OPTIONS$|NODE_PATH$)/i.test(key)))
Object.assign(env, { BOARDGAME_NO_OPEN: '1', DSH_HOME: path.join(root, 'must-not-be-used') })
let child, base, output = ''
async function start() {
  output = ''
  child = spawn(path.join(root, '桌游大厅.exe'), [], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  child.stdout.on('data', chunk => { output += chunk.toString() })
  child.stderr.on('data', chunk => { output += chunk.toString() })
  let error
  child.on('error', value => { error = value })
  for (let i = 0; i < 150; i++) {
    if (error) throw error
    if (child.exitCode !== null) throw new Error(output)
    const match = output.match(/http:\/\/127\.0\.0\.1:\d+/)
    if (match) { base = match[0]; return }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('Startup timed out: ' + output)
}
function stop() {
  if (child?.pid && child.exitCode === null) {
    const result = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
    assert.equal(result.status, 0, result.stderr?.toString())
  }
}
async function api(endpoint, body) {
  const response = await fetch(base + endpoint, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {})
  assert.equal(response.status, 200, endpoint)
  const result = await response.json()
  assert.notEqual(result.ok, false, JSON.stringify(result))
  return result
}
try {
  await start()
  const initial = await api('/api/sessions')
  assert.deepEqual(initial.sessions, [])
  assert.equal(initial.dir, path.join(dataDir, 'boardgame-hall', 'sessions'))
  const catalog = await api('/api/catalog')
  const serialized = JSON.stringify(catalog)
  for (const id of ['arkhamhorror', 'gobang', 'ox']) assert.ok(serialized.includes(id), id)
  const config = await api('/api/config')
  assert.ok(!JSON.stringify(config).includes('"hasKey":true'))
  assert.equal((await fetch(base + '/')).status, 200)
  await api('/api/mods/arkhamhorror/catalog/meta')
  await api('/api/mods/arkhamhorror/catalog?limit=2')
  const web = path.join(root, 'app/games/arkhamhorror/web')
  for (const [folder, extension] of [['img', '.jpg'], ['audio', '.mp3']]) {
    const resources = fs.readdirSync(path.join(web, folder), { recursive: true }).filter(name => name.endsWith(extension))
    assert.ok(resources.length > 0)
    const resource = (folder + '/' + resources[0]).replaceAll('\\', '/')
    const response = await fetch(base + '/mods/arkhamhorror/' + resource)
    assert.equal(response.status, 200, resource)
    assert.equal((await response.arrayBuffer()).byteLength, fs.statSync(path.join(web, resource)).size)
  }
  const started = await api('/api/start', { modId: 'gobang', settings: { firstMove: 'player', opponents: ['__random__'] } })
  const sessionId = started.session.sessionId
  const moved = await api('/api/move', { sessionId, move: { x: 7, y: 7 } })
  assert.ok(moved.session.state.revision >= 1)
  stop()
  await start()
  assert.ok((await api('/api/sessions')).sessions.some(session => session.sessionId === sessionId))
  const restored = await api('/api/session?sessionId=' + encodeURIComponent(sessionId))
  assert.equal(restored.session.state.revision, moved.session.state.revision)
  console.log('PASS: EXE startup; all 3 games; empty initial saves; isolated data; no personal model key; catalog; image/audio; play; save and restart restore.')
} finally {
  stop()
  // Keep verification data outside the deliverable; never touch existing user data.
  if (fs.existsSync(dataDir)) {
    const destination = path.resolve('artifacts', 'release-verification-' + Date.now())
    fs.renameSync(dataDir, destination)
    console.log('Verification data moved out of release: ' + destination)
  }
}
