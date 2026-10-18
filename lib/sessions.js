// 对局快照持久化：把内存中的 session 以 JSON 落盘，进程重启后可恢复。
//
// 设计边界：
//   - 目录：<DSH_HOME 或 ~/.dsh>/boardgame-hall/sessions/<modId>/<sessionId>.json，每个游戏一个子目录；
//     旧版直接放在 sessions/ 下的存档会在读取时自动迁移到对应游戏的子目录；
//   - 只保存纯数据（state / players / events / settings），不保存进程内的并发锁；
//   - 原子写入（临时文件 + rename），避免读到半截文件；
//   - 读取时做最小结构校验；损坏、过期或版本不符的快照会被隔离/丢弃，
//     绝不让"读存档"失败影响到大厅启动；
//   - 快照不是权威状态：恢复后每一次行动仍然要过 Mod 的 validateMove / applyMove。
//
// 默认开启，BOARDGAME_PERSIST=0 可整体关闭（例如纯离线测试）。

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const SCHEMA = 1
const DEFAULT_TTL_DAYS = 14
const UNKNOWN_MOD_DIR = '_unknown'

export function persistEnabled() {
  return process.env.BOARDGAME_PERSIST !== '0'
}

export function sessionsDir() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'boardgame-hall', 'sessions')
}

/** 只接受安全的对局编号，避免拼接出目录穿越路径。 */
function safeId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(id) && id !== '.' && id !== '..' ? id : null
}

function modDirName(modId) {
  return safeId(modId) || UNKNOWN_MOD_DIR
}

function modDirs() {
  try {
    return fs.readdirSync(sessionsDir(), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name)
  } catch { return [] }
}

/** 该对局编号当前所有落盘位置（正常只有一个；旧版根目录存档也算在内）。 */
function existingFiles(id) {
  const dir = sessionsDir()
  const name = id + '.json'
  return [path.join(dir, name), ...modDirs().map(sub => path.join(dir, sub, name))].filter(file => fs.existsSync(file))
}

/**
 * 存档文件路径。给出 modId 时返回该游戏子目录下的位置；
 * 否则返回已存在的存档位置，找不到时返回旧版根目录下（不存在的）路径。
 */
export function snapshotPath(sessionId, modId) {
  const id = safeId(sessionId)
  if (!id) throw new Error('非法对局编号')
  if (modId !== undefined) return path.join(sessionsDir(), modDirName(modId), id + '.json')
  return existingFiles(id)[0] || path.join(sessionsDir(), id + '.json')
}

/** 写入一局快照（原子替换）。返回落盘路径。 */
export function saveSnapshot(session, extra = {}) {
  const sessionId = session && session.sessionId
  const file = snapshotPath(sessionId, session.modId ?? null)
  const record = {
    schema: SCHEMA,
    savedAt: new Date().toISOString(),
    resourceVersion: typeof extra.resourceVersion === 'string' ? extra.resourceVersion : null,
    session,
  }
  const body = JSON.stringify(record) // 提前暴露不可序列化的状态（如循环引用）
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.' + process.pid + '.tmp'
  fs.writeFileSync(tmp, body, 'utf8')
  fs.renameSync(tmp, file)
  for (const stale of existingFiles(sessionId)) {
    if (stale !== file) fs.rmSync(stale, { force: true })
  }
  return file
}

/** 把旧版直接放在 sessions/ 根目录的存档移到对应游戏的子目录；无法解析的会被隔离为 .bad。 */
function migrateLegacySnapshots() {
  const dir = sessionsDir()
  let names
  try { names = fs.readdirSync(dir).filter(name => name.endsWith('.json') && fs.statSync(path.join(dir, name)).isFile()) } catch { return }
  for (const name of names) {
    const file = path.join(dir, name)
    const record = readSnapshotFile(file, name)
    if (!record) continue
    const target = snapshotPath(record.session.sessionId, record.session.modId ?? null)
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      if (fs.existsSync(target)) fs.rmSync(file, { force: true })
      else fs.renameSync(file, target)
    } catch (err) {
      console.warn('  [sessions] 迁移旧存档 ' + name + ' 失败：' + String(err && err.message ? err.message : err))
    }
  }
}

/** 读取全部快照；无法解析或结构不符的文件会被改名为 .bad 隔离。 */
export function readSnapshots({ limit = Infinity } = {}) {
  migrateLegacySnapshots()
  const dir = sessionsDir()
  let files = []
  for (const sub of modDirs()) {
    try {
      for (const name of fs.readdirSync(path.join(dir, sub))) {
        if (name.endsWith('.json')) files.push({ name, file: path.join(dir, sub, name) })
      }
    } catch { /* 子目录在读取期间被删除 */ }
  }
  // 启动恢复只需要检查最近的少量存档。先按文件更新时间排序、再读取正文，
  // 避免存档很多或单局很大时把整个目录一次性解析进内存。
  if (Number.isFinite(limit)) {
    const count = Math.max(0, Math.floor(limit))
    files = files
      .map(item => {
        try { return { ...item, mtimeMs: fs.statSync(item.file).mtimeMs } }
        catch { return { ...item, mtimeMs: 0 } }
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, count)
  }
  const out = []
  for (const { name, file } of files) {
    const record = readSnapshotFile(file, name)
    if (record) out.push(record)
  }
  return out
}

/** 按编号只读取一局，避免读取／载入／删除单局时扫描所有存档正文。 */
export function readSnapshot(sessionId) {
  const id = safeId(sessionId)
  if (!id) return null
  const file = existingFiles(id)[0]
  if (!file) return null
  return readSnapshotFile(file, id + '.json')
}

function readSnapshotFile(file, name) {
  try {
    const record = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!record || record.schema !== SCHEMA || !record.session || !record.session.sessionId) throw new Error('快照结构不符')
    if (name !== record.session.sessionId + '.json') throw new Error('文件名与对局编号不一致')
    return record
  } catch (err) {
    try { fs.renameSync(file, file + '.bad') } catch { /* 尽力而为 */ }
    console.warn('  [sessions] 跳过无法解析的存档 ' + name + '：' + String(err && err.message ? err.message : err))
    return null
  }
}

/**
 * 迁移／修复前备份原存档：复制为 <sessionId>.json.<label>.bak（不以 .json 结尾，不会被当作存档读取）。
 * 返回备份路径；原文件不存在时返回 null。
 */
export function backupSnapshot(sessionId, label = 'backup') {
  const file = snapshotPath(sessionId)
  if (!fs.existsSync(file)) return null
  const tag = String(label).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || 'backup'
  const target = file + '.' + tag + '-' + new Date().toISOString().replace(/[:.]/g, '-') + '.bak'
  fs.copyFileSync(file, target, fs.constants.COPYFILE_EXCL)
  return target
}

export function deleteSnapshot(sessionId) {
  try {
    const id = safeId(sessionId)
    if (!id) throw new Error('非法对局编号')
    for (const file of existingFiles(id)) fs.rmSync(file, { force: true })
    return true
  } catch { return false }
}

/** 清理超过 maxAgeMs 的存档，返回删除数量。 */
export function pruneSnapshots(maxAgeMs) {
  if (!(maxAgeMs > 0)) return 0
  const cutoff = Date.now() - maxAgeMs
  let removed = 0
  for (const record of readSnapshots()) {
    const savedAt = Date.parse(record.savedAt)
    if (Number.isFinite(savedAt) && savedAt < cutoff && deleteSnapshot(record.session.sessionId)) removed++
  }
  return removed
}

export function ttlMsFromEnv() {
  const raw = Number(process.env.BOARDGAME_PERSIST_TTL_DAYS)
  const days = Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_TTL_DAYS
  return days * 24 * 60 * 60 * 1000
}
