import test from 'node:test'
import assert from 'node:assert/strict'
import { buildDiagnostics, describePlatform, FEISHU_FORM_URL } from '../../public/feedback-ui.js'

const edgeUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0'
const safariUA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15'

test('反馈诊断信息：版本、平台、游戏、时间、最近错误', () => {
  const text = buildDiagnostics({
    hallVersion: '0.1.2',
    state: { session: { modName: '诡镇奇谈' }, error: '模型调用超时\n请重试' },
    nav: { userAgent: edgeUA },
    now: new Date(2026, 9, 21, 16, 5),
  })
  assert.equal(text, [
    '桌游大厅 v0.1.2 · Windows · Edge 140 · 游戏：诡镇奇谈',
    '时间：2026-10-21 16:05',
    '最近错误：模型调用超时 请重试',
  ].join('\n'))
})

test('反馈诊断信息：不带密钥、聊天内容和多余行', () => {
  const state = {
    config: { apiKey: 'sk-secret' },
    session: { modName: '五子棋', chat: '这是聊天内容' },
    setup: { game: { name: '井字棋' } },
  }
  const text = buildDiagnostics({ hallVersion: '0.1.2', state, nav: { userAgent: safariUA }, now: new Date(2026, 0, 2, 3, 4) })
  assert.doesNotMatch(text, /sk-secret|聊天内容/)
  assert.match(text, /macOS · Safari 17/)
  assert.match(text, /游戏：五子棋/) // 对局中优先用当前对局名
  assert.equal(text.split('\n').length, 2)
})

test('反馈诊断信息：没有版本和游戏时也能生成', () => {
  const text = buildDiagnostics({ state: null, nav: { userAgent: 'curl/8.0' }, now: new Date(2026, 0, 2, 3, 4) })
  assert.equal(text, '桌游大厅\n时间：2026-01-02 03:04')
})

test('平台识别：未知 UA 返回空串，不编造', () => {
  assert.equal(describePlatform({ userAgent: 'curl/8.0' }), '')
  assert.equal(describePlatform(null), '')
})

test('表单地址指向飞书共享表单', () => {
  assert.match(FEISHU_FORM_URL, /^https:\/\/my\.feishu\.cn\/share\/base\/form\/[A-Za-z0-9]+$/)
})
