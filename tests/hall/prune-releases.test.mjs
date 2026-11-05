import test from 'node:test'
import assert from 'node:assert/strict'
import { chooseKept, tagsInDownloadPrefix } from '../../tools/release/prune-releases.mjs'

test('保留最高的若干个正式版本，并按版本号而不是字符串排序', () => {
  const plan = chooseKept(['v1.9.0', 'v1.10.0', 'v1.8.0', 'nightly', 'v1.10.0'], { keep: 2, current: 'v1.10.0' })
  assert.deepEqual(plan.kept, ['v1.9.0', 'v1.10.0'])
  assert.deepEqual(plan.drop, ['v1.8.0'])
})

test('刚发布的版本即使不是最高版本也保留', () => {
  const plan = chooseKept(['v1.0.0', 'v1.1.0', 'v1.2.0', 'v1.3.0'], { keep: 2, current: 'v1.0.0' })
  assert.deepEqual(plan.kept, ['v1.0.0', 'v1.2.0', 'v1.3.0'])
  assert.deepEqual(plan.drop, ['v1.1.0'])
  assert.equal(plan.drop.includes('v1.0.0'), false)
})

test('当前版本不在已发布列表里时仍然留下', () => {
  const plan = chooseKept(['v1.0.0', 'v1.1.0'], { keep: 1, current: 'v1.2.0' })
  assert.deepEqual(plan.kept, ['v1.2.0'])
  assert.deepEqual(plan.drop, ['v1.0.0', 'v1.1.0'])
})

test('没有超出版本上限时不清理', () => {
  const plan = chooseKept(['v1.0.0', 'v1.1.0'], { keep: 3, current: 'v1.1.0' })
  assert.deepEqual(plan.drop, [])
})

test('拒绝非法上限和版本号', () => {
  assert.throws(() => chooseKept(['v1.0.0'], { keep: 0, current: 'v1.0.0' }), /--keep/)
  assert.throws(() => chooseKept(['v1.0.0'], { keep: 1.5, current: 'v1.0.0' }), /--keep/)
  assert.throws(() => chooseKept(['v1.0.0'], { keep: 1, current: 'latest' }), /--current/)
})

test('CDN 版本只从 releases/download/<tag>/ 收集', () => {
  const tags = tagsInDownloadPrefix([
    'hall/releases/download/v1.2.0/BoardgameHall-app-1.2.0.zip',
    'hall/releases/download/v1.0.0/update-manifest.json',
    'hall/releases/latest/download/update-manifest.json',
    'hall/raw/main/registry/index.json',
    'hall/releases/download/not-a-version/a.zip',
    'arkhamhorror/releases/download/v9.0.0/a.zip',
  ], 'hall')
  assert.deepEqual(tags.sort(), ['v1.0.0', 'v1.2.0'])
})
