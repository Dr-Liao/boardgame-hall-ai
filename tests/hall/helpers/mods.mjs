import { fileURLToPath } from 'node:url'
import { loadModFrom, modCandidates } from '../../../lib/mods.js'

export const FIXTURE_MODS_DIR = fileURLToPath(new URL('../../fixtures/mods/', import.meta.url))

// 大厅回归只依赖仓库内的参考游戏和测试专用 Mod，games/ 下增删其他游戏不影响大厅测试。
const REFERENCE_GAMES = ['gobang', 'ox']

export async function loadTestMods() {
  const candidates = [
    ...modCandidates({ userDir: null }).filter(candidate => REFERENCE_GAMES.includes(candidate.id)),
    ...modCandidates({ builtinDir: FIXTURE_MODS_DIR, userDir: null }),
  ]
  return Promise.all(candidates.map(loadModFrom))
}
