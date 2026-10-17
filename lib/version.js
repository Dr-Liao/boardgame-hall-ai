// 大厅版本与 Mod 接口契约版本。
//
// HALL_VERSION 取自与 lib/ 同级的 package.json：开发版是仓库根目录，发布包是 app-<版本>/。
// HALL_API 是 lib/mods.js 所述 Mod 接口的版本号：契约出现不兼容改动时加一；
// 下载的游戏在 boardgame-mod.json 里声明 hallApi，只有落在 [HALL_API_MIN, HALL_API] 内才会被加载。

import fs from 'node:fs'

export const HALL_API = 1
export const HALL_API_MIN = 1

export const HALL_VERSION = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/

export function isVersion(value) {
  return typeof value === 'string' && VERSION.test(value)
}

/** 比较 x.y.z 版本号；非法版本视为 0.0.0。 */
export function compareVersions(left, right) {
  const a = (VERSION.exec(left) || [0, 0, 0, 0]).slice(1).map(Number)
  const b = (VERSION.exec(right) || [0, 0, 0, 0]).slice(1).map(Number)
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return 0
}

export function hallApiSupported(value) {
  return Number.isInteger(value) && value >= HALL_API_MIN && value <= HALL_API
}
