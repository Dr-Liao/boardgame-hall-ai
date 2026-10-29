// P1.4：静态表只发一次（大厅通用机制，使用 tests/fixtures/mods/fixture-static 测试 Mod）。
//
// 覆盖点：
//   1. 旧客户端（不带 clientStatic / body.client.staticVersion）行为完全不变：仍拿完整视图；
//   2. 新客户端首份响应带 static 信封（version + 两张表），后续命中版本只带 staticVersion，
//      响应字节比全量下降 > 50%；
//   3. cardsPatch（公共自愈卡面）合并进会话静态表、版本变化后重发一次全量；
//   4. privateCards 只发给对应观察者，公共静态表 / 其他席位视图不含私有卡面；
//   5. guest 大厅缓存静态表：浏览器刷新（新客户端无缓存）由本地大厅补发，不必向房主要全量；
//   6. BOARDGAME_ONLINE_STATIC=0 一键回滚到全量视图；
//   7. 精简视图 + 静态表 hydrate 后与全量视图逐字节一致（json deepEqual）。

import test from 'node:test'
import assert from 'node:assert/strict'
import { createOnlineFixture, waitFor } from './helpers/online.mjs'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function fixture(t, { count = 2, env = null } = {}) {
  return createOnlineFixture(t, {
    count,
    env,
    homePrefix: 'hall-static-',
    relayOptions: { secret: 'static-test-secret' },
    persistHost: true,
    details: true,
  })
}

async function startRoom(halls, relayUrl) {
  const [host, guest] = halls
  const created = await host.call('create', { relayUrl, modId: 'fixture-static', capacity: halls.length, fillAi: false })
  assert.equal(created.json.ok, true, created.json.error)
  for (const hall of halls.slice(1)) {
    assert.equal((await hall.call('join', { relayUrl, code: created.json.room.code })).json.ok, true)
    await hall.call('ready', { ready: true })
  }
  const started = await host.command('start')
  assert.equal(started.json.ok, true, started.json.error)
  const revision = started.json.session.state.revision
  // 所有大厅都拿到同一 revision 的本地视图（guest 通过中转快照收到）。
  await waitFor(async () => (await Promise.all(halls.map(h => h.call('status'))))
    .every(r => r.json.session?.state?.revision === revision))
  return { revision }
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

test('旧客户端拿全量；新客户端首份带 static 信封，命中版本后省略且字节下降 >50%', async t => {
  const { halls, relayUrl } = await fixture(t)
  const [host] = halls
  await startRoom(halls, relayUrl)

  // 1) 旧客户端（完全不带声明）：行为不变，仍是完整视图，没有 staticVersion/static。
  const legacy = await host.call('status')
  assert.equal(legacy.json.ok, true)
  assert.ok(legacy.json.session.state.cards, '旧客户端必须继续拿到 cards')
  assert.ok(legacy.json.session.state.investigatorDefs, '旧客户端必须继续拿到 investigatorDefs')
  assert.equal(legacy.json.session.staticVersion, undefined)
  assert.equal(legacy.json.static, undefined)

  // 2) 新客户端首份（已声明协议但本地无缓存）：精简视图 + static 信封。
  const fresh = await host.call('status?clientStatic=')
  assert.equal(fresh.json.ok, true)
  assert.equal(fresh.json.session.state.cards, undefined, '首次响应不应再带 cards')
  assert.equal(fresh.json.session.state.investigatorDefs, undefined, '首次响应不应再带 investigatorDefs')
  assert.equal(typeof fresh.json.session.staticVersion, 'string')
  assert.ok(fresh.json.static?.cards, '首次响应必须带 static 信封')
  assert.equal(fresh.json.static.version, fresh.json.session.staticVersion)

  // 3) 命中缓存版本：不再带 static 信封，响应字节相对全量下降 >50%。
  const version = fresh.json.session.staticVersion
  const hit = await host.call('status?clientStatic=' + encodeURIComponent(version))
  assert.equal(hit.json.static, undefined, '版本命中时不应重发静态表')
  assert.equal(hit.json.session.staticVersion, version)
  assert.ok(hit.bytes * 2 < legacy.bytes, `命中后的响应应小于全量的一半（${hit.bytes} vs ${legacy.bytes}）`)

  // 4) hydrate 后与旧客户端全量视图逐字节一致。
  assert.deepEqual(functionalView(hydrate(fresh.json.session, fresh.json.static)),
    functionalView(legacy.json.session))

  // 5) 房主命令响应同样按 body.client.staticVersion 省略/补发（save 不改 revision，便于同状态对比）。
  const fullCommand = await host.command('save')
  assert.equal(fullCommand.json.ok, true, fullCommand.json.error)
  assert.ok(fullCommand.json.session.state.cards, '未声明时房主命令响应仍是完整视图')
  const slimCommand = await host.command('save', { client: { staticVersion: version } })
  assert.equal(slimCommand.json.ok, true, slimCommand.json.error)
  assert.equal(slimCommand.json.session.state.cards, undefined, '已声明版本时命令响应省略静态表')
  assert.equal(slimCommand.json.static, undefined)
  assert.deepEqual(functionalView(hydrate(slimCommand.json.session, fresh.json.static)),
    functionalView(fullCommand.json.session))
})

test('公共 cardsPatch 合并进会话静态表并 bump 版本；私有自愈卡只进本人 privateCards', async t => {
  const { halls, relayUrl } = await fixture(t)
  const [host, guest] = halls
  await startRoom(halls, relayUrl)
  const first = await host.call('status?clientStatic=')
  const firstVersion = first.json.session.staticVersion
  let revision = first.json.session.state.revision

  // 房主 inject 一张落在公共桌面的运行时卡面：触发 cardsPatch → 会话静态表版本变化。
  const injected = await host.command('move', {
    revision, move: { action: 'inject', code: 'x-public', target: 'table' }, client: { staticVersion: firstVersion },
  })
  assert.equal(injected.json.ok, true, injected.json.error)
  assert.equal(injected.json.session.state.cards, undefined)
  assert.ok(injected.json.static, 'cardsPatch 改变版本后，本次响应必须补发新静态表')
  assert.notEqual(injected.json.static.version, firstVersion, '合并公共自愈卡面后静态表版本必须变化')
  assert.ok(injected.json.static.cards['x-public'], '公共自愈卡面应进入公共静态表')
  const currentVersion = injected.json.static.version
  revision = injected.json.session.state.revision

  // 响应里的精简视图 + 新静态表 hydrate 后与全量视图一致（公共卡面在 cards 里可见）。
  const hostFull = await host.call('status')
  assert.ok(hostFull.json.session.state.cards['x-public'])
  assert.deepEqual(functionalView(hydrate(injected.json.session, injected.json.static)),
    functionalView(hostFull.json.session))

  // 客人 inject 一张只进本人手牌的运行时卡面：只出现在客人的 privateCards，不进公共静态表。
  await waitFor(async () => (await guest.call('status')).json.session?.state?.revision === revision)
  const guestBefore = await guest.call('status?clientStatic=')
  const guestVersion = guestBefore.json.session.staticVersion
  assert.equal(guestVersion, currentVersion, '私有自愈不应改变公共静态表版本')
  const privateInjected = await guest.command('move', {
    revision, move: { action: 'inject', code: 'x-private', target: 'hand' }, client: { slim: true },
  })
  assert.equal(privateInjected.json.ok, true, privateInjected.json.error)
  const guestSlim = await waitFor(async () => {
    const value = (await guest.call('status?clientStatic=' + encodeURIComponent(guestVersion))).json.session
    return value?.state?.privateCards?.['x-private'] ? value : null
  })
  assert.ok(guestSlim.state.privateCards['x-private'], '本人手牌自愈卡必须通过 privateCards 下发')
  const guestStatic = (await guest.call('status?clientStatic=')).json.static
  assert.equal(guestStatic.cards['x-private'], undefined, '私有卡面绝不能进公共静态表')
  const hostAfter = (await host.call('status')).json
  assert.equal(hostAfter.session.state.cards?.['x-private'], undefined, '私有卡面不能泄露到其他席位视图')
  assert.equal(hostAfter.static?.cards?.['x-private'], undefined)
  // 客人自己的全量视图能看到它（hydrate 后与旧客户端行为一致）。
  const guestLegacy = (await guest.call('status')).json.session
  assert.ok(guestLegacy.state.cards['x-private'])
  assert.deepEqual(functionalView(guestLegacy), functionalView(hydrate(guestSlim, guestStatic)))
})

test('guest 大厅缓存静态表：浏览器刷新由本地大厅补发，不必再向房主要全量', async t => {
  const { halls, relayUrl } = await fixture(t)
  const [host, guest] = halls
  await startRoom(halls, relayUrl)
  const guestSession = (await guest.call('status')).json.session
  const version = guestSession.staticVersion
  assert.equal(typeof version, 'string')
  assert.deepEqual(guest.server.online.staticFor(guestSession.sessionId)?.version, version)

  const snapshotsBefore = host.server.online.metrics.snapshots
  const hostSerialBefore = (await host.call('status')).json.serial
  // 模拟浏览器刷新：新客户端但本地没有缓存（clientStatic=''）。
  const refreshed = await guest.call('status?clientStatic=')
  assert.ok(refreshed.json.static, 'guest 大厅必须用本地缓存补发静态表')
  assert.equal(refreshed.json.static.version, version, '补发的是 guest 已缓存的同一版本')
  assert.equal(refreshed.json.session.state.cards, undefined, '新客户端刷新拿精简视图 + 静态表自行 hydrate')
  // hydrate 后与「旧客户端直接拿到的完整视图」逐字节一致。
  const guestLegacy = (await guest.call('status')).json.session
  assert.ok(guestLegacy.state.cards, '旧客户端仍然拿到可直接渲染的完整视图')
  assert.deepEqual(functionalView(hydrate(refreshed.json.session, refreshed.json.static)),
    functionalView(guestLegacy))
  // 没有向房主请求 sync（房主未重新发布快照）。
  await sleep(60)
  assert.equal(host.server.online.metrics.snapshots, snapshotsBefore, 'guest 浏览器刷新不应触发房主重发全量')
  assert.equal((await host.call('status')).json.serial, hostSerialBefore)
})

test('BOARDGAME_ONLINE_STATIC=0 一键回滚：所有响应都带全量静态表', async t => {
  const { halls, relayUrl } = await fixture(t, { env: { BOARDGAME_ONLINE_STATIC: '0' } })
  const [host] = halls
  await startRoom(halls, relayUrl)
  const legacy = await host.call('status')
  const declared = await host.call('status?clientStatic=')
  for (const value of [legacy, declared]) {
    assert.ok(value.json.session.state.cards, '回滚后必须带 cards')
    assert.ok(value.json.session.state.investigatorDefs, '回滚后必须带 investigatorDefs')
    assert.equal(value.json.session.staticVersion, undefined)
    assert.equal(value.json.static, undefined)
  }
  const command = await host.command('move', { revision: legacy.json.session.state.revision, move: { action: 'pass' }, client: { staticVersion: '' } })
  assert.equal(command.json.ok, true, command.json.error)
  assert.ok(command.json.session.state.cards, '回滚后命令响应也是全量视图')
})
