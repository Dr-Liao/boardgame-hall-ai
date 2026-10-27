// 复刻 tests/encounter-entries.test.mjs 第 7 项：单独进程 import 一个跨条目查询条目。
const target = process.argv[2]
if (!target) throw new Error('缺少目标条目路径')
const module_ = await import(target)
if (!module_.default || !module_.default.code) {
  console.error('bad default')
  process.exit(1)
}
console.log('ok', module_.default.code)
