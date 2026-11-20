import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createServer } from '../../lib/server.js'
import { backupSnapshot, readSnapshot, snapshotPath } from '../../lib/sessions.js'
import { applyLocalActionDelta } from '../../public/online-delta.js'

const mod = {
  id: 'fixture-journal', name: 'Action journal fixture', players: [1, 1], seats: 1,
  localActionDeltas: true, requireReliableSaves: true,
  createState: () => ({ status: 'playing', currentSeat: 0, count: 0, cards: { a: { name: 'A' } }, secret: [] }),
  validateMove: () => null,
  applyMove(state) {
    state.secret.push(++state.count)
    return [{ type: 'info', text: `step ${state.count}`, tableState: { count: state.count } }]
  },
  viewState({ secret, ...view }) { return view },
}

test('local action deltas and durable journal survive restart, torn writes, and snapshot compaction', { timeout: 30_000 }, async () => {
  const previous = process.env.DSH_HOME
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hall-action-journal-'))
  process.env.DSH_HOME = home
  let server, base
  const start = async () => {
    server = createServer({ mods: [mod], persist: true })
    await server.ready
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    base = 'http://127.0.0.1:' + server.address().port
  }
  const close = () => new Promise(resolve => server.close(resolve))
  async function request(route, body) {
    const response = await fetch(base + '/api' + route, body === undefined ? undefined : {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    const data = await response.json()
    assert.equal(data.ok, true, data.error)
    return data
  }
  try {
    await start()
    let { session } = await request('/start', { modId: mod.id, settings: { teammates: 0 } })
    const sessionId = session.sessionId
    const file = snapshotPath(sessionId, mod.id)
    const onDisk = () => JSON.parse(fs.readFileSync(file, 'utf8'))
    const active = () => request('/session?sessionId=' + sessionId)
    const journal = () => file + '.actions-' + onDisk().journalId
    async function act({ stamp = session.localActionStamp, full = false } = {}) {
      const before = structuredClone(session)
      const result = await request('/move', { sessionId, revision: session.state.revision, move: { action: 'step' },
        client: { localBaseStamp: stamp } })
      if (full) {
        assert.equal(result.localActionDelta, undefined)
        session = result.session
      } else {
        const updated = applyLocalActionDelta(session, result.localActionDelta)
        assert.ok(updated)
        assert.deepEqual(session, before)
        assert.equal(applyLocalActionDelta(updated, result.localActionDelta), null)
        session = updated
      }
      assert.equal(session.state.secret, undefined)
    }
    await act()
    await act({ stamp: 'stale-view', full: true })
    assert.equal(onDisk().session.state.count, 0)
    assert.equal(readSnapshot(sessionId).journalCount, 2)
    assert.deepEqual(readSnapshot(sessionId).session.state.secret, [1, 2])
    const backup = JSON.parse(fs.readFileSync(backupSnapshot(sessionId), 'utf8'))
    assert.equal(backup.journalId, undefined)
    assert.equal(backup.session.state.count, 2)

    fs.appendFileSync(journal(), '{"baseRevision":2')
    await close()
    await start()
    assert.equal(readSnapshot(sessionId).journalIncomplete, true)
    session = (await active()).session
    assert.equal(session.state.count, 2)
    await act()
    assert.equal(onDisk().session.state.count, 3, 'torn log is replaced by a fresh snapshot')
    assert.equal(readSnapshot(sessionId).journalCount, 0)

    const oldJournal = journal()
    for (let i = 0; i < 32; i++) await act()
    assert.equal(readSnapshot(sessionId).session.state.count, 35)
    const full = (await active()).session
    assert.deepEqual(JSON.parse(JSON.stringify(session)), full)
    assert.ok(full.events.slice(0, -24).every(event => !event.tableState))
    for (let i = 0; fs.existsSync(oldJournal) && i < 100; i++) await delay(30)
    assert.equal(onDisk().session.state.count, 35)
    assert.equal(readSnapshot(sessionId).journalCount, 0)
    assert.equal(fs.existsSync(oldJournal), false)
    await act()
    const overwritten = journal()
    await request('/reset', { sessionId })
    assert.equal(readSnapshot(sessionId).session.state.count, 0)
    assert.equal(fs.existsSync(overwritten), false)
    await request('/session/delete', { sessionId, confirm: true })
    assert.equal(readSnapshot(sessionId), null)
    assert.ok(fs.readdirSync(path.dirname(file)).every(name => !name.includes('.actions-')))
  } finally {
    if (server?.listening) await close()
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    assert.equal(path.dirname(path.resolve(home)), path.resolve(os.tmpdir()))
    fs.rmSync(home, { recursive: true, force: true })
  }
})
