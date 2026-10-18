// 增量更新：发布时为每个 ZIP 包生成文件索引 <包名>.files.json（每个文件的 sha256 与压缩数据在 ZIP 中的区间），
// 签名清单记录索引本身的 sha256，索引再记录所属 ZIP 的 sha256，信任链与完整下载一致。
//
// 客户端把本地旧版本中哈希一致的文件硬链接（跨盘时复制）到新版本目录，只用 HTTP Range 下载变化的文件，
// 写入前逐个按索引校验 sha256。没有可复用的旧版本、变化过多、服务器不支持 Range 或增量过程中出错时，
// 退回下载完整 ZIP。
//
// 索引格式：{ schema:1, kind:'files', prefix, package:{file,sha256,size},
//            files:[{ path, size, sha256, offset, length, method, exec? }] }
// path 不含 prefix；offset/length 是压缩数据（不含本地文件头）在 ZIP 内的位置。

import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { walkZip, inflateEntry, safeRelative, extractZip } from './zip.js'
import { fetchBuffer, fetchRange, downloadVerified, rmQuiet } from './update-common.js'

const MAX_DELTA_RATIO = 0.6       // 增量超过完整包的 60% 时直接下完整包
const MAX_RANGES = 400            // 分段请求过多时每段的往返开销会超过节省
const RANGE_GAP = 64 * 1024       // 相邻文件间隔小于此值时合并成一次请求
const RANGE_MAX = 8 * 1048576     // 合并后的单次请求上限（单个大文件不受限）
const CONCURRENCY = 4

const sha256 = data => createHash('sha256').update(data).digest('hex')
const hashCache = new Map()       // `${file}|${size}|${mtimeMs}` -> sha256，只用于检查更新时的下载量估算
const indexCache = new Map()      // 索引 sha256 -> 已校验的索引

export const indexFileName = packageFile => packageFile.replace(/\.zip$/i, '') + '.files.json'

export async function hashFile(file) {
  const hash = createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

/** 发布时调用：读取 ZIP 生成索引对象。prefix 为归档内的顶层目录（程序包为 app-<版本>，游戏包为空）。 */
export async function buildIndex(zipPath, { prefix = '' } = {}) {
  const head = prefix ? prefix + '/' : ''
  const files = []
  await walkZip(zipPath, (entry, data, offset) => {
    if (!entry.name.startsWith(head)) throw new Error('ZIP 条目不在 ' + head + ' 目录下: ' + entry.name)
    files.push({
      path: entry.name.slice(head.length), size: entry.size, sha256: sha256(data),
      offset, length: entry.compressedSize, method: entry.method, ...(entry.executable ? { exec: true } : {}),
    })
  })
  const { size } = await fs.promises.stat(zipPath)
  return { schema: 1, kind: 'files', prefix, package: { file: path.basename(zipPath), sha256: await hashFile(zipPath), size }, files }
}

/** 校验索引内容：sha256 与签名清单一致、与所属程序包对应、每个条目合法且不越界。 */
export function parseIndex(buffer, { indexAsset, asset, prefix = '' }) {
  if (buffer.length !== indexAsset.size || sha256(buffer) !== indexAsset.sha256) throw new Error('文件索引校验失败')
  let index
  try { index = JSON.parse(buffer.toString('utf8')) } catch { throw new Error('文件索引不是有效的 JSON') }
  if (index?.schema !== 1 || index.kind !== 'files' || index.prefix !== prefix || !Array.isArray(index.files)) throw new Error('文件索引格式无效')
  const pkg = index.package
  if (pkg?.file !== asset.file || pkg.sha256 !== asset.sha256 || pkg.size !== asset.size) throw new Error('文件索引与程序包不对应')
  const seen = new Set()
  for (const file of index.files) {
    const valid = file && typeof file.path === 'string' && safeRelative(file.path) === file.path
      && Number.isSafeInteger(file.size) && file.size >= 0 && /^[0-9a-f]{64}$/.test(file.sha256)
      && Number.isSafeInteger(file.offset) && file.offset >= 0 && Number.isSafeInteger(file.length) && file.length >= 0
      && (file.size === 0 || file.length > 0) && file.offset + file.length <= asset.size && (file.method === 0 || file.method === 8)
    const key = file?.path?.toLowerCase?.()
    if (!valid || seen.has(key)) throw new Error('文件索引条目无效: ' + file?.path)
    seen.add(key)
  }
  return index
}

async function fileHash(file, stat, useCache) {
  if (!useCache) return hashFile(file)
  const key = `${file}|${stat.size}|${stat.mtimeMs}`
  if (!hashCache.has(key)) hashCache.set(key, await hashFile(file))
  return hashCache.get(key)
}

/** 对比索引与本地目录：reuse 为可复用的文件（来源路径，空文件为 ''），ranges 为需要下载的合并区间。 */
export async function planDelta(index, baseDirs, { cache = false } = {}) {
  const reuse = new Map()
  const missing = []
  for (const file of index.files) {
    let source = file.size === 0 ? '' : null
    for (const base of source === null ? baseDirs : []) {
      const candidate = path.join(base, ...file.path.split('/'))
      const stat = await fs.promises.stat(candidate).catch(() => null)
      if (!stat?.isFile() || stat.size !== file.size) continue
      if (await fileHash(candidate, stat, cache) === file.sha256) { source = candidate; break }
    }
    if (source === null) missing.push(file)
    else reuse.set(file, source)
  }
  const ranges = []
  for (const file of missing.sort((a, b) => a.offset - b.offset)) {
    const last = ranges.at(-1)
    const end = file.offset + file.length - 1
    if (last && file.offset - last.end - 1 <= RANGE_GAP && end - last.start < RANGE_MAX) {
      last.end = Math.max(last.end, end)
      last.files.push(file)
    } else {
      ranges.push({ start: file.offset, end, files: [file] })
    }
  }
  return { reuse, ranges, bytes: ranges.reduce((sum, range) => sum + range.end - range.start + 1, 0) }
}

const worthwhile = (plan, asset) => plan.bytes <= asset.size * MAX_DELTA_RATIO && plan.ranges.length <= MAX_RANGES

async function loadIndex({ asset, urlFor, prefix, mirror, gitee, fetchImpl, filter }) {
  let index = indexCache.get(asset.index.sha256)
  if (!index) {
    index = await fetchBuffer(urlFor(asset.index.file), { mirror, gitee, fetchImpl, parse: buffer => parseIndex(buffer, { indexAsset: asset.index, asset, prefix }) })
    indexCache.set(asset.index.sha256, index)
  }
  return filter ? { ...index, files: index.files.filter(file => filter(file.path)) } : index
}

async function writeFile(target, data, file) {
  await fs.promises.mkdir(path.dirname(target), { recursive: true })
  await fs.promises.writeFile(target, data, { flag: 'wx' })
  if (file.exec && process.platform !== 'win32') await fs.promises.chmod(target, 0o755)
}

async function applyDelta({ url, plan, destination, mirror, fetchImpl, onProgress }) {
  const targetOf = file => path.join(destination, ...file.path.split('/'))
  for (const [file, source] of plan.reuse) {
    const target = targetOf(file)
    if (!source) { await writeFile(target, '', file); continue }
    await fs.promises.mkdir(path.dirname(target), { recursive: true })
    await fs.promises.link(source, target).catch(() => fs.promises.copyFile(source, target, fs.constants.COPYFILE_EXCL))
    if (file.exec && process.platform !== 'win32') await fs.promises.chmod(target, 0o755)
  }
  let received = 0
  let failure = null
  const queue = [...plan.ranges]
  const worker = async () => {
    for (let range = queue.shift(); range && !failure; range = queue.shift()) {
      try {
        const data = await fetchRange(url, range.start, range.end, { mirror, fetchImpl, onProgress: delta => onProgress?.(received += delta) })
        for (const file of range.files) {
          const raw = data.subarray(file.offset - range.start, file.offset - range.start + file.length)
          const content = await inflateEntry(file.method, raw).catch(() => null)
          if (!content || content.length !== file.size || sha256(content) !== file.sha256) throw new Error('增量文件校验失败: ' + file.path)
          await writeFile(targetOf(file), content, file)
        }
      } catch (error) {
        failure ??= error
      }
    }
  }
  // 全部工作者结束后再返回，避免失败后仍有请求往即将被删除或重用的目录里写文件。
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker))
  if (failure) throw failure
}

/**
 * 检查更新时估算下载量：有索引且本地有旧版本时返回增量字节数，否则返回完整包大小。
 * 本地文件哈希按路径、大小、修改时间缓存，定时检查不会反复读整个目录。
 */
export async function estimateDownload({ asset, urlFor, prefix = '', baseDirs = [], mirror = '', gitee, fetchImpl = fetch, filter }) {
  const bases = baseDirs.filter(dir => dir && fs.existsSync(dir))
  if (!asset.index || !bases.length) return asset.size
  try {
    const plan = await planDelta(await loadIndex({ asset, urlFor, prefix, mirror, gitee, fetchImpl, filter }), bases, { cache: true })
    return worthwhile(plan, asset) ? plan.bytes : asset.size
  } catch {
    return asset.size
  }
}

/**
 * 把发布包准备到 destination（须不存在）：优先增量，失败退回完整下载。
 * asset：{ file, sha256, size, index? }；urlFor(file) 返回该发布的资产地址；
 * filter(relative)：返回 false 的文件不下载也不解压（精简版跳过未内置的游戏）。
 * onPlan({ mode, total }) 在确定下载方式后调用；onProgress(received) 报告已下载字节。
 * 返回 { mode: 'delta'|'full', downloaded, reused, fallback? }。
 */
export async function stagePackage({ asset, urlFor, prefix = '', baseDirs = [], destination, mirror = '', gitee, fetchImpl = fetch, filter, onPlan, onProgress }) {
  const bases = baseDirs.filter(dir => dir && fs.existsSync(dir))
  let fallback
  if (asset.index && bases.length) {
    try {
      const plan = await planDelta(await loadIndex({ asset, urlFor, prefix, mirror, gitee, fetchImpl, filter }), bases)
      if (worthwhile(plan, asset)) {
        onPlan?.({ mode: 'delta', total: plan.bytes })
        await applyDelta({ url: urlFor(asset.file), plan, destination, mirror, fetchImpl, onProgress })
        return { mode: 'delta', downloaded: plan.bytes, reused: plan.reuse.size }
      }
    } catch (error) {
      rmQuiet(destination)
      fallback = String(error?.message || error)
    }
  }
  onPlan?.({ mode: 'full', total: asset.size })
  const archive = destination + '.zip'
  try {
    await downloadVerified(urlFor(asset.file), archive, { sha256: asset.sha256, size: asset.size, mirror, gitee, fetchImpl, onProgress })
    await extractZip(archive, destination, { prefix, filter })
  } catch (error) {
    rmQuiet(destination)
    throw error
  } finally {
    rmQuiet(archive)
  }
  return { mode: 'full', downloaded: asset.size, reused: 0, ...(fallback ? { fallback } : {}) }
}
