// 聊天输入补全纯函数回归：@ 定向 / 指令上下文、候选过滤、消息去重键。
//
// 运行：node --test tests/hall/chat-compose.test.mjs（或直接 node 该文件）

import test from 'node:test'
import assert from 'node:assert/strict'
import { chatCompletionContext, chatFilterOptions, chatMessageKey } from '../../public/chat-compose.js'

test('输入补全上下文与候选', async (t) => {
  await t.test('@ 只在词首触发，并且光标前不能有空白', () => {
    assert.deepEqual(chatCompletionContext('@', 1), { kind: 'mention', start: 0, end: 1, query: '' })
    assert.deepEqual(chatCompletionContext('请 @花', 4), { kind: 'mention', start: 2, end: 4, query: '花' })
    assert.equal(chatCompletionContext('@花冈柚子 先查线索', 11), null, '@ 后已经出现空白 → 不再补全')
    assert.equal(chatCompletionContext('@花冈柚子', 11)?.query, '花冈柚子')
    assert.equal(chatCompletionContext('a@b.com', 7), null, '邮箱不算定向发言')
    assert.equal(chatCompletionContext('普通发言', 4), null)
  })

  await t.test('光标在中间时只解析光标之前的内容', () => {
    const context = chatCompletionContext('@才羽 @花冈柚子', 3)
    assert.equal(context?.kind, 'mention')
    assert.equal(context?.query, '才羽')
    assert.equal(context?.start, 0)
    assert.equal(context?.end, 3)
    assert.equal(chatCompletionContext('@才羽 @花冈柚子', 4), null, '光标停在空白后 → 不补全')
  })

  await t.test('/ 只在整条发言开头、且还没输入空白时触发', () => {
    assert.deepEqual(chatCompletionContext('/', 1), { kind: 'command', start: 0, end: 1, query: '' })
    assert.deepEqual(chatCompletionContext('/备', 2), { kind: 'command', start: 0, end: 2, query: '备' })
    assert.deepEqual(chatCompletionContext('／清', 2), { kind: 'command', start: 0, end: 2, query: '清' }, '全角斜杠同样识别')
    assert.equal(chatCompletionContext('/备忘 先查线索', 8), null, '指令参数阶段不再补全')
    assert.equal(chatCompletionContext('好的 /备忘', 7), null, '/ 不在开头不算指令')
  })

  await t.test('候选过滤：标签、候选名、大小写', () => {
    const options = [
      { value: '@全体 ', label: '全体成员' },
      { value: '@花冈柚子 ', label: '花冈柚子' },
      { value: '@才羽桃 ', label: '才羽桃' },
    ]
    assert.equal(chatFilterOptions(options, '').length, 3)
    assert.deepEqual(chatFilterOptions(options, '全').map((item) => item.label), ['全体成员'])
    assert.deepEqual(chatFilterOptions(options, '才羽').map((item) => item.label), ['才羽桃'])
    assert.deepEqual(chatFilterOptions(options, '蕉').map((item) => item.label), [])
    const commands = [
      { value: '/备忘 ', label: '/备忘 <内容>' },
      { value: '/清除备忘', label: '/清除备忘' },
    ]
    assert.deepEqual(chatFilterOptions(commands, '清除').map((item) => item.value), ['/清除备忘'])
    assert.deepEqual(chatFilterOptions(commands, '备忘').length, 2)
    assert.deepEqual(chatFilterOptions(null, 'x'), [])
  })

  await t.test('消息去重键按频道与文本区分', () => {
    assert.equal(chatMessageKey({ to: null, text: '公开' }), 'table|公开')
    assert.equal(chatMessageKey({ to: 2, text: '私聊' }), 'seat:2|私聊')
    assert.equal(chatMessageKey({ to: null, text: '公开' }), chatMessageKey({ to: null, text: '公开' }))
    assert.notEqual(chatMessageKey({ to: null, text: '公开' }), chatMessageKey({ to: 2, text: '公开' }))
    assert.equal(chatMessageKey(null), '')
  })
})
