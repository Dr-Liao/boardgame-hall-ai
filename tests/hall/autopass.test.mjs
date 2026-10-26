// 自动跳过大 regression：P0（命令发起者代答）+ P1（房主缓存任意在线座位偏好，
// 任意命令触发的窗口 / 多座位连续窗口都能在同一命令里代答）。
//
// 覆盖点：
//   1. 单机：move 带 client.autoPass 时，房主在响应前补普通 choose/skip —— 响应里窗口已消失、
//      revision +2、actionLog/state.log 与手点一致；不带偏好时窗口照常保留。
//   2. 联机 P0：房主与客人座位都能由本人命令携带的偏好代答（客人偏好经 relay 到达房主），
//      两端快照都看不到窗口；不带偏好时窗口照常发布、仍需本人回答。
//   3. 联机 P1：`prefs` 命令 / move 捎带把全座位偏好缓存到房主后，`openAll` 的四座位连续窗口
//      在**同一条命令**里全部代答（0 条额外 skip 命令）；缺某座位偏好 / 主动清空 / 座位离线时，
//      链在那一格停下，由本人客户端兜底或等待重连。
//   4. `prefs` 命令到达时若该座位正在等窗口，就地代答并继续按缓存推进。
//   5. BOARDGAME_AUTOPASS=0 回滚：恢复「客户端自己回答」的旧行为。
//
// 只测大厅通用机制，不依赖 games/arkhamhorror（游戏回归里另有 reaction-preferences 用例）。

import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRelay } from '../../relay/server.js'
import { createServer } from '../../lib/server.js'
import { loadTestMods } from './helpers/mods.mjs'

const MOD = 'fixture-autopass'
const PREF = { codes: ['opt-card'] }

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)))
const stop = server => new Promise(resolve => { try { server.online?.close() } catch { /* already closed */ } server.closeAllConnections(); server.close(() => resolve()) })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor(fn, timeout = 8000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { const value = await fn(); if (value) return value; await sleep(20) }
  throw new Error('等待状态同步超时')
}

async function fixture(t, count = 1) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hall-autopass-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const mods = await loadTestMods()
  const relay = count > 1 ? createRelay({ secret: 'autopass-test-secret' }) : null
  const relayUrl = relay ? await listen(relay) : null
  const halls = []
  for (let i = 0; i < count; i++) {
    const server = createServer({ mods, persist: i === 0 })
    await server.ready
    const origin = await listen(server)
    const request = async (route, body) => {
      const res = await fetch(origin + '/api/' + route, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20000),
      })
      return res.json()
    }
    const online = async (route, body) => {
      const res = await fetch(origin + '/api/online/' + route, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'x-boardgame-online': '1', 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20000),
      })
      return res.json()
    }
    halls.push({
      server, origin, request, online,
      command: (action, body = {}) => online('command', { action, body: { operationId: randomUUID(), ...body } }),
    })
  }
  t.after(async () => {
    await Promise.all(halls.map(hall => stop(hall.server)))
    if (relay) await stop(relay)
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    fs.rmSync(home, { recursive: true, force: true })
  })
  return { halls, relayUrl }
}

async function startSolo(t) {
  const { halls } = await fixture(t, 1)
  const hall = halls[0]
  const started = await hall.request('start', { modId: MOD, settings: { playerCount: 1 } })
  assert.equal(started.ok, true, started.error)
  return { hall, started }
}

async function startOnline(t, capacity = 2) {
  const { halls, relayUrl } = await fixture(t, capacity)
  const [host, ...guests] = halls
  const created = await host.online('create', { relayUrl, modId: MOD, capacity, fillAi: false })
  assert.equal(created.ok, true, created.error)
  for (const guest of guests) {
    const joined = await guest.online('join', { relayUrl, code: created.room.code })
    assert.equal(joined.ok, true, joined.error)
    assert.equal((await guest.online('ready', { ready: true })).ok, true)
  }
  const started = await host.command('start')
  assert.equal(started.ok, true, started.error)
  await waitFor(async () => {
    const views = await Promise.all(halls.map(hall => hall.online('status')))
    return views.every(view => view.session?.state?.status === 'playing')
  })
  return { halls, host, guests }
}

const labels = state => state.log.map(entry => entry.move.optionId ?? entry.move.action)
const viewOf = async hall => (await hall.online('status')).session

// 每个座位用 prefs 命令异步上行偏好（模拟客户端进局/开关变化时的同步）。
async function syncAllPreferences(halls) {
  for (const hall of halls) {
    const result = await hall.command('prefs', { codes: PREF.codes })
    assert.equal(result.ok, true, result.error)
  }
}

test('单机：client.autoPass 在响应前代答，窗口不落盘、actionLog 与手点一致', async t => {
  const { hall, started } = await startSolo(t)
  const sessionId = started.session.sessionId
  const revision = started.session.state.revision

  const opened = await hall.request('move', {
    sessionId, revision, move: { action: 'open' }, client: { autoPass: PREF },
  })
  assert.equal(opened.ok, true, opened.error)
  assert.equal(opened.session.state.pendingChoice, null, '窗口应在响应前被代答掉')
  assert.equal(opened.session.state.triggered, 0, '代答的是 skip 而不是 trigger')
  assert.deepEqual(labels(opened.session.state), ['open', 'skip'], 'skip 走的是普通 applyMove')
  assert.equal(opened.session.state.revision, revision + 2)

  // 显式清空偏好 = 回到「窗口保留、客户端自己回答」的旧行为。
  const keep = await hall.request('move', {
    sessionId, revision: opened.session.state.revision, move: { action: 'open' },
    client: { autoPass: { codes: [] } },
  })
  assert.equal(keep.ok, true, keep.error)
  assert.equal(keep.session.state.pendingChoice?.id, 'opt-' + opened.session.state.revision)
  assert.equal(keep.session.state.pendingChoice?.seat, 0)
  assert.deepEqual(keep.session.state.pendingChoice.options.map(option => option.id), ['skip', 'trigger'])

  const answered = await hall.request('move', {
    sessionId, revision: keep.session.state.revision,
    move: { action: 'choose', choiceId: keep.session.state.pendingChoice.id, optionId: 'skip' },
  })
  assert.equal(answered.ok, true, answered.error)
  assert.equal(answered.session.state.pendingChoice, null)
  assert.deepEqual(labels(answered.session.state), ['open', 'skip', 'open', 'skip'])
})

test('联机 P0：房主与客人的偏好都在发布前代答，两端快照都看不到窗口', async t => {
  const { host, guests } = await startOnline(t)
  const guest = guests[0]

  // 1) 不带偏好：窗口照常发布到两端，必须由本人回答（旧行为回归）。
  const hostView = await viewOf(host)
  const plain = await host.command('move', { revision: hostView.state.revision, move: { action: 'open' } })
  assert.equal(plain.ok, true, plain.error)
  assert.equal(plain.session?.state?.pendingChoice?.seat, 0)
  await waitFor(async () => (await viewOf(guest)).state.pendingChoice?.seat === 0)
  const answered = await host.command('move', {
    revision: plain.session.state.revision,
    move: { action: 'choose', choiceId: plain.session.state.pendingChoice.id, optionId: 'skip' },
  })
  assert.equal(answered.ok, true, answered.error)

  // 2) 行动权交给客人；客人命令携带偏好 → 房主代答，客人快照里没有窗口。
  const hostNext = await host.command('move', { revision: answered.session.state.revision, move: { action: 'next' } })
  assert.equal(hostNext.ok, true, hostNext.error)
  await waitFor(async () => (await viewOf(guest)).state.currentSeat === 1)
  const guestView = await viewOf(guest)
  const guestOpen = await guest.command('move', {
    revision: guestView.state.revision, move: { action: 'open' }, client: { autoPass: PREF },
  })
  assert.equal(guestOpen.ok, true, guestOpen.error)
  await waitFor(async () => (await viewOf(host)).state.revision >= guestView.state.revision + 2)
  const hostAfterGuest = await viewOf(host)
  assert.equal(hostAfterGuest.state.pendingChoice, null, '客人座位的窗口也应在房主侧代答')
  assert.equal(hostAfterGuest.state.triggered, 0)
  assert.deepEqual(labels(hostAfterGuest.state).slice(-2), ['open', 'skip'])
  await waitFor(async () => (await viewOf(guest)).state.revision >= hostAfterGuest.state.revision)
  assert.equal((await viewOf(guest)).state.pendingChoice, null, '客人视图里也不应出现窗口')

  // 3) 再交回房主：房主命令带偏好同样零窗口。
  const guestNext = await guest.command('move', { revision: hostAfterGuest.state.revision, move: { action: 'next' } })
  assert.equal(guestNext.ok, true, guestNext.error)
  const hostAgain = await viewOf(host)
  const hostOpen = await host.command('move', {
    revision: hostAgain.state.revision, move: { action: 'open' }, client: { autoPass: PREF },
  })
  assert.equal(hostOpen.ok, true, hostOpen.error)
  assert.equal(hostOpen.session.state.pendingChoice, null)
  assert.equal(hostOpen.session.state.triggered, 0)
  assert.deepEqual(labels(hostOpen.session.state).slice(-2), ['open', 'skip'])
})

test('联机 P1：全员偏好同步后，一条 openAll 命令把四座位连续窗口全部代答（0 额外命令）', async t => {
  const { halls, host } = await startOnline(t, 4)
  await syncAllPreferences(halls)
  const before = await viewOf(host)
  const opened = await host.command('move', { revision: before.state.revision, move: { action: 'openAll' } })
  assert.equal(opened.ok, true, opened.error)
  const after = opened.session.state
  assert.equal(after.pendingChoice, null, '四个座位的窗口都应在同一条命令里代答完')
  assert.equal(after.completed, 1, '连续窗口链已走完')
  assert.equal(after.triggered, 0)
  assert.deepEqual(labels(after), ['openAll', 'skip', 'skip', 'skip', 'skip'])
  assert.equal(after.revision, before.state.revision + 5, 'openAll + 4 个 skip 都在同一条命令里')
  // 其他玩家的快照也直接是链结束后的状态，不会看到任何中间窗口。
  await waitFor(async () => {
    const views = await Promise.all(halls.map(hall => hall.online('status')))
    return views.every(view => view.session?.state?.revision >= after.revision)
  })
  for (const hall of halls) assert.equal((await viewOf(hall)).state.pendingChoice, null)
})

test('联机 P1：偏好随 move 捎带缓存，后续别人的命令触发的窗口也被代答', async t => {
  const { host, guests } = await startOnline(t, 4)
  const halls = [host, ...guests]
  // 每个座位各走一步（座位按 next 轮转），每条 move 都捎带偏好。
  for (const hall of halls) {
    const session = await viewOf(hall)
    const seat = session.mySeat
    assert.equal(session.state.currentSeat, seat, '轮到该座位')
    const result = await hall.command('move', {
      revision: session.state.revision, move: { action: 'next' }, client: { autoPass: PREF },
    })
    assert.equal(result.ok, true, result.error)
  }
  // 回到房主座位后触发四座位连续窗口；触发命令本身不带偏好，完全依赖缓存。
  const before = await viewOf(host)
  assert.equal(before.state.currentSeat, 0)
  const opened = await host.command('move', { revision: before.state.revision, move: { action: 'openAll' } })
  assert.equal(opened.ok, true, opened.error)
  assert.equal(opened.session.state.pendingChoice, null)
  assert.equal(opened.session.state.completed, 1)
  assert.deepEqual(labels(opened.session.state).slice(-5), ['openAll', 'skip', 'skip', 'skip', 'skip'])
})

test('联机 P1：缺某座位偏好时链在那一格停下，由该座位自己回答（兜底）', async t => {
  const { halls, host } = await startOnline(t, 4)
  // 只同步座位 0/1/2，座位 3 没有偏好。
  for (const hall of halls.slice(0, 3)) {
    assert.equal((await hall.command('prefs', { codes: PREF.codes })).ok, true)
  }
  const before = await viewOf(host)
  const opened = await host.command('move', { revision: before.state.revision, move: { action: 'openAll' } })
  assert.equal(opened.ok, true, opened.error)
  const stopped = opened.session.state
  assert.equal(stopped.pendingChoice?.seat, 3, '链应停在未同步偏好的座位 3')
  assert.deepEqual(labels(stopped), ['openAll', 'skip', 'skip', 'skip'])
  assert.equal(stopped.revision, before.state.revision + 4)

  // 座位 3 自己的客户端兜底回答后，链结束。
  const guest3 = halls[3]
  const answer = await guest3.command('move', {
    revision: stopped.revision,
    move: { action: 'choose', choiceId: stopped.pendingChoice.id, optionId: 'skip' },
  })
  assert.equal(answer.ok, true, answer.error)
  assert.equal(answer.session.state.pendingChoice, null)
  assert.equal(answer.session.state.completed, 1)
})

test('联机 P1：prefs 只更新缓存、不改变对局；待决窗口仍由该座位客户端提交后继续按缓存推进', async t => {
  const { halls, host, guests } = await startOnline(t, 4)
  const before = await viewOf(host)
  // 无偏好触发：链停回座位 0（触发者本人也没有偏好）。
  const opened = await host.command('move', { revision: before.state.revision, move: { action: 'openAll' } })
  assert.equal(opened.ok, true, opened.error)
  assert.equal(opened.session.state.pendingChoice?.seat, 0)
  // 座位 0 手动跳过 → 链停在座位 1。
  const skip0 = await host.command('move', {
    revision: opened.session.state.revision,
    move: { action: 'choose', choiceId: opened.session.state.pendingChoice.id, optionId: 'skip' },
  })
  assert.equal(skip0.ok, true, skip0.error)
  assert.equal(skip0.session.state.pendingChoice?.seat, 1)

  // prefs 只写缓存：不偷偷代答窗口、不推进 revision（避免和该座位客户端的 skip 抢 revision）。
  const revisionBeforePrefs = (await viewOf(host)).state.revision
  const pref1 = await guests[0].command('prefs', { codes: PREF.codes, seq: 100 })
  assert.equal(pref1.ok, true, pref1.error)
  assert.equal(pref1.accepted, true)
  const afterPrefs = await viewOf(host)
  assert.equal(afterPrefs.state.revision, revisionBeforePrefs)
  assert.equal(afterPrefs.state.pendingChoice?.seat, 1, 'prefs 不改变待决窗口')

  // 座位 1 客户端自己的 skip 命令（携带偏好）结算窗口；下一位没有缓存，链停在座位 2。
  const skip1 = await guests[0].command('move', {
    revision: afterPrefs.state.revision,
    move: { action: 'choose', choiceId: afterPrefs.state.pendingChoice.id, optionId: 'skip' },
    client: { autoPass: PREF },
  })
  assert.equal(skip1.ok, true, skip1.error)
  assert.equal(skip1.session.state.pendingChoice?.seat, 2)
  assert.deepEqual(labels(skip1.session.state).slice(-2), ['skip', 'skip'])

  // 座位 2、3 依次同步偏好并各自提交 skip，链结束。
  for (const [guestIndex, seat] of [[1, 2], [2, 3]]) {
    const pref = await guests[guestIndex].command('prefs', { codes: PREF.codes, seq: 200 + seat })
    assert.equal(pref.accepted, true)
    const view = await viewOf(host)
    assert.equal(view.state.pendingChoice?.seat, seat)
    const skip = await guests[guestIndex].command('move', {
      revision: view.state.revision,
      move: { action: 'choose', choiceId: view.state.pendingChoice.id, optionId: 'skip' },
      client: { autoPass: PREF },
    })
    assert.equal(skip.ok, true, skip.error)
  }
  const done = await viewOf(host)
  assert.equal(done.state.pendingChoice, null)
  assert.equal(done.state.completed, 1)
  assert.deepEqual(labels(done.state), ['openAll', 'skip', 'skip', 'skip', 'skip'])
})

test('联机 P1：偏好 seq 丢弃乱序旧值，旧 seq 不会覆盖新偏好', async t => {
  const { halls, host } = await startOnline(t, 4)
  // 四个座位都先同步「关闭」偏好，带递增 seq。
  for (let seat = 0; seat < 4; seat++) {
    const result = await halls[seat].command('prefs', { codes: PREF.codes, seq: 1000 + seat })
    assert.equal(result.ok, true, result.error)
    assert.equal(result.accepted, true)
  }
  // 座位 2 的一个更旧 seq 的「全部开启」必须被丢弃。
  const stale = await halls[2].command('prefs', { codes: [], seq: 5 })
  assert.equal(stale.ok, true, stale.error)
  assert.equal(stale.accepted, false)
  // move 捎带的偏好同样按 seq 比较：旧 seq 的 move 不能清掉缓存。
  const markView = await viewOf(host)
  const mark = await host.command('move', {
    revision: markView.state.revision, move: { action: 'mark' }, client: { autoPass: { codes: [], seq: 5 } },
  })
  assert.equal(mark.ok, true, mark.error)
  const before = await viewOf(host)
  const opened = await host.command('move', { revision: before.state.revision, move: { action: 'openAll' } })
  assert.equal(opened.ok, true, opened.error)
  assert.equal(opened.session.state.pendingChoice, null, '旧 seq 的清空不能覆盖新偏好（move 捎带同样生效）')
  assert.equal(opened.session.state.completed, 1)

  // 更新的 seq 清空 → 下一次连续窗口在该座位停下。
  const cleared = await halls[2].command('prefs', { codes: [], seq: 5000 })
  assert.equal(cleared.accepted, true)
  // 上一条 openAll 结束后行动权停在最后一个座位（3），先交回座位 0 才能再由房主触发。
  const back = await viewOf(host)
  assert.equal(back.state.currentSeat, 3)
  const rotate = await halls[3].command('move', { revision: back.state.revision, move: { action: 'next' } })
  assert.equal(rotate.ok, true, rotate.error)
  const beforeClear = await viewOf(host)
  assert.equal(beforeClear.state.currentSeat, 0)
  const openedClear = await host.command('move', { revision: beforeClear.state.revision, move: { action: 'openAll' } })
  assert.equal(openedClear.ok, true, openedClear.error)
  assert.equal(openedClear.session.state.pendingChoice?.seat, 2, '新 seq 的清空应生效')
})

test('联机 P1：主动清空偏好（codes:[]）会移除该座位缓存，链在该座位停下', async t => {
  const { halls, host } = await startOnline(t, 4)
  await syncAllPreferences(halls)
  // 座位 2 重新打开全部提示 → 空集合清除缓存。
  const cleared = await halls[2].command('prefs', { codes: [] })
  assert.equal(cleared.ok, true, cleared.error)
  const before = await viewOf(host)
  const opened = await host.command('move', { revision: before.state.revision, move: { action: 'openAll' } })
  assert.equal(opened.ok, true, opened.error)
  assert.equal(opened.session.state.pendingChoice?.seat, 2, '链应在清空偏好的座位 2 停下')
  assert.deepEqual(labels(opened.session.state), ['openAll', 'skip', 'skip'])
})

test('联机 P1：离线座位的偏好不再生效，链停在该座位等待', async t => {
  const { halls, host } = await startOnline(t, 4)
  await syncAllPreferences(halls)
  // 座位 2 的大厅断开（成员离线 → 不替它做决定；偏好缓存保留但 settle 会跳过离线座位）。
  await stop(halls[2].server)
  await waitFor(async () => {
    const status = await host.online('status')
    const member = status.room?.members.find(item => item.seat === 2)
    return !member || member.online === false
  })
  const before = await viewOf(host)
  const opened = await host.command('move', { revision: before.state.revision, move: { action: 'openAll' } })
  assert.equal(opened.ok, true, opened.error)
  assert.equal(opened.session.state.pendingChoice?.seat, 2, '离线座位的缓存不能被用来代答')
  assert.deepEqual(labels(opened.session.state), ['openAll', 'skip', 'skip'])
})

test('BOARDGAME_AUTOPASS=0 回滚：不再代答，仍由客户端自己回答', async t => {
  const previous = process.env.BOARDGAME_AUTOPASS
  process.env.BOARDGAME_AUTOPASS = '0'
  t.after(() => {
    if (previous === undefined) delete process.env.BOARDGAME_AUTOPASS
    else process.env.BOARDGAME_AUTOPASS = previous
  })
  const { hall, started } = await startSolo(t)
  const sessionId = started.session.sessionId
  const opened = await hall.request('move', {
    sessionId, revision: started.session.state.revision, move: { action: 'open' }, client: { autoPass: PREF },
  })
  assert.equal(opened.ok, true, opened.error)
  assert.equal(opened.session.state.pendingChoice?.seat, 0, '回滚后窗口照常等待客户端回答')
  assert.deepEqual(labels(opened.session.state), ['open'])
})
