import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadAis, saveAis } from '../../lib/ai.js'
import { buildSystemPrompt, buildChatSystemPrompt } from '../../lib/agent/prompt.js'

function isolatedHome(t) {
  const previous = process.env.DSH_HOME
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hall-ai-personas-'))
  process.env.DSH_HOME = home
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    assert.ok(path.resolve(home).startsWith(path.resolve(os.tmpdir()) + path.sep))
    fs.rmSync(home, { recursive: true, force: true })
  })
  return path.join(home, 'boardgame-hall', 'ais.json')
}

test('新安装创建五位蔚蓝档案角色，行动与聊天均使用完整人设', t => {
  const file = isolatedHome(t)
  const ais = loadAis()
  assert.deepEqual(ais.map(ai => ai.name), ['花冈柚子', '才羽桃', '才羽绿', '天童爱丽丝', '天童凯伊'])
  assert.equal(new Set(ais.map(ai => ai.id)).size, 5)
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), ais)
  for (const ai of ais) {
    assert.ok(ai.persona.includes(ai.name))
    const mod = { name: '测试桌游', cooperative: true, moveFormat: '{}' }
    assert.ok(buildSystemPrompt(mod, ai, {}, 1).includes(ai.persona))
    assert.ok(buildChatSystemPrompt(mod, ai, {}, 1).includes(ai.persona))
  }
  ais[0].persona = '我自行修改的新柚子人设'
  saveAis(ais)
  assert.deepEqual(loadAis(), ais, '重启不能重置用户对新角色的修改')
})

test('行动与聊天提示词统一要求自然交流', () => {
  const mod = { name: '测试桌游', cooperative: true, moveFormat: '{}' }
  const ai = { persona: '你是一位冷静的桌游玩家。' }
  const prompts = [
    buildSystemPrompt(mod, ai, {}, 1),
    buildChatSystemPrompt(mod, ai, {}, 1),
  ]
  for (const prompt of prompts) {
    assert.ok(prompt.includes('自然交流，保持人物的立场和语气，不刻意表演'))
    assert.ok(prompt.includes('【统一表达规则】'))
    assert.ok(prompt.includes('不使用破折号（—、——、–）或 Markdown 列表'))
    assert.ok(prompt.includes('不写括号舞台动作、旁白式心理描写'))
    assert.ok(prompt.includes('不反复自我介绍、称呼玩家或重复口头禅'))
    assert.ok(!prompt.includes('必须全程严格扮演'))
  }
})

test('旧默认角色升级落盘，保留 ID、顺序、自定义配置与删除结果', t => {
  const file = isolatedHome(t)
  const oldMo = {
    id: 'ai-mo', name: '墨玄子', avatar: '🧙', color: '#7c5cff',
    persona: '你是墨玄子，一位沉稳老练、深谋远虑的棋手。你说话慢条斯理，喜欢用棋理说教，从不大喊大叫。你落子注重全局布局，先守后攻，擅长声东击西。胜不骄、败不馁，任何时候都保持从容风度。',
  }
  const oldHu = {
    id: 'ai-hu', name: '白狐军师', avatar: '🦊', color: '#ffb020',
    persona: '你是白狐军师，狡黠机敏、笑里藏刀的谋士。你爱说谜语和反话，从不直说意图。你落子擅长设陷阱、诱敌深入，攻防兼备、虚实难辨。即便落败也会说是"另有深意"。',
  }
  const custom = { id: 'ai-custom', name: '自建角色', avatar: '⭐', color: '#ffffff', persona: '保持我的人设' }
  saveAis([oldHu, custom, oldMo])
  const upgraded = loadAis()
  assert.deepEqual(upgraded.map(ai => ai.id), ['ai-hu', 'ai-custom', 'ai-mo'])
  assert.deepEqual(upgraded.map(ai => ai.name), ['才羽绿', '自建角色', '花冈柚子'])
  assert.deepEqual(upgraded[1], custom)
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), upgraded)
  assert.deepEqual(loadAis(), upgraded, '迁移应当幂等，且不会补回已删除角色')

  for (const [key, value] of Object.entries({ name: '我改的名称', persona: '我改的人设', avatar: '🖼️', color: '#123456' })) {
    const edited = { ...oldMo, [key]: value }
    saveAis([edited, oldHu])
    const mixed = loadAis()
    assert.deepEqual(mixed[0], edited, `保留用户编辑的 ${key}`)
    assert.equal(mixed[1].name, '才羽绿')
  }
})

test('现有角色只替换旧默认头像，保留人设修改和自定义头像', t => {
  const file = isolatedHome(t)
  const defaults = loadAis()
  const emojis = ['🍊', '🍑', '🎨', '🎮', '🔑']
  const existing = defaults.map((ai, index) => ({ ...ai, avatar: emojis[index], persona: '我编辑的人设', color: '#123456' }))
  saveAis(existing)
  const migrated = loadAis()
  assert.deepEqual(migrated, existing.map((ai, index) => ({ ...ai, avatar: defaults[index].avatar })))
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), migrated)
  assert.deepEqual(loadAis(), migrated)
  for (const ai of migrated) {
    assert.ok(fs.existsSync(new URL('../../public' + ai.avatar, import.meta.url)))
  }
  const custom = defaults.map(ai => ({ ...ai, avatar: 'data:image/png;base64,custom' }))
  const renamed = { ...existing[0], name: '我自己的角色' }
  saveAis([...custom, renamed])
  assert.deepEqual(loadAis(), [...custom, renamed])
})
