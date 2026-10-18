import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { generateKeyPairSync, createHash, randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { writeZip, zipDirectory, extractZip } from '../../lib/zip.js'
import { signEnvelope, verifyEnvelope, keyIdOf } from '../../lib/signing.js'
import { readPointer, writePointer, markHealthy, cleanupInstall, mergeLooseAppFolder } from '../../lib/install.js'
import { createUpdater, platformKey } from '../../lib/updater.js'
import { buildIndex, indexFileName } from '../../lib/delta.js'
import { createStore } from '../../lib/store.js'
import { giteeUrl, fetchText, fetchRange, downloadVerified } from '../../lib/update-common.js'
import { loadMods } from '../../lib/mods.js'
import { createServer } from '../../lib/server.js'
import gobang from '../../games/gobang/index.js'

const projectRoot = fileURLToPath(new URL('../../', import.meta.url))

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return {
    pem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    trusted: [{ id: keyIdOf(publicKey), spki: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') }],
  }
}

const sha256 = data => createHash('sha256').update(data).digest('hex')

/**
 * 模拟 GitHub Release 下载地址：/<owner>/<repo>/releases/{latest/download|download/<tag>}/<file>
 * 支持单段 Range（ranges=false 时忽略 Range 回 200）；served 记录每个地址实际发出的字节数。
 */
async function fakeGithub(t) {
  const files = new Map()
  const served = new Map()
  const github = { ranges: true, served }
  const server = http.createServer((req, res) => {
    const route = decodeURIComponent(req.url)
    const body = files.get(route)
    if (body === undefined) { res.writeHead(404); return res.end('not found') }
    res.on('error', () => {})
    const range = github.ranges && /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '')
    const [start, end] = range ? [Number(range[1]), Math.min(Number(range[2]), body.length - 1)] : [0, body.length - 1]
    const part = body.subarray(start, end + 1)
    served.set(route, (served.get(route) || 0) + part.length)
    res.writeHead(range ? 206 : 200, { 'content-length': part.length, ...(range ? { 'content-range': `bytes ${start}-${end}/${body.length}` } : {}) })
    res.end(part)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}`
  process.env.BOARDGAME_GITHUB_BASE = base
  t.after(() => { delete process.env.BOARDGAME_GITHUB_BASE })
  return Object.assign(github, {
    base,
    put(route, body) { files.set(route, Buffer.isBuffer(body) ? body : Buffer.from(body)) },
    release(repo, tag, name, body, latest = true) {
      this.put(`/${repo}/releases/download/${tag}/${name}`, body)
      if (latest) this.put(`/${repo}/releases/latest/download/${name}`, body)
    },
    servedFor(repo, tag, name) { return served.get(`/${repo}/releases/download/${tag}/${name}`) || 0 },
  })
}

async function waitFor(check, label) {
  for (let i = 0; i < 200; i++) {
    const value = check()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('等待超时：' + label)
}

const DEMO_MOD = `export default {
  id: 'demo', name: '演示游戏', players: [2, 2], moveFormat: '{}',
  createState: () => ({ status: 'playing', winnerSeat: null, currentSeat: 0, moveCount: 0, revision: 0 }),
  validateMove: () => null, applyMove: () => [], describeState: () => '', legalMoves: () => [{}], moveToText: () => '',
}
`

test('ZIP：带顶层目录往返、中文文件名，并拒绝目录穿越', async t => {
  const dir = tempDir(t, 'hall-zip-')
  write(path.join(dir, 'src', 'a.txt'), 'hello'.repeat(1000))
  write(path.join(dir, 'src', '子目录', '卡图.png'), Buffer.from([1, 2, 3]))
  zipDirectory(path.join(dir, 'src'), path.join(dir, 'out.zip'), { prefix: 'app-1.0.0' })
  for (const [label, input] of [['文件', path.join(dir, 'out.zip')], ['内存', fs.readFileSync(path.join(dir, 'out.zip'))]]) {
    const target = path.join(dir, 'extracted-' + label)
    assert.equal(await extractZip(input, target, { prefix: 'app-1.0.0' }), 2)
    assert.equal(fs.readFileSync(path.join(target, 'a.txt'), 'utf8'), 'hello'.repeat(1000))
    assert.deepEqual([...fs.readFileSync(path.join(target, '子目录', '卡图.png'))], [1, 2, 3])
  }
  await assert.rejects(extractZip(path.join(dir, 'out.zip'), path.join(dir, 'x'), { prefix: 'app-2.0.0' }), /不在/)
  assert.ok(!fs.existsSync(path.join(dir, 'x')))

  writeZip(path.join(dir, 'evil.zip'), [{ name: 'ok.txt', data: 'ok' }, { name: '../evil.txt', data: 'x' }])
  await assert.rejects(extractZip(path.join(dir, 'evil.zip'), path.join(dir, 'evil')), /非法路径/)
  assert.ok(!fs.existsSync(path.join(dir, 'evil.txt')) && !fs.existsSync(path.join(dir, 'evil')))
})

test('签名清单：可信公钥通过，篡改、陌生公钥与未配置公钥均被拒绝', () => {
  const { pem, trusted } = keyPair()
  const other = keyPair()
  const text = signEnvelope({ kind: 'hall', version: '1.2.3' }, pem)
  assert.equal(verifyEnvelope(text, trusted).version, '1.2.3')
  const tampered = JSON.parse(text)
  tampered.payload = tampered.payload.replace('1.2.3', '9.9.9')
  assert.throws(() => verifyEnvelope(JSON.stringify(tampered), trusted), /签名无效/)
  assert.throws(() => verifyEnvelope(text, other.trusted), /签名无效/)
  assert.throws(() => verifyEnvelope(text, []), /公钥/)
})

test('Gitee 镜像：地址换算，按 Gitee → GitHub → 加速镜像取文件，内容无效换来源，分段下载跳过 Gitee', async t => {
  const gitee = { 'Me/Hall': 'me-cn/hall' }
  assert.equal(giteeUrl('https://github.com/me/hall/releases/latest/download/update-manifest.json', gitee), 'https://gitee.com/me-cn/hall/releases/download/latest/update-manifest.json')
  assert.equal(giteeUrl('https://github.com/me/hall/releases/download/v1.0.0/a.zip', gitee), 'https://gitee.com/me-cn/hall/releases/download/v1.0.0/a.zip')
  assert.equal(giteeUrl('https://raw.githubusercontent.com/me/hall/main/registry/index.json', gitee), 'https://gitee.com/me-cn/hall/raw/main/registry/index.json')
  assert.equal(giteeUrl('https://github.com/other/repo/releases/download/v1/a.zip', gitee), null)
  assert.equal(giteeUrl('http://127.0.0.1:1/me/hall/releases/download/v1/a.zip', gitee), null)

  const url = 'https://raw.githubusercontent.com/me/hall/main/registry/index.json'
  const seen = []
  const fakeFetch = responses => async target => {
    seen.push(target)
    const body = responses[target.startsWith('https://gitee.com/') ? 'gitee' : target.startsWith('https://ghfast.top/') ? 'mirror' : 'github']
    if (body instanceof Error) throw body
    return new Response(body.data, { status: body.status ?? 200, headers: body.headers })
  }
  const options = { mirror: 'https://ghfast.top/', gitee, parse: JSON.parse }
  assert.deepEqual(await fetchText(url, { ...options, fetchImpl: fakeFetch({ gitee: { data: '{"from":"gitee"}' } }) }), { from: 'gitee' })
  assert.deepEqual(seen, ['https://gitee.com/me-cn/hall/raw/main/registry/index.json'])

  seen.length = 0
  const result = await fetchText(url, { ...options, fetchImpl: fakeFetch({ gitee: { data: '<html>登录</html>' }, github: new Error('timeout'), mirror: { data: '{"from":"mirror"}' } }) })
  assert.deepEqual(result, { from: 'mirror' })
  assert.equal(seen.length, 3)

  seen.length = 0
  const zipUrl = 'https://github.com/me/hall/releases/download/v1.0.0/a.zip'
  const data = Buffer.from('0123456789')
  const range = await fetchRange(zipUrl, 2, 4, { gitee, fetchImpl: fakeFetch({ gitee: { data }, github: { data: data.subarray(2, 5), status: 206, headers: { 'content-range': 'bytes 2-4/10' } } }) })
  assert.equal(range.toString(), '234')
  assert.deepEqual(seen, [zipUrl])

  const dir = tempDir(t, 'gitee-')
  seen.length = 0
  const sha256 = createHash('sha256').update(data).digest('hex')
  await downloadVerified(zipUrl, path.join(dir, 'a.zip'), { sha256, size: data.length, gitee, fetchImpl: fakeFetch({ gitee: { data: 'not found', status: 404 }, github: { data } }) })
  assert.equal(fs.readFileSync(path.join(dir, 'a.zip')).toString(), '0123456789')
  assert.deepEqual(seen, ['https://gitee.com/me-cn/hall/releases/download/v1.0.0/a.zip', zipUrl])
})

test('版本指针：健康标记、清理旧版本与合并卡图资源包', t => {
  const root = tempDir(t, 'hall-pointer-')
  for (const dir of ['app-1.0.0', 'app-1.1.0', 'app-0.9.0', 'app-1.2.0.partial', 'runtime-22.0.0', 'runtime-21.0.0']) fs.mkdirSync(path.join(root, dir))
  fs.mkdirSync(path.join(root, 'user-data'))
  write(path.join(root, 'app-1.2.0.partial.zip'), 'interrupted')
  writePointer(root, { app: 'app-1.1.0', runtime: 'runtime-22.0.0', previousApp: 'app-1.0.0', previousRuntime: 'runtime-22.0.0', trial: '1', failed: '1.1.0,1.0.5' })
  assert.equal(readPointer(root).trial, '1')
  assert.equal(markHealthy(root), true)
  assert.deepEqual(readPointer(root), { app: 'app-1.1.0', runtime: 'runtime-22.0.0', previousApp: 'app-1.0.0', previousRuntime: 'runtime-22.0.0', failed: '1.0.5' })
  assert.equal(markHealthy(root), false)
  assert.deepEqual(cleanupInstall(root).sort(), ['app-0.9.0', 'app-1.2.0.partial', 'app-1.2.0.partial.zip', 'runtime-21.0.0'])
  assert.ok(fs.existsSync(path.join(root, 'user-data')) && fs.existsSync(path.join(root, 'app-1.0.0')))

  write(path.join(root, 'app', 'games', 'x', 'web', 'img', 'cards', '01.avif'), 'card')
  write(path.join(root, 'app-1.1.0', 'games', 'x', 'keep.txt'), 'new')
  write(path.join(root, 'app', 'games', 'x', 'keep.txt'), 'old')
  assert.equal(mergeLooseAppFolder(root), 1)
  assert.equal(fs.readFileSync(path.join(root, 'app-1.1.0', 'games', 'x', 'web', 'img', 'cards', '01.avif'), 'utf8'), 'card')
  assert.equal(fs.readFileSync(path.join(root, 'app-1.1.0', 'games', 'x', 'keep.txt'), 'utf8'), 'new')
  assert.ok(!fs.existsSync(path.join(root, 'app')))
})

const asset = (file, extra) => { const data = fs.readFileSync(file); return { file: path.basename(file), sha256: sha256(data), size: data.length, ...extra } }

async function buildHallRelease(dir, { version, runtimeVersion, pem, appMutator }) {
  const appRoot = path.join(dir, 'stage', 'app-' + version)
  write(path.join(appRoot, 'portable.mjs'), '')
  write(path.join(appRoot, 'server.js'), '')
  write(path.join(appRoot, 'package.json'), JSON.stringify({ version }))
  write(path.join(appRoot, 'games', 'demo', 'boardgame-mod.json'), JSON.stringify({ id: 'demo', version: '1.0.0', hallApi: 1, preserve: ['web/img/'] }))
  appMutator?.(appRoot)
  const appZip = path.join(dir, `BoardgameHall-app-${version}.zip`)
  zipDirectory(appRoot, appZip, { prefix: 'app-' + version })
  const indexFile = path.join(dir, indexFileName(path.basename(appZip)))
  fs.writeFileSync(indexFile, JSON.stringify(await buildIndex(appZip, { prefix: 'app-' + version })))
  const runtimeRoot = path.join(dir, 'stage', 'runtime-' + runtimeVersion)
  write(path.join(runtimeRoot, process.platform === 'win32' ? 'node.exe' : 'node'), 'node')
  const runtimeZip = path.join(dir, `BoardgameHall-runtime-${platformKey()}-${runtimeVersion}.zip`)
  zipDirectory(runtimeRoot, runtimeZip, { prefix: 'runtime-' + runtimeVersion })
  const manifest = signEnvelope({
    schema: 1, kind: 'hall', version, tag: 'v' + version, notes: '更新说明', minLauncher: 2,
    app: asset(appZip, { dir: 'app-' + version, index: asset(indexFile) }),
    runtimes: { [platformKey()]: asset(runtimeZip, { version: runtimeVersion, dir: 'runtime-' + runtimeVersion }) },
  }, pem)
  return { manifest, appZip, runtimeZip, indexFile }
}

function publishHall(github, release, version) {
  github.release('me/hall', 'v' + version, 'update-manifest.json', release.manifest)
  for (const file of [release.appZip, release.runtimeZip, release.indexFile]) github.release('me/hall', 'v' + version, path.basename(file), fs.readFileSync(file))
}

test('大厅更新：检查签名清单、下载程序与运行时、保留卡图缓存并切换到试运行', async t => {
  const github = await fakeGithub(t)
  const { pem, trusted } = keyPair()
  const work = tempDir(t, 'hall-release-')
  const root = tempDir(t, 'hall-install-')
  write(path.join(root, 'app-1.0.0', 'portable.mjs'), '')
  write(path.join(root, 'app-1.0.0', 'games', 'demo', 'web', 'img', 'cached.avif'), 'cached')
  write(path.join(root, 'runtime-22.0.0', process.platform === 'win32' ? 'node.exe' : 'node'), '')
  writePointer(root, { app: 'app-1.0.0', runtime: 'runtime-22.0.0' })

  publishHall(github, await buildHallRelease(work, { version: '1.1.0', runtimeVersion: '22.1.0', pem }), '1.1.0')

  const updater = createUpdater({ repo: 'me/hall', install: { root, launcher: 2 }, keys: trusted, version: '1.0.0', devCheckout: false, getSettings: () => ({ mirror: '' }) })
  assert.equal(updater.mode, 'portable')
  const checked = await updater.check()
  assert.equal(checked.error, null)
  assert.equal(checked.available, true)
  assert.equal(checked.latest.version, '1.1.0')
  updater.download()
  const done = await waitFor(() => ['ready', 'error'].includes(updater.status().download.state) && updater.status(), 'download')
  assert.equal(done.download.state, 'ready', done.download.error)
  assert.deepEqual(readPointer(root), { app: 'app-1.1.0', runtime: 'runtime-22.1.0', previousApp: 'app-1.0.0', previousRuntime: 'runtime-22.0.0', trial: '1' })
  assert.equal(fs.readFileSync(path.join(root, 'app-1.1.0', 'games', 'demo', 'web', 'img', 'cached.avif'), 'utf8'), 'cached')
  assert.ok(!fs.readdirSync(root).some(name => name.endsWith('.partial')))
})

test('大厅更新：陌生签名与被篡改的程序包都不会改动当前版本', async t => {
  const github = await fakeGithub(t)
  const { pem, trusted } = keyPair()
  const stranger = keyPair()
  const work = tempDir(t, 'hall-release-')
  const root = tempDir(t, 'hall-install-')
  write(path.join(root, 'app-1.0.0', 'portable.mjs'), '')
  writePointer(root, { app: 'app-1.0.0', runtime: 'runtime-22.0.0' })
  const options = { repo: 'me/hall', install: { root, launcher: 2 }, keys: trusted, version: '1.0.0', devCheckout: false, getSettings: () => ({ mirror: '' }) }

  const forged = await buildHallRelease(path.join(work, 'forged'), { version: '1.1.0', runtimeVersion: '22.0.0', pem: stranger.pem })
  github.release('me/hall', 'v1.1.0', 'update-manifest.json', forged.manifest)
  const rejected = await createUpdater(options).check()
  assert.match(rejected.error, /签名无效/)
  assert.equal(rejected.available, false)

  const genuine = await buildHallRelease(path.join(work, 'genuine'), { version: '1.1.0', runtimeVersion: '22.0.0', pem })
  github.release('me/hall', 'v1.1.0', 'update-manifest.json', genuine.manifest)
  const corrupted = Buffer.from(fs.readFileSync(genuine.appZip))
  const packageEntry = JSON.parse(fs.readFileSync(genuine.indexFile, 'utf8')).files.find(file => file.path === 'package.json')
  corrupted[packageEntry.offset] ^= 0xff
  github.release('me/hall', 'v1.1.0', path.basename(genuine.indexFile), fs.readFileSync(genuine.indexFile))
  github.release('me/hall', 'v1.1.0', path.basename(genuine.appZip), corrupted)
  const updater = createUpdater(options)
  assert.equal((await updater.check()).available, true)
  updater.download()
  const failed = await waitFor(() => updater.status().download.state === 'error' && updater.status(), 'download error')
  assert.match(failed.download.error, /校验失败/)
  assert.deepEqual(readPointer(root), { app: 'app-1.0.0', runtime: 'runtime-22.0.0' })
  assert.ok(!fs.existsSync(path.join(root, 'app-1.1.0')))
})

test('大厅增量更新：只下载变化的文件；服务器不支持分段或索引被篡改时退回完整包', async t => {
  const github = await fakeGithub(t)
  const { pem, trusted } = keyPair()
  const work = tempDir(t, 'hall-delta-release-')
  const audio = randomBytes(400 * 1024)
  const music = randomBytes(300 * 1024)
  const bigmod = dir => {
    write(path.join(dir, 'games', 'bigmod', 'index.js'), 'export default {}\n')
    write(path.join(dir, 'games', 'bigmod', 'web', 'music.ogg'), music)
  }
  const old = await buildHallRelease(path.join(work, 'old'), { version: '1.0.0', runtimeVersion: '22.0.0', pem, appMutator: dir => {
    write(path.join(dir, 'games', 'demo', 'web', 'audio', 'theme.ogg'), audio)
    write(path.join(dir, 'lib', 'rules.js'), 'export const rules = 1\n')
    bigmod(dir)
  } })
  const next = await buildHallRelease(path.join(work, 'next'), { version: '1.1.0', runtimeVersion: '22.0.0', pem, appMutator: dir => {
    write(path.join(dir, 'games', 'demo', 'web', 'audio', 'theme.ogg'), audio)
    write(path.join(dir, 'lib', 'rules.js'), 'export const rules = 2\n')
    write(path.join(dir, 'lib', 'added.js'), 'export const added = true\n')
    bigmod(dir)
  } })
  publishHall(github, next, '1.1.0')
  const appFile = path.basename(next.appZip)
  const fullSize = fs.statSync(next.appZip).size

  async function installOld({ lite = false } = {}) {
    const root = tempDir(t, 'hall-delta-install-')
    await extractZip(old.appZip, path.join(root, 'app-1.0.0'), { prefix: 'app-1.0.0', filter: lite ? relative => !relative.startsWith('games/bigmod/') : null })
    if (lite) write(path.join(root, 'edition.json'), JSON.stringify({ edition: 'hall-only', games: ['demo'] }))
    await extractZip(old.runtimeZip, path.join(root, 'runtime-22.0.0'), { prefix: 'runtime-22.0.0' })
    writePointer(root, { app: 'app-1.0.0', runtime: 'runtime-22.0.0' })
    return root
  }
  async function update(root) {
    const updater = createUpdater({ repo: 'me/hall', install: { root, launcher: 2 }, keys: trusted, version: '1.0.0', devCheckout: false, getSettings: () => ({ mirror: '' }) })
    const checked = await updater.check()
    assert.equal(checked.error, null)
    const before = github.servedFor('me/hall', 'v1.1.0', appFile)
    updater.download()
    const done = await waitFor(() => ['ready', 'error'].includes(updater.status().download.state) && updater.status(), 'download')
    assert.equal(done.download.state, 'ready', done.download.error)
    const app = path.join(root, 'app-1.1.0')
    assert.equal(fs.readFileSync(path.join(app, 'lib', 'rules.js'), 'utf8'), 'export const rules = 2\n')
    assert.equal(fs.readFileSync(path.join(app, 'lib', 'added.js'), 'utf8'), 'export const added = true\n')
    assert.ok(fs.readFileSync(path.join(app, 'games', 'demo', 'web', 'audio', 'theme.ogg')).equals(audio))
    assert.equal(JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf8')).version, '1.1.0')
    assert.equal(readPointer(root).app, 'app-1.1.0')
    assert.ok(!fs.readdirSync(root).some(name => name.includes('.partial')))
    return { checked, done, downloaded: github.servedFor('me/hall', 'v1.1.0', appFile) - before }
  }

  // 索引校验通过后会被缓存，所以先测被篡改的索引。
  const indexName = path.basename(next.indexFile)
  const tampered = JSON.parse(fs.readFileSync(next.indexFile, 'utf8'))
  tampered.files.find(file => file.path === 'lib/rules.js').sha256 = '0'.repeat(64)
  github.release('me/hall', 'v1.1.0', indexName, JSON.stringify(tampered))
  const forgedIndex = await update(await installOld())
  assert.equal(forgedIndex.done.download.mode, 'full')
  assert.equal(forgedIndex.checked.latest.size, fullSize)
  github.release('me/hall', 'v1.1.0', indexName, fs.readFileSync(next.indexFile))

  const delta = await update(await installOld())
  assert.equal(delta.done.download.mode, 'delta')
  assert.ok(delta.checked.latest.size < fullSize / 10, `估算下载量 ${delta.checked.latest.size} 应远小于完整包 ${fullSize}`)
  assert.equal(delta.checked.latest.fullSize, fullSize)
  assert.ok(delta.downloaded < fullSize / 10, `实际下载 ${delta.downloaded} 应远小于完整包 ${fullSize}`)

  // 纯大厅版：本地没有 bigmod，edition.json 只列出 demo，更新时 bigmod 不下载也不解压。
  const liteRoot = await installOld({ lite: true })
  const lite = await update(liteRoot)
  assert.equal(lite.done.download.mode, 'delta')
  assert.ok(lite.checked.latest.size < 10 * 1024, '纯大厅版不应计入 bigmod 的数据')
  assert.ok(!fs.existsSync(path.join(liteRoot, 'app-1.1.0', 'games', 'bigmod')))
  assert.ok(fs.existsSync(path.join(liteRoot, 'app-1.1.0', 'games', 'demo', 'web', 'audio', 'theme.ogg')))

  github.ranges = false
  const noRange = await update(await installOld())
  assert.equal(noRange.done.download.mode, 'full')
  assert.ok(noRange.downloaded >= fullSize)
  const liteFullRoot = await installOld({ lite: true })
  assert.equal((await update(liteFullRoot)).done.download.mode, 'full')
  assert.ok(!fs.existsSync(path.join(liteFullRoot, 'app-1.1.0', 'games', 'bigmod')), '整包退回时同样跳过未内置的游戏')
})

const MOD_AUDIO = randomBytes(200 * 1024)

async function publishMod(github, work, { version, hallApi = 1, pem }) {
  const dir = path.join(work, 'mod-' + version)
  write(path.join(dir, 'index.js'), DEMO_MOD)
  write(path.join(dir, 'web', 'audio', 'theme.ogg'), MOD_AUDIO)
  write(path.join(dir, 'boardgame-mod.json'), JSON.stringify({ id: 'demo', name: '演示游戏', version, hallApi, preserve: ['web/img/'] }))
  const file = `demo-${version}.zip`
  zipDirectory(dir, path.join(work, file))
  const index = path.join(work, indexFileName(file))
  fs.writeFileSync(index, JSON.stringify(await buildIndex(path.join(work, file))))
  const manifest = signEnvelope({ schema: 1, kind: 'mod', id: 'demo', name: '演示游戏', version, hallApi, tag: 'v' + version, ...asset(path.join(work, file)), index: asset(index) }, pem)
  github.release('me/demo-game', 'v' + version, 'boardgame-mod.release.json', manifest)
  github.release('me/demo-game', 'v' + version, file, fs.readFileSync(path.join(work, file)))
  github.release('me/demo-game', 'v' + version, path.basename(index), fs.readFileSync(index))
  return fs.statSync(path.join(work, file)).size
}

test('游戏商店：新游戏安装后立即可用，更新需重启，旧版本在启动时清理', async t => {
  const github = await fakeGithub(t)
  const { pem, trusted } = keyPair()
  const work = tempDir(t, 'hall-store-release-')
  const userDir = tempDir(t, 'hall-store-mods-')
  const emptyBuiltin = tempDir(t, 'hall-store-builtin-')
  github.put('/registry.json', JSON.stringify({ schema: 1, games: [{ id: 'demo', repo: 'me/demo-game', name: '演示游戏', coverEmoji: '🧪' }, { id: 'Bad Id', repo: 'x/y' }] }))
  await publishMod(github, work, { version: '1.0.0', pem })

  const mods = []
  const store = createStore({ mods, registryUrl: github.base + '/registry.json', keys: trusted, userDir, getSettings: () => ({ mirror: '' }) })
  let status = await store.check()
  assert.equal(status.registry.error, null)
  assert.deepEqual(status.games.map(game => game.id), ['demo'])
  assert.equal(status.games[0].updateAvailable, true)
  store.install('demo')
  status = await waitFor(() => store.status().games[0].state !== 'installing' && store.status(), 'install')
  assert.equal(status.games[0].error, null)
  assert.equal(mods.length, 1)
  assert.deepEqual({ ...mods[0].package, dir: undefined }, { version: '1.0.0', source: 'user', dir: undefined, hallApi: 1 })
  assert.equal(status.games[0].restartRequired, false)
  write(path.join(userDir, 'demo', '1.0.0', 'web', 'img', 'cached.avif'), 'cached')

  const fullSize = await publishMod(github, work, { version: '1.1.0', pem })
  status = await store.check()
  assert.equal(status.games[0].latest.fullSize, fullSize)
  assert.ok(status.games[0].latest.size < fullSize / 5, '已安装旧版本时应显示增量下载量')
  store.install('demo')
  status = await waitFor(() => store.status().games[0].state !== 'installing' && store.status(), 'update')
  assert.equal(status.games[0].error, null)
  assert.ok(github.servedFor('me/demo-game', 'v1.1.0', 'demo-1.1.0.zip') < fullSize / 5, '更新只应下载变化的文件')
  assert.ok(fs.readFileSync(path.join(userDir, 'demo', '1.1.0', 'web', 'audio', 'theme.ogg')).equals(MOD_AUDIO))
  assert.equal(status.games[0].restartRequired, true)
  assert.equal(mods[0].package.version, '1.0.0')
  assert.equal(fs.readFileSync(path.join(userDir, 'demo', '1.1.0', 'web', 'img', 'cached.avif'), 'utf8'), 'cached')

  const reloaded = await loadMods({ builtinDir: emptyBuiltin, userDir })
  assert.equal(reloaded[0].package.version, '1.1.0')
  createStore({ mods: reloaded, registryUrl: null, keys: trusted, userDir }).cleanup()
  assert.deepEqual(fs.readdirSync(path.join(userDir, 'demo')), ['1.1.0'])

  await publishMod(github, work, { version: '2.0.0', hallApi: 99, pem })
  status = await store.check()
  assert.equal(status.games[0].needsHallUpdate, true)
  assert.equal(status.games[0].updateAvailable, false)
  assert.throws(() => store.install('demo'), /更新大厅/)

  const restarted = createStore({ mods: reloaded, registryUrl: null, keys: trusted, userDir })
  restarted.uninstall('demo')
  assert.equal(reloaded.length, 0)
  assert.ok(!fs.existsSync(path.join(userDir, 'demo')))
})

test('加载器：同 id 取兼容的最高版本，内置同版本优先，接口版本过高的下载版被跳过', async t => {
  const builtin = tempDir(t, 'hall-loader-builtin-')
  const userDir = tempDir(t, 'hall-loader-user-')
  write(path.join(builtin, 'demo', 'index.js'), DEMO_MOD)
  write(path.join(builtin, 'demo', 'boardgame-mod.json'), JSON.stringify({ id: 'demo', version: '1.0.0', hallApi: 1 }))
  write(path.join(userDir, 'demo', '1.0.0', 'index.js'), DEMO_MOD)
  write(path.join(userDir, 'demo', '1.0.0', 'boardgame-mod.json'), JSON.stringify({ id: 'demo', version: '1.0.0', hallApi: 1 }))
  write(path.join(userDir, 'demo', '3.0.0', 'index.js'), DEMO_MOD)
  write(path.join(userDir, 'demo', '3.0.0', 'boardgame-mod.json'), JSON.stringify({ id: 'demo', version: '3.0.0', hallApi: 99 }))
  const mods = await loadMods({ builtinDir: builtin, userDir })
  assert.equal(mods.length, 1)
  assert.equal(mods[0].package.source, 'builtin')
  assert.equal(mods[0].package.version, '1.0.0')
})

test('更新接口：只接受本机 JSON 请求，非免安装环境拒绝重启', async t => {
  const home = tempDir(t, 'hall-updates-api-')
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(() => { if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous })
  const updater = createUpdater({ repo: 'me/hall', install: null, keys: [], version: '1.0.0', devCheckout: true })
  const store = createStore({ mods: [gobang], registryUrl: null, keys: [], userDir: path.join(home, 'mods') })
  const server = createServer({ mods: [gobang], persist: false, updates: { updater, store, onRestart: () => assert.fail('不应重启') } })
  await server.ready
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  const base = `http://127.0.0.1:${server.address().port}/api`

  const view = await (await fetch(base + '/updates')).json()
  assert.equal(view.ok, true)
  assert.equal(view.hall.mode, 'dev')
  assert.equal(view.restartable, false)
  assert.deepEqual(view.settings, { autoCheck: true, mirror: '' })
  assert.equal((await fetch(base + '/updates/check', { method: 'POST', body: '{}' })).status, 415)
  assert.equal((await fetch(base + '/updates', { headers: { origin: 'https://evil.example' } })).status, 403)

  const post = (route, body) => fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json())
  assert.match((await post('/updates/restart', {})).error, /手动/)
  assert.equal((await post('/updates/settings', { autoCheck: false, mirror: 'https://ghfast.top/' })).settings.mirror, 'https://ghfast.top/')
  assert.match((await post('/updates/settings', { mirror: 'ftp://bad' })).error, /镜像/)
  assert.match((await post('/store/uninstall', { id: 'gobang' })).error, /没有可卸载/)
})

const csc = process.platform === 'win32' ? path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe') : null
const gitBash = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : '/bin/bash'

/** 按协议准备两个版本：每个 portable.mjs 把自己的名字追加到 log.txt，再按 behavior 退出。 */
function prepareLauncherRoot(root, nodeName, behaviors) {
  const runtime = path.join(root, 'runtime-22.0.0')
  fs.mkdirSync(runtime, { recursive: true })
  try { fs.linkSync(process.execPath, path.join(runtime, nodeName)) } catch { fs.copyFileSync(process.execPath, path.join(runtime, nodeName)) }
  for (const [version, behavior] of Object.entries(behaviors)) {
    write(path.join(root, 'app-' + version, 'portable.mjs'), `
import fs from 'node:fs'
import path from 'node:path'
const root = process.env.BOARDGAME_INSTALL_ROOT
fs.appendFileSync(path.join(root, 'log.txt'), ${JSON.stringify(version)} + ':' + process.env.BOARDGAME_LAUNCHER + ':' + path.basename(process.env.DSH_HOME) + '\\n')
${behavior}
`)
  }
}

function launcherCases(run) {
  return async t => {
    await t.test('新版本试运行失败时回滚到上一版本并记录失败版本', () => {
      const root = tempDir(t, 'hall-launcher-')
      run.prepare(root, { '1.0.0': 'process.exit(0)', '1.1.0': 'process.exit(3)' })
      writePointer(root, { app: 'app-1.1.0', runtime: 'runtime-22.0.0', previousApp: 'app-1.0.0', previousRuntime: 'runtime-22.0.0', trial: '1' })
      assert.equal(run.exec(root), 0)
      assert.equal(fs.readFileSync(path.join(root, 'log.txt'), 'utf8'), '1.1.0:2:user-data\n1.0.0:2:user-data\n')
      assert.deepEqual(readPointer(root), { app: 'app-1.0.0', runtime: 'runtime-22.0.0', failed: '1.1.0' })
    })
    await t.test('退出码 75 时按新指针重启', () => {
      const root = tempDir(t, 'hall-launcher-')
      run.prepare(root, {
        '1.0.0': `fs.writeFileSync(path.join(root, 'current.ini'), 'app=app-1.1.0\\nruntime=runtime-22.0.0\\n'); process.exit(75)`,
        '1.1.0': 'process.exit(0)',
      })
      writePointer(root, { app: 'app-1.0.0', runtime: 'runtime-22.0.0' })
      assert.equal(run.exec(root), 0)
      assert.equal(fs.readFileSync(path.join(root, 'log.txt'), 'utf8'), '1.0.0:2:user-data\n1.1.0:2:user-data\n')
    })
    await t.test('没有指针时选择最高版本；已健康的版本崩溃不回滚', () => {
      const root = tempDir(t, 'hall-launcher-')
      run.prepare(root, { '1.0.0': 'process.exit(0)', '1.10.0': 'process.exit(4)', '1.9.0': 'process.exit(0)' })
      assert.equal(run.exec(root), 4)
      assert.equal(fs.readFileSync(path.join(root, 'log.txt'), 'utf8'), '1.10.0:2:user-data\n')
    })
  }
}

test('Windows 启动器：回滚、重启与版本选择', { skip: !csc || !fs.existsSync(csc) ? '需要 Windows .NET Framework C# 编译器' : false }, async t => {
  const build = tempDir(t, 'hall-launcher-build-')
  const exe = path.join(build, 'launcher.exe')
  const compiled = spawnSync(csc, ['/nologo', '/codepage:65001', '/target:exe', '/platform:x64', '/out:' + exe, path.join(projectRoot, 'tools', 'windows', 'Launcher.cs')], { encoding: 'utf8' })
  assert.equal(compiled.status, 0, compiled.stdout)
  await launcherCases({
    prepare: (root, behaviors) => {
      prepareLauncherRoot(root, 'node.exe', behaviors)
      fs.copyFileSync(exe, path.join(root, '桌游大厅.exe'))
    },
    exec: root => spawnSync(path.join(root, '桌游大厅.exe'), [], { input: '', windowsHide: true }).status,
  })(t)
})

test('macOS 启动脚本：回滚、重启与版本选择', { skip: !fs.existsSync(gitBash) ? '需要 bash' : false }, async t => {
  await launcherCases({
    prepare: (root, behaviors) => {
      prepareLauncherRoot(root, process.platform === 'win32' ? 'node.exe' : 'node', behaviors)
      fs.copyFileSync(path.join(projectRoot, 'tools', 'macos', 'launcher.command'), path.join(root, 'launcher.command'))
    },
    exec: root => spawnSync(gitBash, [path.join(root, 'launcher.command')], {
      input: '',
      env: { ...process.env, BOARDGAME_NODE_NAME: process.platform === 'win32' ? 'node.exe' : 'node' },
    }).status,
  })(t)
})
