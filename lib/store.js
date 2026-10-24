// 游戏商店：从 GitHub 上的目录仓库读取可下载游戏 → 读取各游戏仓库最新 Release 的签名清单 →
// 下载、校验并解压到 <DSH_HOME 或 ~/.dsh>/boardgame-hall/mods/<id>/<版本>/。
//
// 目录（registry）index.json：{ "schema": 1, "games": [{ id, repo, cdn?, name, description, coverEmoji, localized? }] }
// localized 是可选的多语言展示文案（docs/localization.md §7.7）：{ "<locale>": { name?, description? } }，
// 只用于「游戏还没安装、大厅只能读 registry」时的商店列表；已安装的游戏以 Mod 自己的 i18n 为准。
// cdn 为该游戏发布文件的 CDN 前缀（如 Cloudflare R2 域名），有则优先从 CDN 下载（见 lib/update-common.js）。
// 游戏发布清单 boardgame-mod.release.json（签名信封，见 lib/signing.js）payload：
//   { schema:1, kind:'mod', id, name, version, hallApi, tag, file, sha256, size, notes, index? }
// index 为文件索引 {file,sha256,size}：已有旧版本（含内置版本）时只下载变化的文件（见 lib/delta.js）。
//
// 生效规则：
//   - 全新游戏安装后立即加载进大厅；
//   - 已加载游戏的新版本落盘后需重启大厅生效（避免与内存中的对局状态混用两套规则）；
//   - 卸载正在使用的下载版游戏时只做标记，下次启动时删除。

import fs from 'node:fs'
import path from 'node:path'
import { HALL_API, compareVersions, hallApiSupported, isVersion } from './version.js'
import { normalizeLocale } from './i18n.js'
import { readModManifest, preserveModFiles, renameWithRetry } from './install.js'
import { fetchText, latestAssetUrl, releaseAssetUrl, loadUpdateSettings, userModsDir, rmQuiet, REPO_PATTERN, CDN_PATTERN } from './update-common.js'
import { verifyEnvelope, loadTrustedKeys } from './signing.js'
import { stagePackage, estimateDownload } from './delta.js'
import { loadModFrom } from './mods.js'
import { checkAsset } from './updater.js'

export const MOD_RELEASE_FILE = 'boardgame-mod.release.json'
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
const UNINSTALL_MARKER = '.uninstall'

export function validateModRelease(manifest, expectedId) {
  if (!manifest || manifest.schema !== 1 || manifest.kind !== 'mod') throw new Error('不是游戏发布清单')
  if (manifest.id !== expectedId) throw new Error('发布清单 id 与目录不一致')
  if (!isVersion(manifest.version)) throw new Error('发布清单版本号无效')
  if (!Number.isInteger(manifest.hallApi)) throw new Error('发布清单缺少 hallApi')
  if (typeof manifest.tag !== 'string' || !/^[A-Za-z0-9._-]+$/.test(manifest.tag)) throw new Error('发布清单 tag 无效')
  checkAsset(manifest)
  if (manifest.index) checkAsset(manifest.index)
  return manifest
}

/** registry 条目的可选本地化文案：非法结构/语言/空文案一律丢弃，不影响基础中文文案（§7.7）。 */
export function parseRegistryLocalized(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const result = {}
  let any = false
  for (const [key, entry] of Object.entries(value)) {
    const locale = normalizeLocale(key)
    if (!locale || !entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const text = {}
    if (typeof entry.name === 'string' && entry.name.trim()) text.name = entry.name
    if (typeof entry.description === 'string' && entry.description.trim()) text.description = entry.description
    if (!text.name && !text.description) continue
    result[locale] = text
    any = true
  }
  return any ? result : null
}

export function parseRegistry(text) {
  let data
  try { data = JSON.parse(text) } catch { throw new Error('游戏目录不是有效的 JSON') }
  if (!data || data.schema !== 1 || !Array.isArray(data.games)) throw new Error('游戏目录格式无效')
  const seen = new Set()
  return data.games.filter(game => game && ID_PATTERN.test(game.id) && REPO_PATTERN.test(game.repo) && !seen.has(game.id) && seen.add(game.id))
    .map(game => ({
      id: game.id, repo: game.repo,
      cdn: typeof game.cdn === 'string' && CDN_PATTERN.test(game.cdn) ? game.cdn : null,
      name: typeof game.name === 'string' ? game.name : game.id,
      description: typeof game.description === 'string' ? game.description : '',
      coverEmoji: typeof game.coverEmoji === 'string' ? game.coverEmoji : '🎲',
      localized: parseRegistryLocalized(game.localized),
    }))
}

export function createStore({
  mods,
  registryUrl,
  cdn = {},
  keys = loadTrustedKeys(),
  fetchImpl = fetch,
  userDir = userModsDir(),
  getSettings = loadUpdateSettings,
  loadMod = loadModFrom,
} = {}) {
  let isModInUse = () => false
  const registry = { url: registryUrl || null, checking: false, checkedAt: null, error: null, games: [] }
  const entries = new Map()   // id -> { latest, error, state, progress, restartRequired }
  const entry = id => {
    if (!entries.has(id)) entries.set(id, { latest: null, error: null, state: 'idle', progress: null, restartRequired: false })
    return entries.get(id)
  }

  function downloadedVersions(id) {
    const dir = path.join(userDir, id)
    if (!ID_PATTERN.test(id) || !fs.existsSync(dir)) return []
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(item => item.isDirectory() && isVersion(item.name) && readModManifest(path.join(dir, item.name))?.version === item.name)
      .map(item => item.name).sort(compareVersions)
  }

  /** 增量更新可复用的本地版本：当前生效版本（可能是内置）与最新下载版本。 */
  function baseDirs(id) {
    const active = mods.find(mod => mod.id === id)?.package?.dir
    const previous = downloadedVersions(id).at(-1)
    return [...new Set([active, previous && path.join(userDir, id, previous)].filter(Boolean))]
  }

  const assetUrl = release => file => releaseAssetUrl(release.repo, release.tag, file)
  const cdnMap = () => ({ ...cdn, ...Object.fromEntries(registry.games.filter(game => game.cdn).map(game => [game.repo, game.cdn])) })

  function status() {
    const ids = new Set([...registry.games.map(game => game.id), ...mods.map(mod => mod.id)])
    if (fs.existsSync(userDir)) for (const item of fs.readdirSync(userDir, { withFileTypes: true })) if (item.isDirectory() && ID_PATTERN.test(item.name)) ids.add(item.name)
    const games = [...ids].map(id => {
      const listed = registry.games.find(game => game.id === id)
      const mod = mods.find(item => item.id === id)
      const info = entry(id)
      const downloaded = downloadedVersions(id)
      const latest = info.latest
      const installedVersion = mod?.package?.version || null
      const newest = [installedVersion, downloaded.at(-1)].filter(Boolean).sort(compareVersions).at(-1) || null
      return {
        id,
        name: mod?.name || listed?.name || id,
        description: listed?.description || mod?.description || '',
        // 中立保留 registry 的可选本地化文案，由 server.js 按当前语言选取展示名（§7.7）。
        localized: listed?.localized || null,
        cover: mod?.cover || '',
        coverEmoji: (mod ? mod.coverEmoji : listed?.coverEmoji) ?? '🎲',
        repo: listed?.repo || null,
        installed: mod ? { version: installedVersion, source: mod.package?.source || 'builtin' } : null,
        downloaded,
        latest: latest ? { version: latest.version, hallApi: latest.hallApi, notes: latest.notes || '', size: latest.downloadSize ?? latest.size, fullSize: latest.size } : null,
        compatible: latest ? hallApiSupported(latest.hallApi) : null,
        needsHallUpdate: !!latest && latest.hallApi > HALL_API,
        updateAvailable: !!latest && hallApiSupported(latest.hallApi) && (!newest || compareVersions(latest.version, newest) > 0),
        pendingUninstall: fs.existsSync(path.join(userDir, id, UNINSTALL_MARKER)),
        state: info.state, error: info.error, progress: info.progress, restartRequired: info.restartRequired,
      }
    })
    games.sort((a, b) => Number(!a.installed) - Number(!b.installed) || a.name.localeCompare(b.name, 'zh'))
    return { registry: { url: registry.url, checking: registry.checking, checkedAt: registry.checkedAt, error: registry.error }, games }
  }

  async function check() {
    if (!registry.url) { registry.error = '未配置游戏目录地址（package.json 的 boardgame.registry）'; return status() }
    if (registry.checking) return status()
    registry.checking = true
    try {
      const settings = getSettings()
      registry.games = await fetchText(registry.url, { mirror: settings.mirror, cdn, fetchImpl, parse: parseRegistry })
      registry.error = null
      const sources = { mirror: settings.mirror, cdn: cdnMap(), fetchImpl }
      await Promise.all(registry.games.map(async game => {
        const info = entry(game.id)
        try {
          const manifest = await fetchText(latestAssetUrl(game.repo, MOD_RELEASE_FILE), { ...sources, parse: text => validateModRelease(verifyEnvelope(text, keys), game.id) })
          const release = { ...manifest, repo: game.repo }
          if (hallApiSupported(release.hallApi) && !downloadedVersions(game.id).includes(release.version)) {
            release.downloadSize = await estimateDownload({ asset: release, urlFor: assetUrl(release), baseDirs: baseDirs(game.id), ...sources })
          }
          info.latest = release
          if (info.state === 'error') { info.state = 'idle'; info.error = null }
        } catch (error) {
          info.latest = null
          info.error = String(error?.message || error)
        }
      }))
    } catch (error) {
      registry.error = String(error?.message || error)
    } finally {
      registry.checking = false
      registry.checkedAt = new Date().toISOString()
    }
    return status()
  }

  /** 后台安装或更新；进度通过 status() 查询。 */
  function install(id) {
    const info = entry(id)
    const release = info.latest
    if (!release) throw new Error('没有找到该游戏的发布版本，请先检查更新')
    if (!hallApiSupported(release.hallApi)) throw new Error(release.hallApi > HALL_API ? '该游戏版本需要更新大厅后才能安装' : '该游戏版本过旧，与当前大厅不兼容')
    if (info.state === 'installing') return status()
    info.state = 'installing'
    info.error = null
    info.progress = { received: 0, total: release.downloadSize ?? release.size, mode: null }
    run(id, release).then(() => {
      info.state = 'idle'
      info.progress = null
    }, error => {
      info.state = 'error'
      info.error = String(error?.message || error)
      info.progress = null
    })
    return status()
  }

  async function run(id, release) {
    const settings = getSettings()
    const finalDir = path.join(userDir, id, release.version)
    const valid = dir => {
      const manifest = readModManifest(dir)
      if (!manifest || manifest.id !== id || manifest.version !== release.version || manifest.hallApi !== release.hallApi) throw new Error('游戏包清单与发布清单不一致')
      if (!fs.existsSync(path.join(dir, 'index.js'))) throw new Error('游戏包缺少 index.js')
    }
    let reuse = false
    if (fs.existsSync(finalDir)) {
      try { valid(finalDir); reuse = true } catch { rmQuiet(finalDir) }
    }
    if (!reuse) {
      const partial = finalDir + '.partial'
      rmQuiet(partial)
      rmQuiet(partial + '.zip')
      fs.mkdirSync(path.dirname(partial), { recursive: true })
      const bases = baseDirs(id)
      try {
        await stagePackage({
          asset: release, urlFor: assetUrl(release), baseDirs: bases, destination: partial, mirror: settings.mirror, cdn: cdnMap(), fetchImpl,
          onPlan: ({ mode, total }) => { entry(id).progress = { received: 0, total, mode } },
          onProgress: received => { entry(id).progress = { ...entry(id).progress, received } },
        })
        valid(partial)
        if (bases[0]) preserveModFiles(bases[0], partial)
        await renameWithRetry(partial, finalDir)
      } catch (error) {
        rmQuiet(partial)
        throw error
      }
    }
    rmQuiet(path.join(userDir, id, UNINSTALL_MARKER))
    const loaded = mods.find(mod => mod.id === id)
    if (!loaded) {
      mods.push(await loadMod({ id, version: release.version, hallApi: release.hallApi, source: 'user', dir: finalDir }))
    } else if (compareVersions(release.version, loaded.package?.version || '0.0.0') > 0) {
      entry(id).restartRequired = true
    }
  }

  function uninstall(id) {
    if (!ID_PATTERN.test(id) || !fs.existsSync(path.join(userDir, id))) throw new Error('该游戏没有可卸载的下载版本')
    const info = entry(id)
    if (info.state === 'installing') throw new Error('正在安装，请稍后再试')
    const index = mods.findIndex(mod => mod.id === id)
    const activeUser = index >= 0 && mods[index].package?.source === 'user'
    if (activeUser && isModInUse(id)) {
      fs.writeFileSync(path.join(userDir, id, UNINSTALL_MARKER), new Date().toISOString())
      info.restartRequired = true
      return status()
    }
    if (activeUser) mods.splice(index, 1)
    fs.rmSync(path.join(userDir, id), { recursive: true, force: true })
    info.restartRequired = false
    return status()
  }

  /** 启动时调用：执行延迟卸载，删除中断的 .partial 和比当前生效版本更旧的下载版本。 */
  function cleanup() {
    if (!fs.existsSync(userDir)) return
    for (const item of fs.readdirSync(userDir, { withFileTypes: true })) {
      if (!item.isDirectory()) continue
      const dir = path.join(userDir, item.name)
      if (fs.existsSync(path.join(dir, UNINSTALL_MARKER)) && mods.find(mod => mod.id === item.name)?.package?.source !== 'user') {
        rmQuiet(dir)
        continue
      }
      const active = mods.find(mod => mod.id === item.name)?.package?.version
      for (const version of fs.readdirSync(dir, { withFileTypes: true })) {
        if (version.isFile() && version.name.endsWith('.partial.zip')) { rmQuiet(path.join(dir, version.name)); continue }
        if (!version.isDirectory()) continue
        if (version.name.endsWith('.partial') || (active && isVersion(version.name) && compareVersions(version.name, active) < 0)) {
          rmQuiet(path.join(dir, version.name))
        }
      }
    }
  }

  return {
    status, check, install, uninstall, cleanup,
    bindUsage(fn) { isModInUse = fn },
    get restartRequired() { return [...entries.values()].some(info => info.restartRequired) },
  }
}
