// 大厅 AI 座位去重回归：同一局里同一个 AI（按 id 和名字）只能坐一个座位。
//
// 覆盖：
//   - lib/ai-seats.js 的分配规则：手动选择优先、随机补位不撞名、同名不同 id 只算一个、角色不足时报错；
//   - public/ai-seats.js 的浏览器端规则：默认/旧状态去重、其他座位已选 AI 标记为不可选；
//   - /api/start：随机分配出的 AI 名字互不相同，重复的手动选择会被改派；
//   - /api/start：角色不够时给出可操作的错误，而不是让同名 AI 坐两席。
//
// 运行：node tests/hall/ai-seats.test.mjs（沙箱下不要用 node --test / npm script）
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assignUniqueAis, uniqueAiList } from '../../lib/ai-seats.js'
import { RANDOM_AI, dedupeSeatChoices, seatAiChoices } from '../../public/ai-seats.js'
import { createServer } from '../../lib/server.js'
import { loadTestMods } from './helpers/mods.mjs'

const CARDS = 'fixture-cards'

function useTempHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hall-ai-seats-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    fs.rmSync(home, { recursive: true, force: true })
  })
  return home
}

async function startHall(t) {
  const mods = await loadTestMods()
  const server = createServer({ mods, persist: false })
  await server.ready
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  })
  const request = async (route, body) => {
    const response = await fetch(base + '/api' + route, body === undefined ? {} : {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    return { status: response.status, ...await response.json() }
  }
  return { server, base, request }
}

const aiPlayers = session => session.players.filter(player => player.role === 'ai')
const nameList = list => list.map(item => item.name)

test('assignUniqueAis：随机补位不会撞 id 或撞名，手动选择优先', () => {
  const ais = [
    { id: 'a', name: '柚子' }, { id: 'b', name: '小桃' }, { id: 'c', name: '小绿' },
    { id: 'a2', name: '柚子' }, { id: 'd', name: '爱丽丝' },
  ]
  assert.deepEqual(uniqueAiList(ais).map(ai => ai.id), ['a', 'b', 'c', 'd'], '同名角色只保留第一个')
  for (let round = 0; round < 20; round++) {
    const picked = assignUniqueAis(ais, 3, [null, null, null])
    assert.equal(new Set(picked.map(ai => ai.id)).size, 3)
    assert.equal(new Set(nameList(picked)).size, 3)
    // 后面的手动选择必须优先：随机座位不能把已经点名的角色抢走。
    const reserved = assignUniqueAis(ais, 3, [null, null, 'c'])
    assert.equal(reserved[2].id, 'c')
    assert.ok(!reserved.slice(0, 2).some(ai => ai.id === 'c'))
    assert.equal(new Set(nameList(reserved)).size, 3)
  }
})

test('assignUniqueAis：重复选择、同名角色和未知 id 都按随机补位，角色不足时报错', () => {
  const ais = [{ id: 'a', name: '柚子' }, { id: 'b', name: '小桃' }, { id: 'c', name: '小绿' }]
  const repeated = assignUniqueAis(ais, 3, ['b', 'b', null])
  assert.equal(repeated[0].id, 'b', '第一次选择保留')
  assert.notEqual(repeated[1].id, 'b', '重复选择改派给其他 AI')
  assert.equal(new Set(nameList(repeated)).size, 3)

  const unknown = assignUniqueAis(ais, 2, ['missing', RANDOM_AI])
  assert.equal(new Set(nameList(unknown)).size, 2)

  const sameName = [{ id: 'x1', name: '同名' }, { id: 'x2', name: '同名' }, { id: 'y', name: '另一个' }]
  const picked = assignUniqueAis(sameName, 2, ['x1', 'x2'])
  assert.equal(picked[0].id, 'x1')
  assert.notEqual(picked[1].id, 'x2', '同名角色不能坐两个座位')
  assert.equal(new Set(nameList(picked)).size, 2)

  assert.throws(() => assignUniqueAis([{ id: 'only', name: '唯一' }], 2, [null, null]), (error) => {
    assert.equal(error.code, 'AI_POOL_EXHAUSTED')
    assert.match(error.message, /AI 角色不足/)
    return true
  })
})

test('浏览器端座位去重：重复选择改成随机，其他座位已选的 AI 不可选', () => {
  const ais = [{ id: 'a', name: '小明' }, { id: 'b', name: '小红' }]
  assert.deepEqual(dedupeSeatChoices(['a', 'a', RANDOM_AI, null, undefined], ais),
    ['a', RANDOM_AI, RANDOM_AI, null, undefined], '重复 id 与未知 id 改成随机，空值保持原样')
  assert.deepEqual(dedupeSeatChoices(['missing'], ais), [RANDOM_AI])

  assert.equal(seatAiChoices(ais, ['a', RANDOM_AI], 1).find(ai => ai.id === 'a').used, true)
  assert.equal(seatAiChoices(ais, ['a', RANDOM_AI], 0).find(ai => ai.id === 'a').used, false,
    '当前座位自己选的角色不能标成已占用')

  // 同名但不同 id：选中一个，另一个也视为已上场（服务端同样只允许一个）。
  const sameName = [{ id: 'x1', name: '同名' }, { id: 'x2', name: '同名' }]
  assert.equal(seatAiChoices(sameName, ['x1'], 1).find(ai => ai.id === 'x2').used, true)
  assert.deepEqual(dedupeSeatChoices(['x1', 'x2'], sameName), ['x1', RANDOM_AI])
})

test('API：随机分配与重复选择都不会让同名 AI 坐两个座位', async (t) => {
  useTempHome(t)
  const hall = await startHall(t)
  for (let round = 0; round < 5; round++) {
    const started = await hall.request('/start', { modId: CARDS, settings: { playerCount: 4, seed: 'fixture' } })
    assert.equal(started.ok, true, started.error)
    const players = aiPlayers(started.session)
    assert.equal(players.length, 3)
    assert.equal(new Set(players.map(player => player.aiId)).size, 3, 'AI id 必须互不相同')
    assert.equal(new Set(nameList(players)).size, 3, 'AI 名字必须互不相同')
  }

  const duplicated = await hall.request('/start', {
    modId: CARDS,
    settings: { playerCount: 4, seed: 'fixture', opponents: ['ai-hu', 'ai-hu', null] },
  })
  assert.equal(duplicated.ok, true, duplicated.error)
  const picked = aiPlayers(duplicated.session)
  assert.equal(picked[0].aiId, 'ai-hu', '第一次明确选择保留')
  assert.notEqual(picked[1].aiId, 'ai-hu', '重复选择被改派')
  assert.equal(new Set(nameList(picked)).size, 3)
})

test('API：同名但不同 id 的 AI 也只上场一个；角色不够时给出可操作的错误', async (t) => {
  useTempHome(t)
  const hall = await startHall(t)
  const first = await hall.request('/ais', { ai: { name: '同名棋手', avatar: '🤖', color: '#888888' } })
  const second = await hall.request('/ais', { ai: { name: '同名棋手', avatar: '🎭', color: '#666666' } })
  assert.ok(first.saved?.id && second.saved?.id)

  const started = await hall.request('/start', {
    modId: CARDS,
    settings: { playerCount: 4, seed: 'fixture', opponents: [first.saved.id, second.saved.id, null] },
  })
  assert.equal(started.ok, true, started.error)
  const players = aiPlayers(started.session)
  assert.equal(players[0].aiId, first.saved.id)
  assert.ok(!players.some(player => player.aiId === second.saved.id), '同名角色不能坐第二个座位')
  assert.equal(new Set(nameList(players)).size, 3)

  // 只留一个 AI 角色：3 个 AI 座位无法凑出不同名字，开局应被拦住而不是悄悄复制。
  const all = (await hall.request('/ais')).ais
  for (const ai of all.slice(1)) await hall.request('/ais/delete', { id: ai.id })
  const blocked = await hall.request('/start', { modId: CARDS, settings: { playerCount: 4, seed: 'fixture' } })
  assert.equal(blocked.ok, false)
  assert.match(blocked.error, /AI 角色不足/)
})
