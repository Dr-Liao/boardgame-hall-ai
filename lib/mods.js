// 桌游 Mod 插件加载器
//
// 每个桌游 = 一个独立插件（相当于 mod），放在 games/<id>/index.js。
// 大厅启动时自动扫描 games/ 目录并逐个动态 import，无需修改大厅本体。
// 新增一款桌游：新建 games/<新id>/index.js，按下方接口导出对象即可。
// 通过游戏商店分发的 Mod 另需 boardgame-mod.json（id / version / hallApi，见 docs/updates.md）。
//
// 在「全 agent」架构下，Mod 只负责两件事：
//   1. 游戏规则（创建状态 / 校验落子 / 应用落子）；
//   2. 向 AI/agent 暴露一套接口（描述棋局 / 落子格式 / 合法落点 / 落子记法）。
// 棋类 Mod 还可以额外提供「本地棋力」接口（战术说明 / 候选点 / 兜底 / 纠错），
// 这样即使模型失误或不可用，AI 也不会下出随机的棋。
// Mod 完全不感知 LLM 的存在；AI 的落子与台词都由 lib/agent 里的模型产出。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { HALL_API, HALL_API_MIN, compareVersions, hallApiSupported, isVersion } from './version.js'
import { SOURCE_LOCALE, normalizeLocale } from './i18n.js'
import { readModManifest } from './install.js'
import { userModsDir } from './update-common.js'

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
// 本地化（可选；docs/localization.md §7.1 / §7.6 / §8.2）：
//   i18n          object（纯 JSON，可选）
//       defaultLocale      string    游戏自己的默认语言。缺失/非法/不在 supportedLocales 中时回退：
//                                    支持 zh-CN 就用 zh-CN，否则用 supportedLocales[0]，并 console.warn。
//       supportedLocales   string[]  支持的语言（BCP 47 子集，最多 20 个）。加载时用 lib/i18n.js 的
//                                    normalizeLocale() 规范化、去重；可包含只有前端语言包、没有 messages 的语言。
//       messages           object    { [locale]: { name?, description?, tags?, aiSlotLabel?, aiSlotDescription?,
//                                     settings?: { [设置 key]: { label?, description?, options?: { [value]: label } } } } }
//                                     只允许覆盖展示文本：name/description/tags/aiSlotLabel/aiSlotDescription
//                                     与设置项的 label/description/options；tags 整体替换，不做合并；
//                                     settings 不允许改 type/default/players 等行为字段或选项集合。
//                                     messages 的 key 必须是 supportedLocales 的子集，超出范围的语言忽略并 warn。
//       加载成功后大厅把声明规范化为 mod.i18n = { defaultLocale, supportedLocales, messages }：
//       supportedLocales 已规范化/去重/截断，defaultLocale 一定在其中，messages 只保留合法语言。
//       没有声明 i18n 的旧 Mod 保持 mod.i18n === undefined（大厅按 source / legacy-name 分支处理，
//       不要补空对象）。结构性问题（非普通对象、supportedLocales 非法、messages 非对象等）→ warn 后
//       按「没有 i18n」继续加载：一个写错的翻译字段不能让游戏消失。i18n 内禁止函数与
//       __proto__ / constructor / prototype 键（防原型污染），非法内容被丢弃并 warn；数组只允许出现在 tags。
//   localize(locale) -> object|null（可选，Mod 顶层同步纯函数；不是 i18n.localize）
//       返回与 messages[locale] 同形状的动态文本覆盖，在静态 messages 之后应用，优先级最高。
//       必须同步：catalogView() 是同步渲染，不能 await；不得修改入参、不得做重 I/O。
//       抛错/异步返回值/非对象时大厅 console.warn 并忽略该次结果，不能让整个目录 500。
//       声明了但不是函数（含 async 函数）→ warn 后忽略，不影响 Mod 加载。
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
//   actingSeats(state) -> number[]（可选，纯查询）
//       此刻允许提交动作的全部座位，用于多人同时操作的阶段（如各自组卡）。
//       未实现时回退 [decisionSeat]；实现时应包含 decisionSeat。AI 按此列表依次行动。
//   seatLocalMove(state, seat, move) -> boolean（可选，纯查询）
//       返回 true 表示该动作只依赖提交座位自身的数据：版本号过期时，核心改为在最新状态上
//       重新 validateMove，通过即提交，而不是直接拒绝。用于同时操作阶段避免互相顶掉。
//   viewState(state, seat, options?) -> object（可选，同步观察者投影）
//       HTTP 响应按人类座位投影状态副本，Mod 负责剔除隐藏信息和内部执行上下文。
//       返回对象保留客户端需要的标准字段；核心附加 revision，未实现时兼容原状态。
//       第三参数（可选，兼容扩展）：P1.4 联机静态表。
//         options.includeStatic === false 时跳过 cards / investigatorDefs 两张公共静态表；
//           大厅会传入 options.publicCardCodes（Set，当前公共表已有卡号）与
//           options.publicCards（只读公共卡面表），自愈逻辑不要依赖空 view.cards：
//           补出的卡面里、不属于该观察者私有可见（本人手牌/牌库等）的放进返回值
//           view.cardsPatch（大厅并进会话公共静态表，版本变化后重发一次）；
//           属于观察者私有的放进 view.privateCards（只发给该观察者）。
//         options.includeStatic === false 时大厅传入的是权威 state 的浅拷贝：Mod 不得修改入参
//           （尤其嵌套对象），否则会污染权威状态；默认全量路径仍是深拷贝。
//         options.stateIsolated === true 时入参 state 是大厅已深度隔离的副本（P3.2 A1′）：
//           大厅每 revision 只 structuredClone 一次权威 state，多个席位视图共用同一份副本，
//           因此 Mod 视图字段可以浅拷贝、不必再逐字段深拷；但 Mod 同样不得修改入参（含嵌套对象），
//           也绝不能把入参的嵌套对象留在返回值里后再改它——返回值只读，由大厅序列化下发。
//   viewStateSharesState  boolean | () => boolean（可选，P3.2 A1′）
//       声明 viewState 可以接收上述共享隔离副本（options.stateIsolated === true）且不会修改它。
//       大厅仅在 BOARDGAME_ONLINE_SHARED_VIEW=1 时启用，失败模式永远是回退逐席位拷贝（变慢）。
//       未声明/返回 false 时大厅保持逐席位浅拷贝，行为完全不变。
//   staticTables(state) -> { cards, investigatorDefs }（可选，同步，P1.4）
//       返回会话级公共静态表；大厅开局/读档后只调用一次，之后按 staticVersion 缓存下发。
//       只能包含公共卡面：不得包含任何席位的私有信息（别人手牌/牌库/未揭示剧情等）。
//       必须返回与权威 state 解耦的独立副本（大厅会长期持有并合并 cardsPatch），且不得修改 state。
//       没有该能力的 Mod 行为完全不变（永远发全量视图）。
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
//   autoPassChoice({ state, seat, disabledCodes }) -> move|null（可选，自动跳过代答）
//       仅对「可跳过的可选窗口」（如 reaction/playerWindow/boost）返回一条普通 choose/skip；
//       disabledCodes 是该座位本机「已关闭提示」的卡号集合：发送者本人来自当前命令的
//       client.autoPass，其他在线座位来自房主按座位缓存的 prefs 同步（P1）。
//       大厅在命令的发布之前调用它，并用 commitMove 提交返回的 move（validateMove/applyMove/
//       actionLog 与玩家手点完全一致）；返回 null 表示不代答。未声明该能力 = 行为不变。
//       失败模式只能是「没省下客户端的一次请求」：判定/提交异常时窗口照常发布，客户端仍有兜底。
//   isDebugMove(move) -> boolean（可选）
//       标记「只能由调试控制台提交」的动作。普通 /move、自动代答、批量选择一旦夹带这类动作会
//       被大厅直接拒绝（DEBUG_ONLY），客人也无法借普通行动提交绕过房主限制。
//   debugCommand(session, seat, command) -> { move?: object|null, message?: string }（可选，调试控制台）
//       联机只允许房主调用，单机由本机真人座位调用；客人会被大厅以「此操作仅房主可用」拒绝。
//       session 是权威会话（含 state），mod 只能读、不得修改；command 是前端上传的 JSON
//       （建议 { text, targetSeat }，由 Mod 自行约定）。返回的 move 由大厅走 commitMove 事务提交
//       （validateMove/applyMove/revision/actionLog/事件/快照与玩家手点一致），move 为空表示只回
//       message、不改变状态（例如 help）。抛错时 message 直接展示给操作者。返回的 move 必须是
//       Mod 自己的 validateMove/applyMove 认识的合法动作；大厅不会把它加进 legalMoves。
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
//   ★ 可选：本地棋力（棋类 Mod 的战术兜底，让 AI 在模型不给力时也不「乱下」）
//   这些钩子都是纯查询，大厅不关心具体规则；五子棋、井字棋按此实现（见 games/gobang/engine.js）。
//   agentHint string
//       追加进 system prompt 的战术说明，如「先看能不能成五，再堵对手的四连」。
//   agentCandidates(state, seat) -> [{ move, note }]（可选，纯查询）
//       提示词里的「引擎建议」候选点，按强弱排序；note 是一句话理由，最多展示 6 个。
//       有了它，模型不必从空白棋盘里自己找棋型，落子质量会稳定很多。
//   agentFallback(state, seat) -> move|null（可选，纯查询）
//       模型调用失败或未配置模型时的兜底落点。返回 null 时回退到下面的通用兜底。
//       棋类应返回本地引擎的最佳手，而不是随机挑一个合法点。
//   refineMove(state, seat, move) -> move（可选，纯查询）
//       模型已经给出合法一手后的战术纠错，用于「必杀 / 必防」这类无争议的局面
//       （例如对手四连却去别处落子）。返回值必须通过 validateMove 且与原落点不同
//       才会生效，否则大厅保留模型原落点；实现时不要用它改掉有争议的创造性下法。
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
//       isModalOpen、onDeactivate、onSetupChange(key, form)、setupSettings(form)、onLocaleChange(locale) 等接口。
//       host.locale 是当前语言解析结果 { requested, resolved, defaultLocale, supportedLocales, matched,
//       fellBack, files }（docs/localization.md §8.1）：resolved 用于选游戏自己的词典，files 是
//       web.locales 生成的绝对 URL；旧版大厅可能没有 host.locale，Mod 必须防御（host.locale?.resolved || 'zh-CN'）。
//       大厅切换语言后会更新 host.locale 并调用 ui.onLocaleChange?.(host.locale)：必须同步、幂等、
//       只更新文案并重绘，不重置对局/不重新请求存档。host 还提供 openFeedback()：打开大厅内置的
//       反馈弹窗，Mod 可以在自己的标题栏放入口（可选）。
//       只有当前游戏/开局界面显示该 Mod 的 overlays，大厅首页不挂载游戏专属工具。
//       onDeactivate 在未选中该游戏时调用，须幂等且不触发重绘，用于停止音频等资源。
//   web           { dir, client?, styles?, locales? }
//       dir     string  相对 games/<id>/ 的目录名（如 'web'），整目录挂到 /mods/<id>/
//       client  string  该目录下的浏览器 ES module（如 'catalog.js'），由前端按需 import
//       styles  string  该目录下的样式表（如 'style.css'），由前端按需插入
//       locales object  可选：{ [locale]: '相对 dir 的语言包路径' }，如 { 'zh-CN': 'locales/zh-CN.js', en: 'locales/en.js' }
//                       路径规则与 client/styles 相同（不得含 '..'、不得越出 dir、文件必须存在）；
//                       越界/绝对路径/文件不存在属于路径安全问题，直接拒绝加载该 Mod，不做降级。
//                       key 必须是 supportedLocales 中的语言，否则忽略并 warn。合法时 resolveWeb() 生成
//                       mod.web.localeUrls = { [locale]: '/mods/<id>/<相对路径>' }（绝对 URL，供 catalog 的
//                       i18n.files / Mod 前端 host.locale.files 使用，前端不要自己拼 URL）。
//                       语言包是 ES module，default export 扁平对象（docs/localization.md §8.2）；
//                       大厅不替 Mod 加载/合并词典，只负责挂载与下发地址。
//       大厅只负责静态分发与目录边界校验；Mod 专属的图片、脚本、样式一律放在这里，
//       不要写进大厅的 public/，否则大厅与插件的边界会被打破。
//       浏览器按 /mods/<id>/ 解析相对导入，跨出该目录的 import（如 ../presentation/x.js）
//       会 404 并让整个 Mod 界面加载失败；模块之间只能在本目录内互相引用。
//   resourceVersion() -> string|Promise<string>
//       Mod 自身静态资源的版本号，用于 API 的 immutable 缓存与失效判断。
//   handleApi({ method, path, searchParams }) -> { status?, body, immutable? } | null
//       处理 /api/mods/<id>/<path> 的只读查询；path 不含前缀，已解码。
//       返回 null 表示该路径不存在（大厅回 404）。抛出 RangeError/URIError 视为 400。
//       这里只允许下发静态资料，不得旁路对局状态或可用性校验。
//   handleLocalApi({ method, path, searchParams, body }) -> { status?, body } | null（可选）
//       本机私有接口（如玩家个人资料库），先于 handleApi 匹配同一前缀；仅接受本机且同源的请求，
//       POST 须为 JSON（否则不进入本接口），响应不缓存。返回 null 时交给 handleApi。同样不得触碰对局状态。
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

export function getActingSeats(mod, state) {
  if (typeof mod.actingSeats === 'function') {
    const seats = mod.actingSeats(state)
    if (Array.isArray(seats)) return [...new Set(seats.filter(Number.isInteger))]
  }
  const seat = getDecisionSeat(mod, state)
  return Number.isInteger(seat) ? [seat] : []
}

// ---------------------------------------------------------------------------
// 加载来源
// ---------------------------------------------------------------------------
//
// 1. 内置：games/<id>/（随大厅发布）；
// 2. 下载：<DSH_HOME 或 ~/.dsh>/boardgame-hall/mods/<id>/<版本>/（游戏商店安装，见 lib/store.js）。
// 下载目录必须带 boardgame-mod.json（id / version / hallApi）；内置目录可选。
// 同一 id 取版本最高且 hallApi 兼容的候选，版本相同时内置优先；最高版本加载失败时回退到次高版本。
// 加载后的 Mod 会带上 mod.package = { version, source:'builtin'|'user', dir, hallApi }。

const BUILTIN_DIR = path.join(__dirname, '..', 'games')

export function modCandidates({ builtinDir = BUILTIN_DIR, userDir = userModsDir() } = {}) {
  const candidates = []
  if (fs.existsSync(builtinDir)) {
    for (const entry of fs.readdirSync(builtinDir, { withFileTypes: true })) {
      const dir = path.join(builtinDir, entry.name)
      if (!entry.isDirectory() || !fs.existsSync(path.join(dir, 'index.js'))) continue
      const manifest = readModManifest(dir)
      candidates.push({ id: manifest?.id || entry.name, version: isVersion(manifest?.version) ? manifest.version : '0.0.0',
        hallApi: manifest?.hallApi ?? HALL_API, source: 'builtin', dir })
    }
  }
  if (userDir && fs.existsSync(userDir)) {
    for (const idEntry of fs.readdirSync(userDir, { withFileTypes: true })) {
      if (!idEntry.isDirectory() || fs.existsSync(path.join(userDir, idEntry.name, '.uninstall'))) continue
      for (const versionEntry of fs.readdirSync(path.join(userDir, idEntry.name), { withFileTypes: true })) {
        if (!versionEntry.isDirectory() || !isVersion(versionEntry.name)) continue
        const dir = path.join(userDir, idEntry.name, versionEntry.name)
        const manifest = readModManifest(dir)
        if (!manifest || manifest.id !== idEntry.name || manifest.version !== versionEntry.name) continue
        if (!fs.existsSync(path.join(dir, 'index.js'))) continue
        candidates.push({ id: manifest.id, version: manifest.version, hallApi: manifest.hallApi, source: 'user', dir })
      }
    }
  }
  return candidates
}

/** 导入并校验单个 Mod 目录。 */
export async function loadModFrom(candidate) {
  const mod = (await import(pathToFileURL(path.join(candidate.dir, 'index.js')).href)).default
  if (!mod) throw new Error('未导出 default 对象')
  validateMod(mod, path.basename(candidate.dir))
  if (mod.id !== candidate.id) throw new Error('Mod id「' + mod.id + '」与清单 id「' + candidate.id + '」不一致')
  resolveWeb(mod, candidate.dir)
  mod.package = { version: candidate.version, source: candidate.source, dir: candidate.dir, hallApi: candidate.hallApi }
  return mod
}

export async function loadMods(options = {}) {
  const groups = new Map()
  for (const candidate of modCandidates(options)) {
    if (!hallApiSupported(candidate.hallApi)) {
      console.warn('  [mods] ✘ 跳过 ' + candidate.id + ' ' + candidate.version + '：需要大厅接口版本 ' + candidate.hallApi + '（当前支持 ' + HALL_API_MIN + '–' + HALL_API + '）')
      continue
    }
    if (!groups.has(candidate.id)) groups.set(candidate.id, [])
    groups.get(candidate.id).push(candidate)
  }
  if (!groups.size) console.warn('  [mods] 未找到任何桌游 Mod')
  const mods = []
  for (const list of groups.values()) {
    list.sort((a, b) => compareVersions(b.version, a.version) || (a.source === 'builtin' ? -1 : 1))
    for (const candidate of list) {
      try {
        const mod = await loadModFrom(candidate)
        mods.push(mod)
        console.log('  [mods] ✔ ' + mod.name + '（' + mod.id + (candidate.source === 'user' ? ' ' + candidate.version + '，已下载' : '') + '）')
        break
      } catch (err) {
        console.warn('  [mods] ✘ 加载 ' + candidate.id + (candidate.source === 'user' ? ' ' + candidate.version : '') + ' 失败: ' + (err && err.message ? err.message : err))
      }
    }
  }
  return mods
}

// ---------------------------------------------------------------------------
// 可选 i18n 的校验与规范化（docs/localization.md §7.1 / §7.6）
// ---------------------------------------------------------------------------
//
// 设计原则：
//   - 结构性问题只 warn 不抛错：翻译字段写错不能让游戏从大厅消失；
//   - 路径越界（web.locales）属于安全问题，必须硬失败（在 resolveWeb 里处理）；
//   - 校验后得到的 mod.i18n 是「已解析契约」：defaultLocale ∈ supportedLocales，
//     messages 只含 supportedLocales 中的语言，值只含允许覆盖的展示文本。
const I18N_MAX_LOCALES = 20
const I18N_TEXT_FIELDS = ['name', 'description', 'aiSlotLabel', 'aiSlotDescription']
const I18N_TOP_FIELDS = ['defaultLocale', 'supportedLocales', 'messages']
// 原型污染：这些 key 一律丢弃，绝不写到新对象上（JSON.parse 能造出 own 属性的 `__proto__`）。
const I18N_BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function warnMod(mod, area, message) {
  console.warn('  [mods] ' + ((mod && mod.id) || 'mod') + ' ' + area + '：' + message)
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** 只保留非空字符串（与 lib/i18n.js 的 textOr 语义一致：空串不是有效翻译）。 */
function i18nText(value) {
  return typeof value === 'string' && value.trim() ? value : null
}

function sanitizeI18nOptions(mod, locale, settingKey, options) {
  if (!isPlainObject(options)) {
    warnMod(mod, 'i18n', `messages.${locale}.settings.${settingKey}.options 必须是 { value: label } 普通对象，已忽略`)
    return null
  }
  const out = {}
  for (const valueKey of Object.keys(options)) {
    if (I18N_BLOCKED_KEYS.has(valueKey)) {
      warnMod(mod, 'i18n', `忽略原型污染键 messages.${locale}.settings.${settingKey}.options.${valueKey}`)
      continue
    }
    const label = i18nText(options[valueKey])
    if (label) out[valueKey] = label
  }
  return out
}

/** 设置项覆盖只保留 label / description / options 文本；结构非法时丢弃该设置项。 */
function sanitizeI18nSettings(mod, locale, settings) {
  if (!isPlainObject(settings)) return null
  const out = {}
  for (const key of Object.keys(settings)) {
    if (I18N_BLOCKED_KEYS.has(key)) {
      warnMod(mod, 'i18n', `忽略原型污染键 messages.${locale}.settings.${key}`)
      continue
    }
    const source = settings[key]
    if (!isPlainObject(source)) {
      warnMod(mod, 'i18n', `messages.${locale}.settings.${key} 必须是被覆盖文本的普通对象，已忽略`)
      continue
    }
    const item = {}
    for (const field of ['label', 'description']) {
      if (!Object.hasOwn(source, field)) continue
      const text = i18nText(source[field])
      if (text) item[field] = text
      else warnMod(mod, 'i18n', `messages.${locale}.settings.${key}.${field} 必须是非空字符串，已忽略`)
    }
    if (source.options !== undefined) {
      const options = sanitizeI18nOptions(mod, locale, key, source.options)
      if (options) item.options = options
    }
    if (Object.keys(item).length) out[key] = item
  }
  return out
}

/**
 * 规范化一种语言的展示文本层。
 * settings 结构明显非法（不是普通对象）时按契约丢弃整个语言并 warn；
 * 单个字段类型不对则只丢该字段。
 */
function sanitizeI18nLayer(mod, locale, layer) {
  if (!isPlainObject(layer)) {
    warnMod(mod, 'i18n', `messages.${locale} 必须是普通对象，已丢弃该语言`)
    return null
  }
  if (layer.settings !== undefined && !isPlainObject(layer.settings)) {
    warnMod(mod, 'i18n', `messages.${locale}.settings 必须是普通对象，已丢弃该语言`)
    return null
  }
  const out = {}
  for (const field of I18N_TEXT_FIELDS) {
    if (!Object.hasOwn(layer, field)) continue
    const text = i18nText(layer[field])
    if (text) out[field] = text
    else warnMod(mod, 'i18n', `messages.${locale}.${field} 必须是非空字符串，已忽略`)
  }
  if (Object.hasOwn(layer, 'tags')) {
    if (Array.isArray(layer.tags)) out.tags = layer.tags.filter((tag) => typeof tag === 'string' && tag.trim())
    else warnMod(mod, 'i18n', `messages.${locale}.tags 必须是字符串数组，已忽略`)
  }
  if (layer.settings !== undefined) {
    const settings = sanitizeI18nSettings(mod, locale, layer.settings)
    if (settings) out.settings = settings
  }
  for (const key of Object.keys(layer)) {
    if (I18N_BLOCKED_KEYS.has(key)) {
      warnMod(mod, 'i18n', `忽略原型污染键 messages.${locale}.${key}`)
      continue
    }
    if (I18N_TEXT_FIELDS.includes(key) || key === 'tags' || key === 'settings') continue
    warnMod(mod, 'i18n', `messages.${locale}.${key} 不是允许覆盖的展示字段，已忽略`)
  }
  return out
}

/**
 * 校验并规范化可选的 i18n；结构非法时删除 mod.i18n（等价于「没有 i18n」的旧 Mod）。
 * 成功后 mod.i18n = { defaultLocale, supportedLocales, messages }。
 */
function normalizeModI18n(mod) {
  if (mod.i18n === undefined) return
  const raw = mod.i18n
  if (!isPlainObject(raw)) {
    warnMod(mod, 'i18n', '必须是普通对象，已按没有 i18n 处理')
    delete mod.i18n
    return
  }
  if (!Array.isArray(raw.supportedLocales)) {
    warnMod(mod, 'i18n', 'supportedLocales 必须是数组，已按没有 i18n 处理')
    delete mod.i18n
    return
  }
  const supported = []
  for (const value of raw.supportedLocales) {
    const tag = normalizeLocale(value)
    if (!tag) {
      warnMod(mod, 'i18n', 'supportedLocales 含非法语言「' + String(value) + '」，已忽略')
      continue
    }
    if (!supported.includes(tag)) supported.push(tag)
  }
  if (!supported.length) {
    warnMod(mod, 'i18n', 'supportedLocales 为空或没有合法语言，已按没有 i18n 处理')
    delete mod.i18n
    return
  }
  if (supported.length > I18N_MAX_LOCALES) {
    warnMod(mod, 'i18n', `supportedLocales 超过 ${I18N_MAX_LOCALES} 个，只保留前 ${I18N_MAX_LOCALES} 个`)
    supported.length = I18N_MAX_LOCALES
  }
  let defaultLocale = normalizeLocale(raw.defaultLocale)
  if (!defaultLocale || !supported.includes(defaultLocale)) {
    const fallback = supported.includes(SOURCE_LOCALE) ? SOURCE_LOCALE : supported[0]
    warnMod(mod, 'i18n', 'defaultLocale「' + String(raw.defaultLocale) + '」缺失、非法或不在 supportedLocales 中，已回退到 ' + fallback)
    defaultLocale = fallback
  }
  const messages = {}
  if (raw.messages !== undefined) {
    if (!isPlainObject(raw.messages)) {
      warnMod(mod, 'i18n', 'messages 必须是普通对象，已按没有 i18n 处理')
      delete mod.i18n
      return
    }
    for (const key of Object.keys(raw.messages)) {
      if (I18N_BLOCKED_KEYS.has(key)) {
        warnMod(mod, 'i18n', '忽略原型污染键 messages.' + key)
        continue
      }
      const locale = normalizeLocale(key)
      if (!locale || !supported.includes(locale)) {
        warnMod(mod, 'i18n', 'messages 的语言「' + key + '」不在 supportedLocales 中，已忽略')
        continue
      }
      if (Object.hasOwn(messages, locale)) {
        warnMod(mod, 'i18n', 'messages 重复声明语言 ' + locale + '，只保留第一份')
        continue
      }
      const layer = sanitizeI18nLayer(mod, locale, raw.messages[key])
      if (layer) messages[locale] = layer
    }
  }
  for (const key of Object.keys(raw)) {
    if (I18N_TOP_FIELDS.includes(key)) continue
    if (I18N_BLOCKED_KEYS.has(key)) {
      warnMod(mod, 'i18n', '忽略原型污染键 i18n.' + key)
      continue
    }
    warnMod(mod, 'i18n', '不支持的 i18n 字段「' + key + '」已忽略（localize 钩子必须放在 Mod 顶层）')
  }
  mod.i18n = { defaultLocale, supportedLocales: supported, messages }
}

/** 可选顶层 localize(locale) 钩子：只允许同步函数；不是函数时 warn 并当作没声明。 */
function normalizeModLocalize(mod) {
  if (mod.localize === undefined) return
  const value = mod.localize
  if (typeof value !== 'function') {
    warnMod(mod, 'localize', '必须是同步函数，已忽略')
    delete mod.localize
    return
  }
  if (Object.prototype.toString.call(value) === '[object AsyncFunction]') {
    warnMod(mod, 'localize', '必须是同步函数（不能是 async），已忽略')
    delete mod.localize
  }
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
  if (mod.actingSeats !== undefined && typeof mod.actingSeats !== 'function') missing.push('actingSeats (function)')
  if (mod.seatLocalMove !== undefined && typeof mod.seatLocalMove !== 'function') missing.push('seatLocalMove (function)')
  if (mod.viewState !== undefined && typeof mod.viewState !== 'function') missing.push('viewState (function)')
  if (mod.viewEvents !== undefined && typeof mod.viewEvents !== 'function') missing.push('viewEvents (function)')
  if (mod.moveCost !== undefined && typeof mod.moveCost !== 'function') missing.push('moveCost (function)')
  if (mod.decisionSeed !== undefined && typeof mod.decisionSeed !== 'function') missing.push('decisionSeed (function)')
  if (mod.agentFallback !== undefined && typeof mod.agentFallback !== 'function') missing.push('agentFallback (function)')
  if (mod.agentCandidates !== undefined && typeof mod.agentCandidates !== 'function') missing.push('agentCandidates (function)')
  if (mod.refineMove !== undefined && typeof mod.refineMove !== 'function') missing.push('refineMove (function)')
  if (mod.agentHint !== undefined && typeof mod.agentHint !== 'string') missing.push('agentHint (string)')
  if (mod.migrateState !== undefined && typeof mod.migrateState !== 'function') missing.push('migrateState (function)')
  if (mod.cacheWebAsset !== undefined && typeof mod.cacheWebAsset !== 'function') missing.push('cacheWebAsset (function)')
  if (mod.commitChoiceBatch !== undefined && typeof mod.commitChoiceBatch !== 'function') missing.push('commitChoiceBatch (function)')
  if (missing.length) throw new Error('缺少字段: ' + missing.join(', '))
  // 可选本地化能力：这里只做「警告 + 规范化」，不因为翻译声明非法而拒绝加载整个 Mod。
  normalizeModI18n(mod)
  normalizeModLocalize(mod)
}

/** 校验 web 目录内的相对文件路径：规则与 client/styles 相同，非法或不存在直接抛错（路径安全，必须硬失败）。 */
function validateWebFile(root, value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(value) || value.includes('..')) {
    throw new Error(label + ' 文件名非法: ' + value)
  }
  if (!fs.existsSync(path.resolve(root, value))) throw new Error(label + ' 不存在: ' + value)
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
    validateWebFile(absolute, value, 'web.' + key)
  }
  const mount = '/mods/' + mod.id
  // 可选 web.locales：{ [locale]: '相对 web.dir 的路径' } → localeUrls（catalog 的 i18n.files 用它）。
  // key 必须属于 i18n.supportedLocales（未声明 i18n 时全部忽略）；未声明的语言忽略并 warn；
  // 路径越界/绝对路径/文件不存在 → 抛错拒绝加载该 Mod（与 client/styles 同一套边界，不做降级）。
  const localeUrls = {}
  if (mod.web.locales !== undefined) {
    if (!isPlainObject(mod.web.locales)) {
      warnMod(mod, 'web.locales', '必须是 { locale: 相对路径 } 普通对象，已忽略')
    } else {
      const supported = new Set(Array.isArray(mod.i18n?.supportedLocales) ? mod.i18n.supportedLocales : [])
      for (const [rawLocale, value] of Object.entries(mod.web.locales)) {
        if (I18N_BLOCKED_KEYS.has(rawLocale)) {
          warnMod(mod, 'web.locales', '忽略原型污染键「' + rawLocale + '」')
          continue
        }
        const locale = normalizeLocale(rawLocale)
        if (!locale || !supported.has(locale)) {
          warnMod(mod, 'web.locales', '语言「' + rawLocale + '」不在 supportedLocales 中，已忽略')
          continue
        }
        if (Object.hasOwn(localeUrls, locale)) {
          warnMod(mod, 'web.locales', '语言 ' + locale + ' 重复声明，只保留第一份')
          continue
        }
        validateWebFile(absolute, value, 'web.locales[' + rawLocale + ']')
        localeUrls[locale] = mount + '/' + value
      }
    }
  }
  mod.web = {
    ...mod.web,
    root: absolute,
    mount,
    clientUrl: client ? `${mount}/${client}` : null,
    stylesUrl: styles ? `${mount}/${styles}` : null,
    ...(Object.keys(localeUrls).length ? { localeUrls } : {}),
  }
}
