// 桌游 Mod 插件加载器
//
// 每个桌游 = 一个独立插件（相当于 mod），放在 games/<id>/index.js。
// 大厅启动时自动扫描 games/ 目录并逐个动态 import，无需修改大厅本体。
// 新增一款桌游：新建 games/<新id>/index.js，按下方接口导出对象即可。
//
// 在「全 agent」架构下，Mod 只负责两件事：
//   1. 游戏规则（创建状态 / 校验落子 / 应用落子）；
//   2. 向 AI/agent 暴露一套接口（描述棋局 / 落子格式 / 合法落点 / 落子记法）。
// Mod 完全不感知 LLM 的存在；AI 的落子与台词都由 lib/agent 里的模型产出。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------------------
// Mod 接口（一份 Mod 模块 default-exports 一个对象）
// ---------------------------------------------------------------------------
//
// 元数据（大厅展示 / 开设房间用）：
//   id            string          唯一 id（建议与目录名一致）
//   name          string          中文名
//   nameEn        string          英文名（可选）
//   players       [min, max]      玩家人数区间（含 AI 座位）
//   seats         number          总座位数（1 名玩家 + seats-1 个 AI；当前仅支持双人对局 =2）
//   cover         string          封面 CSS 背景（linear-gradient）
//   coverEmoji    string          封面 emoji
//   description   string          一句话规则说明（也会被写进 agent 的 system prompt）
//   tags          string[]        标签（如 ["棋类", "双人"]）
//
// 设置（大厅会自动注入「对手 AI」座位，专属设置在这里追加）：
//   settingsSpec  Array           专属设置项 [{ key, type:'select', label, default, options:[{value,label}] }]
//   defaults      object          专属设置默认值
//
// 客户端渲染描述：
//   render        { kind:'board', size, pieceStyle:'stone'|'mark' }
//                 kind='board' 表示方格棋盘；单元格值统一用 'black'/'white'。
//
// 游戏规则（纯规则，与 AI 无关）：
//   createState(settings, players) -> state
//       创建初始对局状态。state 顶层必须含标准字段：
//         status: 'playing' | 'over' | 'draw'
//         winnerSeat: number|null
//         currentSeat: number（当前行动座位）
//         moveCount: number
//         revision: number（核心维护，初始 0，每个成功事务递增，重开不倒退）
//       状态须支持 structuredClone；其余字段（如 board）由 Mod 自由定义。
//   decisionSeat(state) -> number|null（可选，纯查询）
//       当前应答座位；null 表示无待决座位。未实现时回退 state.currentSeat。
//   viewState(state, seat) -> object（可选，同步观察者投影）
//       HTTP 响应按人类座位投影状态副本，Mod 负责剔除隐藏信息和内部执行上下文。
//       返回对象保留客户端需要的标准字段；核心附加 revision，未实现时兼容原状态。
//   viewEvents(events, seat) -> event[]（可选，同步观察者事件投影）
//   agentActionMessage({ before, after, seat, move, speech }) -> string（可选）
//       AI 合法动作提交后发送公开桌聊；只追加事件，不触发聊天回复或额外模型调用。
//       HTTP 响应及模型历史按观察者过滤事件副本。
//       投影不改变权威状态；未指定观察者或未实现时保留原数据。
//   agentActionSpeechFrequency({ settings, before, after, events, seat, move, revision }) -> 0..100（可选）
//       控制已提交 AI 动作是否发布 speech / action chat；大厅用对局种子和 revision 做稳定采样。
//   agentReactionTriggers({ settings, before, after, events, seat, move, revision }) -> trigger[]（可选）
//       从已提交事务生成只读角色回应。trigger 可含 key、kind、title、context、frequency、
//       audience:'one'|'all' 与 preferredSeat；回应只追加 reaction chat，不修改规则状态或备忘。
//   validateMove(state, seat, move) -> string|null
//       纯查询，返回 null 表示合法，字符串表示错误；人类、模型和兜底共用。
//   applyMove(state, seat, move) -> events
//       同步应用动作（原地修改传入的事务副本），返回事件数组。
//       核心在 validateMove 与 applyMove 均成功后才提交状态、revision 和事件。
//       move 事件建议带 move 字段便于记法展示：{ type:'move', seat, move, x?, y? }
//       以及 { type:'win', seat } | { type:'draw' }
//
// ★ 给 AI/agent 的接口（Mod 不感知 LLM，只提供这些纯数据接口）：
//   moveFormat    string          落子 JSON 格式说明，如 '{"x":0-14,"y":0-14}'
//   describeState(state, seat) -> string
//       按观察者座位提供当前局面；旧 Mod 可以忽略第二参数。
//   chatContext(state, seat) -> string（可选）
//       仅追加到战术讨论 prompt 的额外背景（如剧情梗概），不进入行动决策 prompt。
//   legalMoves(state, seat) -> move[]   应答座位的合法动作，兜底按顺序校验选择
//   moveToText(move) -> string    落子的人类可读记法，如 "(7,7)"（对局进程展示用）
//
//   ★ 可选：让「多步回合」与「可复现兜底」更准确的两个钩子
//   moveCost(state, seat, move) -> number（可选，纯查询）
//       该动作消耗的行动点/资源数。用于在模型失败时避免兜底直接选「结束回合」这类
//       0 成本动作（有其它正成本动作时优先选它们）。未实现时按 1 处理。
//   decisionSeed(session, seat, step) -> string|number（可选，纯查询）
//       给模型失败时的确定性兜底提供种子。同一个种子 + 同一步 → 同一个兜底动作；
//       未实现时大厅按对局编号生成，仍不会退化成「恒选第一项」。
//       建议直接取对局自身的随机状态（如 state.rngState + state.revision）。
//
// ★ 可选：Mod 自带的浏览器资源与专属接口（大厅只做挂载与转发，不理解其语义）
//   clientData    object（纯 JSON，可用 getter）：经目录原样传给客户端的专属资料。
//   sessionPolicy(state) -> object：声明通用生命周期策略，省略时均为 false：
//       manualLoad / retainOnLeave / preserveInvalid：显式读档、退出保留、保留不兼容存档；
//       confirmDelete / detachOnDelete / manualSave：确认删除、删除后待另存、允许手动保存；
//       requireRevision / saveBeforeAi：动作必须带版本号、玩家动作提交后立即保存。
//       HTTP 对局响应的 lifecycle 字段供前端判断续玩和退出行为。
//   saveSummary(state) -> object：为存档列表追加专属摘要，不覆盖大厅标准字段。
//   saveCompatibilityFromState: true：由 saveCompatibilityError(state) 检查存档的规则、结构和数据版本，
//       不用静态展示资源版本决定兼容性，避免纯界面更新使存档失效。须同时实现该校验函数。
//   migrateState(state, { force }) -> { state, changes: string[] }（可选，存档向下兼容与修复）
//       纯函数：把旧存档状态迁移到当前版本，不修改入参；无需迁移时返回原对象和空 changes。
//       无法安全迁移时抛出错误（message 直接展示给玩家）。force=true 表示版本一致也执行修复检查。
//       大厅在存档列表中预览迁移结果，在读取或 POST /api/session/repair 时备份原档并写回。
//   commitChoiceBatch(session, seat, batch, { commitMove, moveError }) -> receipt（可选）
//       处理请求体 batchChoices 的一次性多步选择；大厅已校验版本号，Mod 须用 commitMove
//       在 session 草稿上逐步提交以保证原子性，非法输入用 moveError(message) 抛出。
//   actionsRemaining(state, seat) -> number|undefined：剩余行动点，供提示词与回合分界使用。
//   participantDescription(state, seat) -> string：玩家身份的游戏内补充说明。
//   agentPlanning { commit(session, seat, plan, before), view(session, observerSeat),
//                   prompt(session, seat), instruction, outputFormat }：
//       游戏负责计划的存储、有效期及私有信息过滤；大厅只负责模型调用和提交时机。
//   浏览器 createUI(host) 可返回 onOpenSetup、renderSetupModal、renderGame、renderOverlays、
//       isModalOpen、onDeactivate、onSetupChange(key, form)、setupSettings(form) 等接口。
//       只有当前游戏/开局界面显示该 Mod 的 overlays，大厅首页不挂载游戏专属工具。
//       onDeactivate 在未选中该游戏时调用，须幂等且不触发重绘，用于停止音频等资源。
//   web           { dir, client?, styles? }
//       dir     string  相对 games/<id>/ 的目录名（如 'web'），整目录挂到 /mods/<id>/
//       client  string  该目录下的浏览器 ES module（如 'catalog.js'），由前端按需 import
//       styles  string  该目录下的样式表（如 'style.css'），由前端按需插入
//       大厅只负责静态分发与目录边界校验；Mod 专属的图片、脚本、样式一律放在这里，
//       不要写进大厅的 public/，否则大厅与插件的边界会被打破。
//   resourceVersion() -> string|Promise<string>
//       Mod 自身静态资源的版本号，用于 API 的 immutable 缓存与失效判断。
//   handleApi({ method, path, searchParams }) -> { status?, body, immutable? } | null
//       处理 /api/mods/<id>/<path> 的只读查询；path 不含前缀，已解码。
//       返回 null 表示该路径不存在（大厅回 404）。抛出 RangeError/URIError 视为 400。
//       这里只允许下发静态资料，不得旁路对局状态或可用性校验。
//   cacheWebAsset({ relative, searchParams }) -> boolean|Promise<boolean>（可选）
//       仅在 Mod 静态文件不存在时调用；成功把资源写入 web.root 后返回 true，大厅随后按普通
//       静态文件重新读取。Mod 必须自行白名单校验路径与远程来源，不能把它作为通用代理。
// ---------------------------------------------------------------------------

export function getSessionPolicy(mod, state) {
  return mod?.sessionPolicy?.(state) || {}
}

export function getDecisionSeat(mod, state) {
  return typeof mod.decisionSeat === 'function' ? mod.decisionSeat(state) : state.currentSeat
}

export async function loadMods() {
  const dir = path.join(__dirname, '..', 'games')
  if (!fs.existsSync(dir)) {
    console.warn('  [mods] 未找到 games/ 目录')
    return []
  }
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  const mods = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const entryFile = path.join(dir, e.name, 'index.js')
    if (!fs.existsSync(entryFile)) continue
    try {
      const mod = (await import(pathToFileURL(entryFile).href)).default
      if (!mod) throw new Error('未导出 default 对象')
      validateMod(mod, e.name)
      resolveWeb(mod, path.join(dir, e.name))
      mods.push(mod)
      console.log('  [mods] ✔ ' + mod.name + '（' + (mod.id || e.name) + '）')
    } catch (err) {
      console.warn('  [mods] ✘ 加载 ' + e.name + ' 失败: ' + (err && err.message ? err.message : err))
    }
  }
  return mods
}

function validateMod(mod, dirName) {
  const missing = []
  if (!mod.id) missing.push('id')
  if (!mod.name) missing.push('name')
  if (!Array.isArray(mod.players)) missing.push('players')
  if (typeof mod.createState !== 'function') missing.push('createState')
  if (typeof mod.applyMove !== 'function') missing.push('applyMove')
  if (typeof mod.validateMove !== 'function') missing.push('validateMove')
  if (typeof mod.describeState !== 'function') missing.push('describeState')
  if (typeof mod.legalMoves !== 'function') missing.push('legalMoves')
  if (typeof mod.moveToText !== 'function') missing.push('moveToText')
  if (typeof mod.moveFormat !== 'string' || !mod.moveFormat) missing.push('moveFormat')
  if (mod.decisionSeat !== undefined && typeof mod.decisionSeat !== 'function') missing.push('decisionSeat (function)')
  if (mod.viewState !== undefined && typeof mod.viewState !== 'function') missing.push('viewState (function)')
  if (mod.viewEvents !== undefined && typeof mod.viewEvents !== 'function') missing.push('viewEvents (function)')
  if (mod.moveCost !== undefined && typeof mod.moveCost !== 'function') missing.push('moveCost (function)')
  if (mod.decisionSeed !== undefined && typeof mod.decisionSeed !== 'function') missing.push('decisionSeed (function)')
  if (mod.migrateState !== undefined && typeof mod.migrateState !== 'function') missing.push('migrateState (function)')
  if (mod.cacheWebAsset !== undefined && typeof mod.cacheWebAsset !== 'function') missing.push('cacheWebAsset (function)')
  if (mod.commitChoiceBatch !== undefined && typeof mod.commitChoiceBatch !== 'function') missing.push('commitChoiceBatch (function)')
  if (missing.length) throw new Error('缺少字段: ' + missing.join(', '))
}

/** 把 Mod 声明的 web 目录解析成绝对路径与挂载 URL；目录必须在该 Mod 自己的目录内。 */
function resolveWeb(mod, modDir) {
  if (!mod.web) return
  const { dir, client, styles } = mod.web
  if (typeof dir !== 'string' || !dir) throw new Error('web.dir 必须是目录名')
  const absolute = path.resolve(modDir, dir)
  const relative = path.relative(modDir, absolute)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('web.dir 必须位于 Mod 自身目录内')
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isDirectory()) throw new Error('web.dir 不存在: ' + dir)
  for (const [key, value] of Object.entries({ client, styles })) {
    if (value === undefined) continue
    if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(value) || value.includes('..')) throw new Error(`web.${key} 文件名非法: ` + value)
    if (!fs.existsSync(path.resolve(absolute, value))) throw new Error(`web.${key} 不存在: ` + value)
  }
  const mount = '/mods/' + mod.id
  mod.web = {
    ...mod.web,
    root: absolute,
    mount,
    clientUrl: client ? `${mount}/${client}` : null,
    stylesUrl: styles ? `${mount}/${styles}` : null,
  }
}
