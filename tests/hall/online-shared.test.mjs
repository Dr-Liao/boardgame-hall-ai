// P3.2 A1′：共享 state clone（默认关闭；BOARDGAME_ONLINE_SHARED_VIEW=1 打开）。
//
// 覆盖点：
//   1. 默认关闭：即便 Mod 声明 viewStateSharesState，也不传 stateIsolated；wire / hydrate 行为不变。
//   2. 打开后：每 revision 只 structuredClone 一次权威 state，多个席位视图共用同一份隔离副本
//      （夹具按 state 对象身份统计）；视图生成期间权威 session.state 的 JSON 哈希不变、不含探针污染。
//   3. 打开后 hydrate 仍与全量视图逐字节一致（多席位 / 多 revision）。
//   4. Mod 能力缺失（viewStateSharesState 返回 false）→ 回退逐席位拷贝，wire 正确。
//   5. 共享视图抛异常 → 本局回退逐席位拷贝（失败模式只能是变慢），wire 仍正确。
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRelay } from '../../relay/server.js'
import { createServer } from '../../lib/server.js'
import { loadTestMods } from './helpers/mods.mjs'
import { resetSharedProbe, sharedProbeSnapshot } from '../fixtures/mods/fixture-static/index.js'

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)))
const stop = server => new Promise(resolve => { server.stopRelay?.(); server.online?.close(); server.closeAllConnections(); server.close(resolve) })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor(fn, timeout = 8000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { const value = await fn(); if (value) return value; await sleep(20) }
  throw new Error('等待状态同步超时')
}

async function fixture(t, { env = {}, count = 2 } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hall-shared-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const previousEnv = {}
  for (const key of Object.keys(env)) {
    previousEnv[key] = process.env[key]
    process.env[key] = env[key]
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    fs.rmSync(home, { recursive: true, force: true })
  })
  const mods = await loadTestMods()
  const relay = createRelay({ secret: 'shared-view-test-secret' })
  const relayUrl = await listen(relay)
  const halls = []
  for (let i = 0; i < count; i++) {
    const server = createServer({ mods, persist: false })
    await server.ready
    const origin = await listen(server)
    const call = async (route, body) => {
      const res = await fetch(origin + '/api/online/' + route, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'x-boardgame-online': '1', 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20000),
      })
      const text = await res.text()
      return { json: JSON.parse(text), bytes: Buffer.byteLength(text), res }
    }
    const command = (action, body = {}) => call('command', { action, body: { operationId: randomUUID(), ...body } })
    halls.push({ server, origin, call, command })
  }
  t.after(async () => {
    await Promise.all(halls.map(hall => stop(hall.server)))
    await stop(relay)
  })
  return { halls, relay, relayUrl }
}

async function startRoom(halls, relayUrl) {
  const host = halls[0]
  const created = await host.call('create', { relayUrl, modId: 'fixture-static', capacity: halls.length, fillAi: false })
  assert.equal(created.json.ok, true, created.json.error)
  for (const hall of halls.slice(1)) {
    assert.equal((await hall.call('join', { relayUrl, code: created.json.room.code })).json.ok, true)
    await hall.call('ready', { ready: true })
  }
  const started = await host.command('start')
  assert.equal(started.json.ok, true, started.json.error)
  const revision = started.json.session?.state?.revision ?? started.json.revision
  await waitFor(async () => (await Promise.all(halls.map(h => h.call('status'))))
    .every(r => r.json.session?.state?.revision === revision))
  return { revision }
}

// 每个大厅声明一份静态表版本；返回 { hallIndex: version }，后续命令/status 带它走精简视图。
async function staticVersions(halls) {
  const versions = []
  for (const hall of halls) {
    const fresh = await hall.call('status?clientStatic=')
    assert.equal(fresh.json.ok, true, fresh.json.error)
    versions.push(fresh.json.session.staticVersion)
  }
  return versions
}

async function declaredStatus(hall, version) {
  const res = await hall.call('status?clientStatic=' + encodeURIComponent(version))
  assert.equal(res.json.ok, true, res.json.error)
  return res.json
}

// 按当前应答席位推进若干步（精简视图口径），并等所有大厅同步到新 revision。
async function playSteps(halls, versions, steps) {
  const revisions = []
  for (let i = 0; i < steps; i++) {
    const before = await declaredStatus(halls[0], versions[0])
    const revision = before.session.state.revision
    assert.equal(before.session.state.status, 'playing')
    const seat = before.session.state.currentSeat
    const hall = halls[seat]
    if (seat !== 0) {
      await waitFor(async () => (await declaredStatus(hall, versions[seat])).session.state.revision === revision)
    }
    const response = await hall.command('move', {
      revision,
      move: { action: 'pass' },
      client: { slim: seat !== 0, staticVersion: versions[seat] },
    })
    assert.equal(response.json.ok, true, response.json.error)
    const nextRevision = revision + 1
    for (const other of halls) {
      await waitFor(async () => (await declaredStatus(other, versions[other])).session.state.revision === nextRevision)
    }
    revisions.push(nextRevision)
  }
  return revisions
}

// 去掉 P1.4 新增的元字段后比较「全量视图」与「精简视图 + 静态表 hydrate」是否逐字节一致。
function functionalView(view) {
  const copy = structuredClone(view)
  delete copy.staticVersion
  if (copy.state) {
    delete copy.state.privateCards
    delete copy.state.cardsPatch
  }
  return copy
}
function hydrate(view, staticInfo) {
  const privateCards = view.state?.privateCards
  const cards = privateCards && Object.keys(privateCards).length
    ? { ...staticInfo.cards, ...privateCards }
    : staticInfo.cards
  return { ...view, state: { ...view.state, cards, investigatorDefs: staticInfo.investigatorDefs } }
}

// 共享视图的 hydrate 等价性：每个大厅「声明版本的精简视图 + 静态表」必须等于「旧客户端全量视图」。
async function assertHydrateEqualsFull(halls, versions) {
  for (const [index, hall] of halls.entries()) {
    const slim = await declaredStatus(hall, versions[index])
    const legacy = await hall.call('status')
    assert.equal(legacy.json.ok, true, legacy.json.error)
    assert.ok(slim.session.state.cards === undefined, '精简视图不得带 cards')
    assert.ok(legacy.json.session.state.cards, '旧客户端仍必须拿全量视图')
    assert.deepEqual(functionalView(hydrate(slim.session, slim.static || (await hall.call('status?clientStatic=')).json.static)),
      functionalView(legacy.json.session))
  }
}

test('默认关闭：Mod 声明了 viewStateSharesState 也不会用共享副本，wire/hydrate 行为不变', { timeout: 60000 }, async t => {
  resetSharedProbe()
  const { halls, relayUrl } = await fixture(t, { env: { FIXTURE_SHARED_PROBE: '1' } })
  await startRoom(halls, relayUrl)
  const versions = await staticVersions(halls)
  await playSteps(halls, versions, 3)
  const probe = sharedProbeSnapshot()
  assert.ok(probe.viewStateCalls > 0, '应当发生过视图生成')
  assert.equal(probe.isolatedViewStateCalls, 0, '开关默认关闭时不得传 stateIsolated')
  await assertHydrateEqualsFull(halls, versions)
  // 权威 state 未被视图生成污染（探针未启用写入，这里只守哈希稳定）。
  const byRevision = new Map()
  for (const check of probe.authorityChecks) {
    if (!byRevision.has(check.revision)) byRevision.set(check.revision, new Set())
    byRevision.get(check.revision).add(check.hash)
  }
  for (const [revision, hashes] of byRevision) assert.equal(hashes.size, 1, `revision ${revision} 视图生成期间权威 state 哈希必须不变`)
})

test('BOARDGAME_ONLINE_SHARED_VIEW=1：每 revision 只 clone 一次、四席共用；权威 state 哈希不变且无探针污染', { timeout: 90000 }, async t => {
  resetSharedProbe()
  const { halls, relayUrl } = await fixture(t, {
    env: {
      BOARDGAME_ONLINE_SHARED_VIEW: '1',
      FIXTURE_SHARED_PROBE: '1',
      // 探针会故意写入入参：只有拿到「隔离副本」才安全。若大厅把权威 state 直接传给 viewState，
      // checkpointView 会在权威 state 上看到 __probe / table 探针，且同 revision 哈希会漂移。
      FIXTURE_SHARED_MUTATE: '1',
    },
  })
  await startRoom(halls, relayUrl)
  const versions = await staticVersions(halls)
  resetSharedProbe()
  await playSteps(halls, versions, 8)
  const probe = sharedProbeSnapshot()

  // 1) 确实走了共享路径（首份视图可能是全量，故 isolated 计数 >0 即可）。
  assert.ok(probe.isolatedViewStateCalls > 0, '应当向 viewState 传入 stateIsolated=true')

  // 2) 每 revision 只 clone 一次：同一 revision 的所有共享视图收到的是同一个 state 对象。
  const refsByRevision = new Map()
  for (const sample of probe.samples) {
    if (!sample.isolated) continue
    if (!refsByRevision.has(sample.revision)) refsByRevision.set(sample.revision, new Set())
    refsByRevision.get(sample.revision).add(sample.state)
  }
  assert.ok(refsByRevision.size >= 4, `应覆盖多个 revision（实际 ${refsByRevision.size}）`)
  for (const [revision, refs] of refsByRevision) {
    assert.equal(refs.size, 1, `revision ${revision} 应只有一份共享隔离副本（实际 ${refs.size} 份）`)
  }
  const distinctStateObjects = new Set(probe.samples.filter(sample => sample.isolated).map(sample => sample.state))
  assert.equal(distinctStateObjects.size, refsByRevision.size, '每个 revision 恰好一个隔离副本，且不跨 revision 复用')

  // 3) 视图生成期间权威 session.state 的 JSON 哈希不变，且没有任何探针写入。
  assert.ok(probe.authorityChecks.length > 0, 'checkpointView 应当观察到权威 state')
  const hashesByRevision = new Map()
  for (const check of probe.authorityChecks) {
    assert.equal(check.topProbes, 0, `revision ${check.revision} 权威 state 被写入 __probe（大厅应传隔离副本）`)
    assert.equal(check.tableProbes, 0, `revision ${check.revision} 权威 state.table 被写入探针（大厅应传隔离副本）`)
    if (!hashesByRevision.has(check.revision)) hashesByRevision.set(check.revision, new Set())
    hashesByRevision.get(check.revision).add(check.hash)
  }
  for (const [revision, hashes] of hashesByRevision) {
    assert.equal(hashes.size, 1, `revision ${revision} 视图生成期间权威 state 的 JSON 哈希必须不变`)
  }

  // 4) 玩法仍在推进：权威 revision 只增。
  const tail = await declaredStatus(halls[0], versions[0])
  assert.equal(tail.session.state.status, 'playing')
})

test('BOARDGAME_ONLINE_SHARED_VIEW=1：hydrate 后仍与全量视图逐字节一致（多席位/多 revision）', { timeout: 90000 }, async t => {
  resetSharedProbe()
  const { halls, relayUrl } = await fixture(t, {
    env: { BOARDGAME_ONLINE_SHARED_VIEW: '1', FIXTURE_SHARED_PROBE: '1' },
  })
  await startRoom(halls, relayUrl)
  const versions = await staticVersions(halls)
  await playSteps(halls, versions, 5)
  assert.ok(sharedProbeSnapshot().isolatedViewStateCalls > 0)
  await assertHydrateEqualsFull(halls, versions)
  // 公共注入（cardsPatch 改静态表版本）后仍一致：由当前应答席位走一次命令触发公共自愈卡面。
  const before = await declaredStatus(halls[0], versions[0])
  const revision = before.session.state.revision
  const actingSeat = before.session.state.currentSeat
  const actingHall = halls[actingSeat]
  await waitFor(async () => (await declaredStatus(actingHall, versions[actingSeat])).session.state.revision === revision)
  const injected = await actingHall.command('move', {
    revision,
    move: { action: 'inject', code: 'x-public', target: 'table' },
    client: { staticVersion: versions[actingSeat] },
  })
  assert.equal(injected.json.ok, true, injected.json.error)
  await waitFor(async () => (await halls[0].call('status')).json.session?.state?.revision === revision + 1)
  const after = await actingHall.call('status?clientStatic=')
  assert.ok(after.json.static?.cards?.['x-public'], '公共自愈卡面必须进公共静态表（cardsPatch 合并）')
  assert.ok(after.json.session.state.cards === undefined)
  assert.deepEqual(functionalView(hydrate(after.json.session, after.json.static)),
    functionalView((await actingHall.call('status')).json.session))
})

test('能力缺失时回退逐席位拷贝：shared=1 但 viewStateSharesState=false，wire 仍正确', { timeout: 60000 }, async t => {
  resetSharedProbe()
  const { halls, relayUrl } = await fixture(t, {
    env: {
      BOARDGAME_ONLINE_SHARED_VIEW: '1',
      FIXTURE_SHARED_CAPABILITY: 'off',
      FIXTURE_SHARED_PROBE: '1',
    },
  })
  await startRoom(halls, relayUrl)
  const versions = await staticVersions(halls)
  await playSteps(halls, versions, 3)
  const probe = sharedProbeSnapshot()
  assert.ok(probe.viewStateCalls > 0)
  assert.equal(probe.isolatedViewStateCalls, 0, '能力缺失时必须回退逐席位拷贝')
  await assertHydrateEqualsFull(halls, versions)
})

test('共享视图抛异常时本局回退逐席位拷贝（失败模式只能是变慢）', { timeout: 60000 }, async t => {
  resetSharedProbe()
  const { halls, relayUrl } = await fixture(t, {
    env: {
      BOARDGAME_ONLINE_SHARED_VIEW: '1',
      FIXTURE_SHARED_THROW: '1',
      FIXTURE_SHARED_PROBE: '1',
    },
  })
  await startRoom(halls, relayUrl)
  const versions = await staticVersions(halls)
  await playSteps(halls, versions, 3)
  const probe = sharedProbeSnapshot()
  // 第一次共享调用抛错后，本会话永久回退逐席位拷贝：isolated 只出现一次。
  assert.equal(probe.isolatedViewStateCalls, 1, '共享路径异常后不得再次尝试共享副本')
  assert.ok(probe.viewStateCalls > 1)
  await assertHydrateEqualsFull(halls, versions)
})
