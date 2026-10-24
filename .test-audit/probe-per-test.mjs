// Per-test attribution for the two heavy files: run each test in isolation with a watchdog.
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import path from 'node:path'

const repo = 'G:\\boardgame-hall-ai\\games\\arkhamhorror'
const out = 'G:\\boardgame-hall-ai\\.test-audit'
const node = process.execPath
const TIMEOUT_MS = 120000

const groups = [
  {
    file: 'tests/campaign-n4.test.mjs',
    patterns: [
      '检查点后续发生异常时整条命令仍原子回滚',
      '开局固定持久牌组，观察者只见本人无序清单',
      '集结 R2 队长单独多得1XP',
      'R1 丽塔由明确选择加入队长牌组',
      '跨关不重抽基础弱点、不恢复已更换牌组',
      'Core 升级池只在关间开放',
      '新购0级至少1XP',
      '结局重新核对地点残留线索',
      '掩盖罪证剩余线索导致精神创伤',
      '创伤达到印刷上限后更换独立人物',
      '集结R3杀死未撤退者',
      '同次伤害恐惧同时击败时显式选择一种创伤',
      '跨关牌组变化区分本关移除与永久移除',
      '午夜已至在下关换牌后随机弃两张',
      '01094 以资产自身容量承伤',
      '合法战役失败流程 1人/standard',
      '合法战役失败流程 4人/standard',
    ],
  },
  { file: 'tests/replay-fuzz.test.mjs', patterns: ['100 局随机对局', '5,000 步随机走子器'] },
]

const rows = []
for (const group of groups) {
  for (const pattern of group.patterns) {
    const started = Date.now()
    const result = spawnSync(node, ['--test', '--test-name-pattern', pattern, group.file], {
      cwd: repo, encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024,
    })
    const seconds = Number(((Date.now() - started) / 1000).toFixed(2))
    const timedOut = result.error?.code === 'ETIMEDOUT' || result.signal != null
    rows.push({ file: group.file, pattern, seconds, timedOut, status: timedOut ? null : result.status })
    console.log(`${group.file} | ${seconds}s | timeout=${timedOut} | ${pattern}`)
  }
}
writeFileSync(path.join(out, 'probe-per-test.json'), JSON.stringify(rows, null, 2) + '\n')
console.log('=== DONE ===')
