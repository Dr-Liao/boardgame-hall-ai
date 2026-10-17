// 最小 ZIP 读写：发布包打包与自动更新解压共用，不依赖第三方库。
//
// 只支持 stored(0) / deflate(8) 与非 ZIP64 归档（单包 < 4 GB、条目 < 65535），
// 足以覆盖大厅程序包、运行时包与游戏包。解压时拒绝绝对路径、盘符和 .. 条目。

import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { crc32, deflateRawSync, inflateRaw } from 'node:zlib'

const inflateRawAsync = promisify(inflateRaw)

const STORED_EXTENSIONS = /\.(avif|gif|jpe?g|mp3|mp4|ogg|png|webp|woff2?|zip)$/i

/**
 * 把目录打成 ZIP。
 * prefix：归档内的顶层目录（如 'app-1.2.0'），为空时文件直接位于归档根部。
 * executable(relative)：返回 true 的文件写入 0755 权限位（macOS/Linux 解压后可执行）。
 * filter(relative)：返回 false 的文件跳过。
 */
export function zipDirectory(sourceRoot, destination, { prefix = '', executable = () => false, filter = () => true } = {}) {
  const files = listFiles(sourceRoot)
    .map(file => ({ file, relative: path.relative(sourceRoot, file).replaceAll('\\', '/') }))
    .filter(entry => filter(entry.relative))
  writeZip(destination, files.map(({ file, relative }) => ({
    name: prefix ? `${prefix}/${relative}` : relative,
    file,
    executable: executable(relative),
  })))
  return files.length
}

/** entries: [{ name, file?, data?, executable? }] */
export function writeZip(destination, entries) {
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  const output = fs.openSync(destination, 'w')
  const central = []
  let offset = 0
  try {
    for (const item of entries) {
      const name = Buffer.from(item.name)
      const source = item.data !== undefined ? Buffer.from(item.data) : fs.readFileSync(item.file)
      const stored = STORED_EXTENSIONS.test(item.name)
      const compressed = stored ? source : deflateRawSync(source, { level: 6 })
      const method = stored ? 0 : 8
      const checksum = crc32(source)
      const { date, time } = dosDateTime(item.file ? fs.statSync(item.file).mtime : new Date())
      if (compressed.length > 0xfffffffe || offset > 0xfffffffe) throw new Error('归档过大，当前 ZIP 写入器不支持 ZIP64。')
      const local = Buffer.alloc(30)
      local.writeUInt32LE(0x04034b50, 0)
      local.writeUInt16LE(20, 4)
      local.writeUInt16LE(0x0800, 6)
      local.writeUInt16LE(method, 8)
      local.writeUInt16LE(time, 10)
      local.writeUInt16LE(date, 12)
      local.writeUInt32LE(checksum, 14)
      local.writeUInt32LE(compressed.length, 18)
      local.writeUInt32LE(source.length, 22)
      local.writeUInt16LE(name.length, 26)
      fs.writeSync(output, local)
      fs.writeSync(output, name)
      fs.writeSync(output, compressed)

      const entry = Buffer.alloc(46)
      entry.writeUInt32LE(0x02014b50, 0)
      entry.writeUInt16LE(0x0314, 4)
      entry.writeUInt16LE(20, 6)
      entry.writeUInt16LE(0x0800, 8)
      entry.writeUInt16LE(method, 10)
      entry.writeUInt16LE(time, 12)
      entry.writeUInt16LE(date, 14)
      entry.writeUInt32LE(checksum, 16)
      entry.writeUInt32LE(compressed.length, 20)
      entry.writeUInt32LE(source.length, 24)
      entry.writeUInt16LE(name.length, 28)
      entry.writeUInt32LE(((item.executable ? 0o100755 : 0o100644) << 16) >>> 0, 38)
      entry.writeUInt32LE(offset, 42)
      central.push(entry, name)
      offset += local.length + name.length + compressed.length
    }
    const centralOffset = offset
    for (const part of central) {
      fs.writeSync(output, part)
      offset += part.length
    }
    const count = central.length / 2
    if (count > 0xfffe || offset > 0xfffffffe) throw new Error('归档过大，当前 ZIP 写入器不支持 ZIP64。')
    const end = Buffer.alloc(22)
    end.writeUInt32LE(0x06054b50, 0)
    end.writeUInt16LE(count, 8)
    end.writeUInt16LE(count, 10)
    end.writeUInt32LE(offset - centralOffset, 12)
    end.writeUInt32LE(centralOffset, 16)
    fs.writeSync(output, end)
  } finally {
    fs.closeSync(output)
  }
}

/** 归档来源：Buffer 或文件路径；按需读取片段，解压大文件时不必整包读入内存。 */
async function openSource(input) {
  if (Buffer.isBuffer(input)) {
    return { size: input.length, read: async (offset, length) => input.subarray(offset, offset + length), close: async () => {} }
  }
  const handle = await fs.promises.open(input, 'r')
  const { size } = await handle.stat()
  return {
    size,
    read: async (offset, length) => {
      const buffer = Buffer.alloc(length)
      const { bytesRead } = await handle.read(buffer, 0, length, offset)
      return buffer.subarray(0, bytesRead)
    },
    close: () => handle.close(),
  }
}

/** 读取中央目录，返回条目列表（不解压数据）。 */
export async function readZipEntries(input) {
  const source = await openSource(input)
  try { return await readEntries(source) } finally { await source.close() }
}

async function readEntries(source) {
  const tailStart = Math.max(0, source.size - 0xffff - 22)
  const tail = await source.read(tailStart, source.size - tailStart)
  let end = -1
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) { end = i; break }
  }
  if (end < 0) throw new Error('不是有效的 ZIP 文件')
  const count = tail.readUInt16LE(end + 10)
  const centralSize = tail.readUInt32LE(end + 12)
  const centralOffset = tail.readUInt32LE(end + 16)
  if (count === 0xffff || centralOffset === 0xffffffff) throw new Error('不支持 ZIP64 归档')
  if (centralOffset + centralSize > source.size) throw new Error('ZIP 中央目录损坏')
  const buffer = await source.read(centralOffset, centralSize)
  const entries = []
  let pointer = 0
  for (let i = 0; i < count; i++) {
    if (pointer + 46 > buffer.length || buffer.readUInt32LE(pointer) !== 0x02014b50) throw new Error('ZIP 中央目录损坏')
    const madeBy = buffer.readUInt16LE(pointer + 4)
    const flags = buffer.readUInt16LE(pointer + 8)
    const method = buffer.readUInt16LE(pointer + 10)
    const checksum = buffer.readUInt32LE(pointer + 16)
    const compressedSize = buffer.readUInt32LE(pointer + 20)
    const size = buffer.readUInt32LE(pointer + 24)
    const nameLength = buffer.readUInt16LE(pointer + 28)
    const extraLength = buffer.readUInt16LE(pointer + 30)
    const commentLength = buffer.readUInt16LE(pointer + 32)
    const external = buffer.readUInt32LE(pointer + 38)
    const localOffset = buffer.readUInt32LE(pointer + 42)
    const name = buffer.subarray(pointer + 46, pointer + 46 + nameLength).toString('utf8').replaceAll('\\', '/')
    if (flags & 1) throw new Error('不支持加密的 ZIP 条目: ' + name)
    const unixMode = (madeBy >> 8) === 3 ? external >>> 16 : 0
    entries.push({ name, method, checksum, compressedSize, size, localOffset, directory: name.endsWith('/'), executable: (unixMode & 0o111) !== 0 })
    pointer += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

export function safeRelative(name) {
  if (!name || name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.includes('\0')) return null
  const parts = name.split('/').filter(Boolean)
  if (!parts.length || parts.some(part => part === '..' || part === '.')) return null
  return parts.join('/')
}

/**
 * 解压 Buffer 或 ZIP 文件到 destination（目录须不存在或为空）。全程异步，大包解压期间大厅仍可响应请求。
 * prefix：要求全部条目位于该顶层目录下，并在解压时去掉它（如 'app-1.2.0'）。
 * filter(relative)：返回 false 的文件（去掉 prefix 后的相对路径）不解压。
 * 返回写出的文件数。
 */
export async function extractZip(input, destination, { prefix = '', filter = null } = {}) {
  const source = await openSource(input)
  try {
    const entries = await readEntries(source)
    const head = prefix ? prefix.replace(/\/+$/, '') + '/' : ''
    const targets = entries.map(entry => {
      const name = safeRelative(entry.name)
      if (!name) throw new Error('ZIP 包含非法路径: ' + entry.name)
      if (head && !(name + (entry.directory ? '/' : '')).startsWith(head)) throw new Error('ZIP 条目不在 ' + head + ' 目录下: ' + entry.name)
      const relative = head ? name.slice(head.length) : name
      if (relative && !entry.directory && filter && !filter(relative)) return null
      return relative ? path.join(destination, ...relative.split('/')) : null
    })
    await fs.promises.mkdir(destination, { recursive: true })
    let written = 0
    for (const [index, entry] of entries.entries()) {
      const target = targets[index]
      if (!target) continue
      if (entry.directory) { await fs.promises.mkdir(target, { recursive: true }); continue }
      const { data } = await readEntryData(source, entry)
      await fs.promises.mkdir(path.dirname(target), { recursive: true })
      await fs.promises.writeFile(target, data, { flag: 'wx' })
      if (entry.executable && process.platform !== 'win32') await fs.promises.chmod(target, 0o755)
      written++
    }
    return written
  } finally {
    await source.close()
  }
}

/**
 * 依次解压每个文件条目并回调 onFile(entry, data, dataOffset)；dataOffset 是压缩数据在归档内的起点，
 * 增量更新据此按 HTTP Range 只取单个文件。
 */
export async function walkZip(input, onFile) {
  const source = await openSource(input)
  try {
    for (const entry of await readEntries(source)) {
      if (entry.directory) continue
      const { data, dataOffset } = await readEntryData(source, entry)
      await onFile(entry, data, dataOffset)
    }
  } finally {
    await source.close()
  }
}

/** 解压 ZIP 压缩数据（method 0 / 8），不做校验。 */
export async function inflateEntry(method, raw) {
  if (method === 0) return raw
  if (method === 8) return inflateRawAsync(raw)
  throw new Error('不支持的 ZIP 压缩方式 ' + method)
}

async function readEntryData(source, entry) {
  const header = await source.read(entry.localOffset, 30)
  if (header.length < 30 || header.readUInt32LE(0) !== 0x04034b50) throw new Error('ZIP 本地文件头损坏: ' + entry.name)
  const dataOffset = entry.localOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28)
  const raw = await source.read(dataOffset, entry.compressedSize)
  const data = await inflateEntry(entry.method, raw).catch(error => { throw new Error(error.message + ': ' + entry.name) })
  if (data.length !== entry.size || crc32(data) !== entry.checksum) throw new Error('ZIP 条目校验失败: ' + entry.name)
  return { data, dataOffset }
}

export function listFiles(root) {
  const result = []
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const target = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(target)
      else if (entry.isFile()) result.push(target)
    }
  }
  walk(root)
  return result.sort((a, b) => a.localeCompare(b))
}

function dosDateTime(value) {
  const year = Math.max(1980, value.getFullYear())
  return {
    date: ((year - 1980) << 9) | ((value.getMonth() + 1) << 5) | value.getDate(),
    time: (value.getHours() << 11) | (value.getMinutes() << 5) | Math.floor(value.getSeconds() / 2),
  }
}
