// 生成 golden-replays 新基线到可写临时目录（沙箱不允许子进程写 games/arkhamhorror/**）。
import fs from 'node:fs'
const target = 'G:\\boardgame-hall-ai\\.tmp-doom-probe\\golden-replays.json'
const realWrite = fs.writeFileSync.bind(fs)
fs.writeFileSync = (file, data, ...rest) => {
  if (String(file).includes('golden-replays.json')) {
    realWrite(target, data, ...rest)
    console.log('REDIRECTED ' + file + ' -> ' + target + ' bytes=' + String(data).length)
    return
  }
  return realWrite(file, data, ...rest)
}
process.argv = [process.argv[0], 'replay-fixtures.mjs', '--write']
await import('../games/arkhamhorror/tools/replay-fixtures.mjs')
