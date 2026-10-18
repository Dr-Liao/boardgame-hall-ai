// 大厅自动更新：检查 GitHub Release 上的签名清单 → 下载程序包（必要时连同运行时）→
// 解压到 app-<新版本>/ 旁路目录 → 改写 current.ini（trial=1）→ 由启动器重启切换。
//
// 程序包带文件索引时只下载变化的文件（见 lib/delta.js），运行时包总是整包下载。
//
// 运行模式：
//   portable  免安装包 + 协议 2 启动器：可下载并切换版本
//   manual    旧版免安装包等无法自更新的环境：只提示去发布页下载
//   dev       git 仓库：只提示 git pull
//   disabled  package.json 未配置 boardgame.repo
//
// 发布清单格式见 docs/updates.md；清单签名由 lib/signing.js 校验，包内容由 sha256 校验。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { HALL_VERSION, compareVersions, isVersion } from './version.js'
import { installContext, readPointer, writePointer, failedVersions, isVersionDir, LAUNCHER_PROTOCOL, preserveModFiles, renameWithRetry, bundledGamesFilter } from './install.js'
import { fetchText, latestAssetUrl, releaseAssetUrl, releasePageUrl, loadUpdateSettings, rmQuiet, REPO_PATTERN } from './update-common.js'
import { verifyEnvelope, loadTrustedKeys } from './signing.js'
import { stagePackage, estimateDownload } from './delta.js'

export const HALL_MANIFEST_FILE = 'update-manifest.json'
const APP_ROOT = fileURLToPath(new URL('..', import.meta.url))

export function platformKey() {
  return process.platform + '-' + process.arch
}

export function validateHallManifest(manifest) {
  if (!manifest || manifest.schema !== 1 || manifest.kind !== 'hall') throw new Error('不是大厅更新清单')
  if (!isVersion(manifest.version)) throw new Error('更新清单版本号无效')
  if (typeof manifest.tag !== 'string' || !/^[A-Za-z0-9._-]+$/.test(manifest.tag)) throw new Error('更新清单 tag 无效')
  checkAsset(manifest.app, 'app')
  if (manifest.app.index) checkAsset(manifest.app.index)
  if (manifest.app.dir !== 'app-' + manifest.version) throw new Error('程序包目录与版本号不符')
  for (const runtime of Object.values(manifest.runtimes || {})) checkAsset(runtime, 'runtime')
  return manifest
}

export function checkAsset(asset, kind) {
  if (!asset || typeof asset.file !== 'string' || !/^[A-Za-z0-9._-]+$/.test(asset.file)) throw new Error('更新清单文件名无效')
  if (typeof asset.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(asset.sha256)) throw new Error('更新清单缺少 sha256')
  if (!Number.isSafeInteger(asset.size) || asset.size <= 0) throw new Error('更新清单文件大小无效')
  if (kind && !isVersionDir(asset.dir, kind)) throw new Error('更新清单目录名无效')
}

export function createUpdater({
  repo,
  cdnBase,
  install = installContext(),
  keys = loadTrustedKeys(),
  fetchImpl = fetch,
  version = HALL_VERSION,
  devCheckout = fs.existsSync(path.join(APP_ROOT, '.git')),
  getSettings = loadUpdateSettings,
  platform = platformKey(),
} = {}) {
  const pointer = install ? readPointer(install.root) : null
  const mode = !repo || !REPO_PATTERN.test(repo) ? 'disabled'
    : install && pointer && install.launcher >= LAUNCHER_PROTOCOL ? 'portable'
      : devCheckout ? 'dev' : 'manual'
  const cdn = repo && cdnBase ? { [repo]: cdnBase } : undefined
  let manifest = null
  const state = {
    mode, repo: repo || null, currentVersion: version, platform,
    releaseUrl: repo ? releasePageUrl(repo) : null,
    checking: false, checkedAt: null, error: null,
    latest: null, available: false, failedBefore: false, needsFullPackage: false,
    download: { state: 'idle', received: 0, total: 0, error: null, version: null, mode: null },
  }
  // 启动器把上一次失败的版本写进 failed：若比当前版本新，说明刚刚发生过回滚。
  const rolledBack = failedVersions(pointer).filter(v => compareVersions(v, version) > 0).sort(compareVersions).pop()
  state.rolledBack = rolledBack || null

  function status() {
    return structuredClone(state)
  }

  async function check() {
    if (mode === 'disabled') throw new Error('未配置大厅发布仓库（package.json 的 boardgame.repo）')
    if (state.checking) return status()
    state.checking = true
    try {
      const settings = getSettings()
      manifest = await fetchText(latestAssetUrl(repo, HALL_MANIFEST_FILE), {
        mirror: settings.mirror, cdn, fetchImpl, parse: text => validateHallManifest(verifyEnvelope(text, keys)),
      })
      const current = (install && readPointer(install.root)) || pointer
      const runtime = manifest.runtimes?.[platform]
      const runtimeSize = runtime && runtime.dir !== current?.runtime ? runtime.size : 0
      state.available = compareVersions(manifest.version, version) > 0
      const appSize = state.available && mode === 'portable' && current?.app
        ? await estimateDownload({
          asset: manifest.app, urlFor: assetUrl(manifest), prefix: manifest.app.dir,
          baseDirs: [path.join(install.root, current.app)], mirror: settings.mirror, cdn, fetchImpl,
          filter: bundledGamesFilter(install.root),
        })
        : manifest.app.size
      state.latest = {
        version: manifest.version, notes: typeof manifest.notes === 'string' ? manifest.notes : '',
        publishedAt: manifest.publishedAt || null,
        size: appSize + runtimeSize,
        fullSize: manifest.app.size + runtimeSize,
      }
      state.failedBefore = failedVersions(current).includes(manifest.version)
      state.needsFullPackage = mode === 'portable' && (Number(manifest.minLauncher) || 0) > install.launcher
      state.error = null
    } catch (error) {
      state.error = String(error?.message || error)
    } finally {
      state.checking = false
      state.checkedAt = new Date().toISOString()
    }
    return status()
  }

  /** 后台下载并准备新版本；进度通过 status().download 查询。 */
  function download() {
    if (mode !== 'portable') throw new Error(mode === 'dev' ? '开发版请使用 git pull 更新' : '当前环境不支持自动更新，请从发布页下载新版')
    if (!manifest || !state.available) throw new Error('没有可用的新版本，请先检查更新')
    if (state.needsFullPackage) throw new Error('此版本需要新的启动器，请从发布页下载完整安装包')
    if (state.download.state === 'downloading') return status()
    const target = manifest
    state.download = { state: 'downloading', received: 0, total: 0, error: null, version: target.version, mode: null }
    stage(target).then(() => {
      state.download.state = 'ready'
    }, error => {
      state.download.state = 'error'
      state.download.error = String(error?.message || error)
    })
    return status()
  }

  async function stage(target) {
    const root = install.root
    const current = readPointer(root)
    if (!current) throw new Error('找不到 current.ini，无法切换版本')
    if (target.app.dir === current.app) throw new Error('该版本已在使用中')
    const settings = getSettings()
    const runtime = target.runtimes?.[platform]
    const needRuntime = runtime && runtime.dir !== current.runtime
    const assets = [{ asset: target.app, verify: verifyApp, baseDirs: [path.join(root, current.app)], filter: bundledGamesFilter(root) }]
    if (needRuntime) assets.push({ asset: runtime, verify: verifyRuntime, baseDirs: [] })
    const totals = assets.map(item => item.asset.size)
    const updateTotal = () => { state.download.total = totals.reduce((sum, size) => sum + size, 0) }
    updateTotal()
    let done = 0
    for (const [i, { asset, verify, baseDirs, filter }] of assets.entries()) {
      const finalDir = path.join(root, asset.dir)
      if (asset.dir === current.app || asset.dir === current.runtime) throw new Error('不能覆盖正在使用的目录')
      if (fs.existsSync(finalDir)) {
        try { verify(finalDir, target); totals[i] = 0; updateTotal(); continue } catch { rmQuiet(finalDir) }
      }
      const partial = finalDir + '.partial'
      rmQuiet(partial)
      rmQuiet(partial + '.zip')
      try {
        await stagePackage({
          asset, urlFor: assetUrl(target), prefix: asset.dir, baseDirs, filter, destination: partial, mirror: settings.mirror, cdn, fetchImpl,
          onPlan: ({ mode, total }) => {
            totals[i] = total
            updateTotal()
            if (asset === target.app) state.download.mode = mode
          },
          onProgress: received => { state.download.received = done + received },
        })
        verify(partial, target)
        await renameWithRetry(partial, finalDir)
      } catch (error) {
        rmQuiet(partial)
        throw error
      }
      done += totals[i]
      state.download.received = done
    }
    // 内置游戏运行时缓存的资源（如诡镇卡图）按各自 boardgame-mod.json 的 preserve 列表带到新版本。
    const oldGames = path.join(root, current.app, 'games')
    const newGames = path.join(root, target.app.dir, 'games')
    if (fs.existsSync(oldGames) && fs.existsSync(newGames)) {
      for (const entry of fs.readdirSync(newGames, { withFileTypes: true })) {
        if (entry.isDirectory()) preserveModFiles(path.join(oldGames, entry.name), path.join(newGames, entry.name))
      }
    }
    writePointer(root, {
      app: target.app.dir,
      runtime: needRuntime ? runtime.dir : current.runtime,
      previousApp: current.app,
      previousRuntime: current.runtime,
      trial: '1',
      failed: current.failed,
    })
  }

  function assetUrl(target) {
    return file => releaseAssetUrl(repo, target.tag, file)
  }

  return { status, check, download, get mode() { return mode }, get restartable() { return mode === 'portable' } }
}

function verifyApp(dir, target) {
  for (const file of ['portable.mjs', 'server.js', 'package.json']) {
    if (!fs.existsSync(path.join(dir, file))) throw new Error('程序包缺少 ' + file)
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  if (pkg.version !== target.version) throw new Error('程序包版本与清单不符')
}

function verifyRuntime(dir) {
  if (!fs.existsSync(path.join(dir, process.platform === 'win32' ? 'node.exe' : 'node'))) throw new Error('运行时包缺少 node')
}
