# 大厅与游戏本地化（i18n）实现方案（2026-10）

> 状态：**已实现（2026-10-24）**。大厅侧 P1–P4 + P6 已落地：`settings.json` / `GET|POST /api/settings`、`lib/i18n.js` 解析与合并、`public/i18n.js` + 中英词典 +「语言」设置页、Mod `i18n` 契约（`mod.i18n` / `web.locales` / 顶层 `localize` 钩子）、catalog 已本地化元数据与回退标记、`host.locale` / `onLocaleChange`、`createSession` / `handleApi` / `handleLocalApi` 语言上下文、`session.locale`、registry `localized`。诡镇奇谈完成 P5 第一、二阶段（目录/设置元数据、`web.locales`、卡牌展示统一入口、`followHall` 偏好），第三步（界面词典）只覆盖主路径，引擎文本与其余界面作为后续项（§8.7）。实现记录与相对本文档的取舍见 §18。
>
> 范围：大厅界面、开局/目录元数据、Mod 界面与其自带内容；不含 AI 台词翻译、规则引擎全量文案重构、用户内容翻译。
>
> 目标：**设置里能改语言；每个游戏自带自己的本地化；游戏跟随大厅当前语言；游戏没有该语言时回退到游戏自己的默认语言。**

## 0. 摘要

| 需求 | 落点 |
| --- | --- |
| 设置可以改语言 | 大厅新增「语言」设置页；语言偏好写入 `settings.json`，经 `GET/POST /api/settings` 读写，立即生效、重启保留 |
| 游戏会储存自己的本地化 | 本地化资源由 Mod 自己携带（`web/locales/` + `index.js` 的 `i18n.messages`），随游戏版本发布，大厅不翻译游戏正文 |
| 同步显示大厅的语言 | 大厅按当前语言解析每个 Mod 的元数据，随 `/api/catalog` 下发；Mod 前端通过 `host.locale` / `onLocaleChange` 拿到当前语言 |
| 没有就回退游戏自己的默认语言 | 统一的 `resolveLocale()`：请求语言 → 同主语言变体 → 游戏 `defaultLocale` → 源文案；逐字段再按同一顺序回退 |

一句话设计：**语言偏好归大厅，本地化资源归游戏；服务端只解析语言并下发已解析结果，客户端不重复实现一套解析算法。**

## 1. 目标与非目标

### 1.1 必须满足

1. 「⚙️ 设置」里能选择大厅语言；切换后不重启大厅即生效，刷新/重启后仍保留。
2. 大厅自身的文案（导航、设置、开局弹窗、更新/联机/反馈等）跟着切换；`<html lang>` 与标题同步。
3. 每个游戏自带自己的本地化资源；游戏可以随包新增/修改自己的语言，不需要改大厅代码，也不需要发大厅版本（大厅设置里需先提供该语言选项，v1 为 `zh-CN` / `en`）。
4. 游戏目录卡片、开局设置、游戏界面显示大厅当前语言；游戏没有该语言时，回退到游戏自己声明的默认语言。
5. 单个字段/单条文案缺失时继续回退，不能出现空白或 `undefined`；主路径不得出现原始 key（由词典完整性测试守住）。
6. 旧 Mod、旧存档、旧版大厅都能继续工作；不因为本地化改动破坏现有对局与回归测试。

### 1.2 非目标（v1 明确不做）

- **AI 台词与角色人设翻译**：`lib/agent/` 的提示词、AI 名字/人设、历史聊天仍是中文。语言设置不改变模型行为，也不翻译已生成的台词。
- **规则引擎全量文案**：诡镇 `src/engine/**`、`src/cards/**` 中的事件日志、选项、规则说明大量是中文；v1 只要求游戏**前端界面和卡牌展示**接入，引擎正文的 key 化另立项目。
- **历史存档回译**：已写入 `state/events` 的中文文本不因切换语言而重写。
- **大厅控制台日志**：`server.js`/`lib/*.js` 的 `console.log` 是开发者日志，保持中文。
- **RTL、复杂复数、ICU MessageFormat**：v1 只做中/英，预留 `dir` 字段，不引入格式化库。
- **机器翻译**：运行时不做任何联网翻译；词典是随包发布的静态文件。
- **联机时把房主语言强推给其他玩家**：每位玩家自己运行大厅，语言偏好各自独立；共享对局内容的语言以房主开局时为准（见 §10.4）。

### 1.3 验收口径

用一句话判断是否完成：**把语言改成 English 后，大厅、目录、开局表单和游戏界面都变英文；把语言改成游戏不支持的语言时，该游戏回到它声明的默认语言，且大厅其他部分不受影响。**

## 2. 现状核查（代码事实）

这一节是后文设计的依据，不是设想。大厅侧（`lib/`、`public/`）没有任何 `language` / `locale` / `i18n` 相关代码，只有 `localeCompare` 这类排序调用；Mod 侧唯一的双语实现是诡镇（见 §2.3）。

### 2.1 大厅

| 位置 | 现状 |
| --- | --- |
| `public/index.html` | `<html lang="zh-CN">`、`<title>桌游大厅</title>` 写死；页面只加载 `/app.js` |
| `public/app.js` | 用户可见文案基本是中文硬编码；`boot()` 只并行请求 `/api/catalog`、`/api/ais`、`/api/config`；设置弹窗固定 5 个顶层页签（玩家/AI/联机/大厅更新/语言），AI 页签内含 AI 角色/模型连接/AI 指标三个二级页签 |
| `public/online-ui.js`、`updates-ui.js`、`feedback-ui.js`、`chat-compose.js`、`chat-notifications.js` | 同样是中文硬编码；`updates-ui.js` 里有一处 `toLocaleString()` 未指定语言 |
| `lib/server.js` | `catalogView()` 直接下发 Mod 的 `name` / `description` / `tags` / `settingsSpec`；API 错误大多是中文 `error` 字符串 |
| 设置存放 | 更新设置存 `<DSH_HOME 或 ~/.dsh>/boardgame-hall/updates.json`（`lib/update-common.js`）；模型与玩家资料存项目根 `boardgame.config.json`（`DSH_HOME` 下为 `<DSH_HOME>/boardgame.config.json`，`lib/agent/config.js`）；没有通用的「大厅偏好」文件 |
| 本地化基础设施 | 无 `public/i18n.js`、无 `public/locales/`、无 `lib/i18n.js`、无相关测试 |

### 2.2 Mod 契约

`lib/mods.js` 顶部注释是 Mod 接口的完整文档。与本地化直接相关的现状：

- 元数据只有 `name`（中文名）和 `nameEn`（可选英文名，**当前前端没有任何地方使用**）。
- `settingsSpec[].label` / `description` / `options[].label` 是纯中文字符串。
- `web` 只声明 `dir` / `client` / `styles`；静态文件挂到 `/mods/<id>/`。
- 浏览器端 `createUI(host)` 的 `host` 只有 `h/api/render/state/game/...`，没有语言信息（`public/app.js` 的 `loadModUi()`）。
- 服务端 `handleApi({ method, path, searchParams })`、`handleLocalApi(...)` 没有语言参数；`createState(settings, players)` 也没有。
- 没有 `locales` / `defaultLocale` / `messages` 之类的约定。

### 2.3 诡镇奇谈已有的局部能力

诡镇是目前唯一认真做过双语数据的 Mod，可以作为「游戏自带本地化」的参考实现：

| 能力 | 实现 | 局限 |
| --- | --- | --- |
| 卡牌文本 | `src/cards/cards-data.js` 每张卡有基础字段 `name/text/flavor/...` 与 `nameZh/textZh/flavorZh/...`；`web/catalog.js` 的 `cardFaceText()` 在 `en` 时清空 Zh 字段，非 `en` 时保留 Zh 字段；真正做 `nameZh \|\| name` / `textZh \|\| text` 选择的是图鉴、卡牌详情等调用方 | 基础字段是英文，中文是叠加字段；不是通用的 locale 词典 |
| 卡牌语言偏好 | `localStorage['arkham.presentation']`，`{ language: 'zh-cn' \| 'en', ... }`；默认 `zh-cn`；`web/catalog.js` 的 `preferences` / `savePreferences()` | 只存在浏览器里，不跟大厅语言联动 |
| 卡图 | `web/images.js` 的 `imageCandidates()`：对声明了 `localized` 的候选，中文时先试 `img/zh/...` 本地/远程，再试通用路径；英文只用通用路径 | 回退顺序是游戏自定义的，大厅不应接管 |
| 界面文案 | `web/*.js` 中大量中文硬编码 | 完全未本地化 |
| 全量一致性 | 多处直接写 `card.nameZh \|\| card.name`（如 `web/catalog.js` 图鉴、`web/game-ui.js`、`web/table-regions.js`、`web/story-reader.js`、`web/situation-view.js`），不读 `preferences.language`；`web/hub.js` 只有规则文本的 `textZh \|\| text`，`web/card-zoom.js` 则通过 `cardFaceText()` 间接受偏好影响 | 切换「卡牌语言」后，桌面/牌堆等仍可能显示中文 |

结论：诡镇有**数据层**的双语素材和**局部**的展示偏好，但没有统一的 locale 抽象，也没有 UI 词典。这正是「游戏自己储存本地化」可以沿用的方向，但需要一次收敛。

### 2.4 商店与联机

- `registry/index.json` 和 `lib/store.js` 的 `parseRegistry()` 只有单份 `name` / `description`；游戏**未安装**时，商店列表只能显示这份文案。
- 联机模式下每位玩家运行自己的大厅（见 `docs/multiplayer.md`），因此「大厅语言」天然可以是每位玩家本机的设置；房主只负责规则、AI 与存档。
- 当前房间同步的是对局状态和玩家视图，没有交换语言偏好。

### 2.5 差距清单

1. 没有语言偏好文件、API、设置页。
2. 没有大厅文案词典和 `t()`。
3. 没有 Mod 语言声明与解析/回退算法。
4. 没有把语言传给 Mod 服务端/前端的通道。
5. 没有会话级语言快照，也没有语言切换后的 Mod 通知机制。
6. 商店列表没有本地化元数据。
7. 诡镇的「卡牌语言」与「界面语言」没有统一，且大量中文硬编码。

## 3. 术语与语言标识

| 术语 | 含义 |
| --- | --- |
| locale tag | BCP 47 子集，如 `zh-CN`、`en`；本项目只使用「语言[-地区]」两级 |
| 源语言（source locale） | 代码里的基础界面文案语言。大厅与现有 Mod 的界面源语言都是 `zh-CN`；诡镇的卡牌数据基础字段是英文，但界面/引擎文案是中文 |
| `defaultLocale` | **游戏自己声明的默认语言**；大厅语言不被游戏支持时回退到它，也是逐字段回退的倒数第二层 |
| `requested` | 大厅当前设置的语言（规范化后） |
| `resolved` | 对某个 Mod 最终选用的语言；有声明时总是该 Mod `supportedLocales` 中的一个，无声明（空支持列表）时才退回源语言 |
| 语言包（locale pack） | 某个 locale 的词典/资源文件；大厅与每个 Mod 各自维护 |
| 字段回退 | 已选 `resolved` 的词典缺某个 key 时，依次取 `defaultLocale` 词典、源文案 |

### 3.1 大厅支持的语言（v1）

| tag | 名称（endonym） | 说明 |
| --- | --- | --- |
| `zh-CN` | 简体中文 | 源语言，也是大厅默认值 |
| `en` | English | v1 新增的完整大厅词典；游戏可按需支持 |

语言名用**该语言自己的写法**（`简体中文` / `English`），不随当前界面语言变化，避免设置页里出现「English / 英语 / Anglais」三种写法。

v1 约定 Mod 用**语言-only** tag 表示通用支持（`en`，而不是 `en-US`）；只有内容真的有地区差异时才用地区 tag。这样 `en-US` 的请求能按 §9 的规则落到 `en`；如果 Mod 只声明 `en-US`，`en` 的请求不会自动匹配过去，会走默认语言。

实现上 `lib/i18n.js` 导出 `HALL_LOCALES = [{ id: 'zh-CN', label: '简体中文' }, { id: 'en', label: 'English' }]`，`settingsView()` 直接下发；新增大厅语言时改这一处、在 `public/i18n.js` 增加静态 import，并新增 `public/locales/<tag>.js`。

### 3.2 规范化与匹配

- 输入先 trim、把 `_` 换成 `-`、去掉多余空白；长度上限 35。
- 合法格式：`/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/`。语言小写，4 字母 script 首字母大写，地区大写；例如 `zh-cn` → `zh-CN`、`en-us` → `en-US`。
- 别名只保留最小集合：`zh` → `zh-CN`（项目现有文案都是简体中文，别名含义明确）。不把 `zh-Hant` 自动映射到 `zh-TW`，避免猜错；需要繁体时显式加入支持列表。
- `en-US` / `en-GB` 这类请求不靠别名，靠 §9 的「同主语言匹配」落到 `en`。
- 非法 locale 不抛异常：读取设置时回退 `zh-CN` 并 `console.warn`；API 写入时返回 400 `INVALID_LOCALE`。

### 3.3 方向（预留）

语言包可声明 `dir: 'ltr' | 'rtl'`，v1 全为 `ltr`；大厅只把 `dir` 写到 `<html dir>`，CSS 不为此做专门适配。等真正接入 RTL 语言时再补布局测试。

## 4. 设计总览

```
┌────────────────────────────── 大厅 ──────────────────────────────┐
│ settings.json { locale }                                          │
│        │                                                           │
│ lib/server.js ── resolveLocale(requested, mod.i18n) ──┐            │
│        │                                              ├─ /api/catalog（已本地化元数据 + i18n 解析结果）
│        ├─ GET/POST /api/settings                      │
│        └─ createSession(): session.locale = resolved  │
│                                                       ▼            │
│ public/app.js ── public/i18n.js + public/locales/*.js（大厅文案）   │
│        │                                                           │
│        └─ createUI(host) ── host.locale ──> Mod 前端（自带语言包）   │
└────────────────────────────────────────────────────────────────────┘
```

### 4.1 关键原则

1. **偏好与资源分离**：大厅只保存「当前语言」这一项偏好；具体翻译文本属于各自的所有者（大厅文案属于 `public/locales`，游戏文案属于游戏包）。
2. **服务端解析一次**：语言解析、Mod 元数据合并、回退选择都在 `lib/i18n.js` 完成，随 catalog 下发 `resolved`；浏览器端不再实现第二套解析，避免两端结果不一致。
3. **元数据在服务端本地化**：首页与开局弹窗由大厅渲染，而 Mod 前端脚本是**打开该游戏时才加载**的（`public/app.js` 的 `loadModUi()` 注释明确写了这一点）。因此游戏名称/描述/设置项不能等 Mod 脚本来翻译。
4. **游戏内容由 Mod 自己翻译**：大厅不知道卡牌、战役、规则文本的结构，也不应该知道。大厅只把 `resolved` 和语言包 URL 交给 Mod。
5. **回退是分层的**：先选语言，再逐字段；缺什么都回退，不把缺失暴露成空白。
6. **渐进增强**：没有 `i18n` 的旧 Mod 继续按中文基础字段工作；旧版大厅忽略新增字段；不要求 `HALL_API` 升级。

### 4.2 为什么不把语言只放浏览器

| 方案 | 做法 | 问题 |
| --- | --- | --- |
| 只存 `localStorage` + URL 参数（未采用） | 设置页写 localStorage，打开游戏时加 `?lang=en` | 服务端渲染的 catalog/settings 元数据无法按语言下发；刷新/多标签/换浏览器行为不一致；测试要额外注入 |
| 每款游戏各自存偏好（未采用） | 每个 Mod 自己弹语言设置 | 首页目录、开局表单仍是大厅渲染，无法同步；用户要在每个游戏里重设 |
| **大厅统一偏好 + 服务端解析（采用）** | `settings.json` + `/api/settings` + catalog 下发 resolved | 需要新增设置文件和一个 API，但行为一致、可测试、离线可用 |

语言偏好放在服务端还带来一个好处：大厅控制台、会话创建、Mod 服务端接口都能读到同一个值，不需要在请求里层层传 `?lang=`。

## 5. 大厅语言设置

### 5.1 存储：`settings.json`

新增 `lib/settings.js`，位置复用 `lib/update-common.js` 的 `hallDataDir()`：

```
<DSH_HOME 或 ~/.dsh>/boardgame-hall/settings.json
```

```json
{
  "schema": 1,
  "locale": "zh-CN"
}
```

规则：

- 文件不存在 → `{ schema: 1, locale: 'zh-CN' }`，不报错。
- JSON 损坏、`schema` 非 1、`locale` 不在大厅支持列表 → 回退 `zh-CN` 并 `console.warn`，不阻止启动。
- 保存时保留未知字段（向前兼容未来设置项），先写 `settings.json.tmp` 再 `rename`，沿用 `saveUpdateSettings()` 的原子写法（`saveConfig()` 目前是直接覆盖，不要照搬它）。
- 每次请求重新读盘（与 `loadUpdateSettings()` 一致，文件很小）；不做进程内缓存，避免测试和多实例读到旧值。
- 不放进 `updates.json`（更新设置）或 `boardgame.config.json`（模型/玩家资料）：这两者都有明确的职责，语言是通用偏好，混入会让备份、环境变量覆盖和测试都变复杂。
- 不新增环境变量覆盖（v1）。测试和多实例隔离用已有的 `DSH_HOME`；如果以后确实需要，再按 `AI_*` 的模式加 `BOARDGAME_LOCALE`。

`lib/settings.js` 对外只暴露：

```js
export const HALL_LOCALE_DEFAULT = 'zh-CN'
export function loadSettings()          // -> { schema, locale, ...unknown }
export function saveSettings(patch)     // -> 生效设置；非法 locale 抛错
export function settingsView()          // -> { ok: true, settings, locales }
```

### 5.2 API

新增两个路由（在 `lib/server.js` 的 `handleApi()` 里，放在 `/api/config` 附近）：

**GET `/api/settings`**

```json
{
  "ok": true,
  "settings": { "schema": 1, "locale": "zh-CN" },
  "locales": [
    { "id": "zh-CN", "label": "简体中文" },
    { "id": "en", "label": "English" }
  ]
}
```

**POST `/api/settings`**

```json
{ "locale": "en" }
```

- 成功：返回与 GET 相同的结构（便于前端一次更新状态）。
- 非法 locale：`400 { ok: false, code: 'INVALID_LOCALE', error: '不支持的语言：xx' }`。
- 写入失败：`500 { ok: false, code: 'SETTINGS_WRITE_FAILED', error: '保存语言设置失败：...' }`。
- 写入前用 `normalizeLocale()` 规范化：`zh` 存成 `zh-CN`；规范化后仍不在 `HALL_LOCALES` 中则拒绝。
- 不需要重启；不影响进行中的对局，只影响之后创建的会话和接下来的 UI 渲染。

这个接口只改本机偏好，不涉及下载/执行代码，不需要像 `/api/updates/*` 那样限制本机；但仍是同源 JSON 接口，沿用现有的 `readBody()` 校验即可。

### 5.3 设置页

在 `public/app.js` 的 `renderSettingsModal()` 增加一个页签：

```js
tabBtn('language', t('settings.tabs.language'))
```

`state.settingsTab` 的联合类型注释同步加上 `'language'`，并在 `state` 里新增 `settings: null` 保存 `GET /api/settings` 的 `settings` 字段、`locales: []` 保存语言选项；不要把整个响应塞进 `state.settings`。页面内容：

- 标题/说明：`settings.language.title`、`settings.language.desc`。
- 一个 `<select>`，选项来自 `GET /api/settings` 的 `locales`，当前值 `state.settings.locale`。
- 提示文案：**「游戏会跟随这里选择的语言；如果游戏没有提供该语言，会使用游戏自己的默认语言。」**
- 选择后**立即保存**（与「大厅更新」页的即时保存一致），不额外放「保存」按钮：
  1. `state.localeSaving = true`，禁用下拉框；
  2. `POST /api/settings { locale }`；
  3. 成功后 `state.settings = resp.settings`、`state.locales = resp.locales`、`setLocale(locale)` → `await reloadCatalog()` → `notifyModLocales()` → `render()`；
  4. 失败则回滚下拉框、显示 `role="status"` 错误，不改变当前语言。
- 切换时保留当前设置页签与滚动位置；`render()` 会重建 DOM，若需要可记录 `activeElement`/滚动条再恢复，v1 至少不要关闭设置弹窗。
- 如果当前正在对局，显示一行提示：**「界面会立即切换；已写入存档的剧情文本不会回译。未实现 `onLocaleChange` 的游戏需要刷新页面，部分游戏的内容需要重新开局才完全生效。」**
- 重新拉取 catalog 后，如果 `state.setup` 还开着，按 `game.id` 把 `state.setup.game` 换成新 catalog 里的对象；否则开局弹窗仍持有旧 `settingsSpec`，标签不会跟着变。`state.session` 的标题/Mod 名同理，渲染时用当前 catalog 或重新解析的 `modName`，不要只信创建时缓存的字符串。
- 如果「游戏中心」或联机面板正开着，切换语言后重新拉取它们的数据（或关闭再打开）；这些面板各自缓存了商店/房间文案，只重绘大厅不会更新。

### 5.4 启动流程

`public/app.js` 的 `boot()` 改成：

```js
const [g, a, c, s] = await Promise.all([
  api('GET', '/catalog'),
  api('GET', '/ais'),
  api('GET', '/config'),
  api('GET', '/settings').catch(() => null), // 旧服务端/临时失败不拖垮整个 boot
])
state.settings = s?.settings || { locale: 'zh-CN' }
state.locales = s?.locales || [{ id: 'zh-CN', label: '简体中文' }]
setLocale(state.settings.locale)   // 设置 <html lang>、<title>、当前词典
state.catalog = g.games || []
...
render()
```

- `setLocale()` 必须在首次 `render()` 之前执行，避免先渲染中文再闪成英文。
- `/api/settings` 失败不应让整个大厅打不开：用 `.catch(() => null)` 隔离，回退 `zh-CN` 并 `console.warn`；旧版服务端没有这个接口时也能降级。
- `public/index.html` 的初始 `lang="zh-CN"` 保留作为无 JS/加载中的兜底；启动后由 `setLocale()` 改成真实值。若以后要求首屏 HTML 就是英文，再考虑由服务端模板化 `index.html`（当前 `serveStatic()` 直接读静态文件，专门特判不值得）。

### 5.5 文案、日期与数字

`public/i18n.js` 提供：

```js
export function setLocale(locale)             // 规范化 + 切换词典 + document.documentElement.lang/dir + title
export function getLocale()
export function t(key, vars)                  // 当前语言 → zh-CN → key；支持 {name} 插值
export function formatDate(value, options)    // Intl.DateTimeFormat(getLocale(), options)
export function formatNumber(value, options)  // Intl.NumberFormat(getLocale(), options)
```

- 现有 `updates-ui.js` 的 `toLocaleString()` 改成 `formatDate()`；其它硬编码 `'zh-CN'` 的排序/日期调用一并替换（`localeCompare(..., 'zh')` 只用于中文排序的 Mod 内部逻辑可保留，但大厅列表排序应使用当前 locale）。具体地，`lib/store.js` 的 `games.sort(... a.name.localeCompare(b.name, 'zh'))` 要接收当前 locale（或在 `updatesView()` 里重排），否则英文商店仍按中文规则排序。
- 货币、百分比等如果以后出现，统一走 `Intl.NumberFormat`，不要手写 `toFixed() + '元'`。

## 6. 大厅文案本地化

### 6.1 文件与词典

```
public/i18n.js                 # t/setLocale/format，无构建、无依赖
public/locales/zh-CN.js        # 源语言词典（默认导出扁平对象）
public/locales/en.js           # 英文词典
```

`public/i18n.js` 静态 import 两份词典（体积很小），这样启动时没有额外网络请求；增加语言时再增加静态 import。服务端 `HALL_LOCALES` 与前端词典的 key 必须一一对应（如 `zh-CN` / `en`）：服务端列表决定设置页能选什么，前端缺词典会自动回退 `zh-CN`，但发布前要用测试或启动断言守住这个对应关系。词典使用**扁平 key**，便于 diff 和缺失检查：

```js
// public/locales/zh-CN.js
export default {
  'app.title': '桌游大厅',
  'library.subtitle': '选择一款桌游，与朋友联机或与 AI 对弈',
  'settings.tabs.player': '玩家',
  'settings.tabs.ai': 'AI',
  'settings.tabs.language': '语言',
  'settings.language.desc': '游戏会跟随这里选择的语言；如果游戏没有提供该语言，会使用游戏自己的默认语言。',
  'setup.start': '开始对局',
  'setup.starting': '创建中…',
  'error.SESSION_BUSY': '对局正在处理行动，请稍后重试',
}
```

```js
// public/locales/en.js
export default {
  'app.title': 'Board Game Hall',
  'library.subtitle': 'Pick a game and play online with friends or against AI',
  'settings.tabs.player': 'Player',
  'settings.tabs.ai': 'AI',
  'settings.tabs.language': 'Language',
  'settings.language.desc': 'Games follow this language. If a game does not provide it, the game’s own default language is used.',
  'setup.start': 'Start game',
  'setup.starting': 'Creating…',
  'error.SESSION_BUSY': 'The game is processing a move. Please try again shortly.',
}
```

约定：

- key 用 `区域.用途` 命名；`error.<CODE>` 专门给服务端错误码用。
- 文案里的动态部分统一 `{name}` / `{count}` 占位；`t()` 用字符串替换，不拼 HTML。需要富文本时用 DOM 构造，不允许把词典内容塞进 `innerHTML`。
- 英文缺失的 key 自动回退 `zh-CN`；`zh-CN` 也缺失时返回 key 本身并在开发模式 `console.warn` 一次。这属于词典维护错误：**主路径不允许出现裸 key**，用词典完整性/浏览器测试守住；不要把 `key` 当成正常的用户可见文案。
- 不翻译：CSS 类名、API 路径、协议枚举（`playing`/`over`）、玩家名/AI 名、Mod 内容、控制台日志、代码注释。
- 复数 v1 不做 ICU：英文文案尽量用不随数量变化的句式（如 `Players: {min}–{max}`）；确需复数时再用 `Intl.PluralRules` 写小型 `tn()`，不要在每个字符串里手写 `(s)`。

### 6.2 抽取范围

按文件逐个迁移，保持中文输出与现在逐字一致，减少浏览器回归的噪音：

1. `public/app.js`（最大，先做导航/设置/开局/对局/聊天骨架）
2. `public/online-ui.js`
3. `public/updates-ui.js`（含游戏商店）
4. `public/feedback-ui.js`
5. `public/chat-compose.js`、`public/chat-notifications.js`

每个文件先建立 `import { t } from './i18n.js'`，把字符串替换成 `t('...')`；`aria-label`、`title`、`placeholder`、`role="status"` 文案同样要抽取，否则英文界面会残留中文提示。动态拼接的句子改成带占位符的完整句子，避免「英文语序 + 中文碎片」：

```js
// 不推荐：t('game.players') + min + '–' + max
// 推荐：
t('game.players', { min, max })   // '👥 {min}–{max} 人' / '👥 {min}–{max} players'
```

### 6.3 服务端错误

服务端目前大量返回中文 `error`（如「玩家人数必须在 1–4 之间」「对局正在处理行动」）。v1 采用**错误码 + 客户端映射**，而不是让服务端维护一套 locale 词典：

- 新增/修改的错误返回 `{ ok: false, code: 'INVALID_LOCALE', error: '...' }`。
- 前端统一用 `errorText(err)`：若 `err.code` 在词典里有 `error.<CODE>`，用本地化文案；否则显示服务端 `error`（中文兜底）。
- 先覆盖新接口和现有高频错误（`SESSION_BUSY`、`INVALID_REVISION`、`CONFIRM_REQUIRED`、`SAVE_DELETED` 等）；session-not-found 目前没有 `code`，需要时再补。其余错误在触碰对应代码时逐步加 `code`。
- 大厅注入的 `opponents` 设置项（`lib/server.js` 的 `OPPONENTS_SPEC`）也是用户可见文案，不能漏掉。建议给它加 `labelKey` / `descriptionKey`，前端优先用 Mod 已解析的 `aiSlotLabel` / `aiSlotDescription`，没有时用 `t(key)`；不要只翻译 Mod 自己的字段。
- 控制台日志保持中文，不要求本地化。

这样英文界面里少数冷门错误仍可能显示中文，但不会出现「英文界面 + 中文核心错误」的扩大化；后续把错误码补齐即可，不需要改协议。

### 6.4 可访问性与样式

- `document.documentElement.lang` 必须是规范化 tag；`document.title` 用 `t('app.title')`。
- 语言下拉框有 `<label for>`，保存结果用 `role="status"` 播报；切换后焦点尽量留在下拉框。
- 英文普遍比中文长 30%–60%：按钮用 `min-width` 而不是固定宽度；设置页签允许横向滚动/换行；在 390px 宽度下回归。
- 字体栈已经是 `system-ui, ..., "PingFang SC", "Microsoft YaHei", sans-serif`，英文可直接复用；不需要为 `:lang(en)` 单独换字体。
- 现有 Playwright 用例用中文按钮名定位；默认语言仍是 `zh-CN`，不受影响。新增英文用例应使用 `data-testid`（如 `data-testid="hall-locale"`）而不是英文文案。

## 7. 游戏元数据本地化（大厅渲染部分）

游戏名称、描述、标签、AI 席位说明、开局设置标签都由大厅渲染，所以这些必须在**服务端**完成本地化。

### 7.1 Mod 声明

在 `index.js` 的 default export 中增加**可选**的 `i18n`：

```js
export default {
  id: 'gobang',
  name: '五子棋',
  nameEn: 'Gobang',
  description: '黑白对弈，在 15×15 棋盘上率先五子连珠（横/竖/斜）者获胜。',
  tags: ['棋类', '双人', '策略'],

  i18n: {
    defaultLocale: 'zh-CN',
    supportedLocales: ['zh-CN', 'en'],
    messages: {
      'zh-CN': {
        // name/description/tags 可省略，省略时用 export 的基础字段
        aiSlotLabel: 'AI 对手',
        aiSlotDescription: '由 AI 扮演的对手',
        settings: {
          firstMove: {
            label: '先手',
            options: { player: '玩家（执黑先行）', ai: 'AI（执黑先行）' },
          },
        },
      },
      en: {
        name: 'Gobang',
        description: 'Place five stones in a row on a 15×15 board to win.',
        tags: ['Abstract', '2 players', 'Strategy'],
        aiSlotLabel: 'AI opponent',
        aiSlotDescription: 'An AI-controlled opponent',
        settings: {
          firstMove: {
            label: 'First move',
            options: { player: 'Player (black moves first)', ai: 'AI (black moves first)' },
          },
        },
      },
    },
  },

  web: {
    dir: 'web',
    client: 'game-ui.js',
    styles: 'style.css',
    locales: {
      'zh-CN': 'locales/zh-CN.js',
      en: 'locales/en.js',
    },
  },
}
```

字段规则：

| 字段 | 规则 |
| --- | --- |
| `defaultLocale` | 必填（若声明了 `i18n`）；解析时归一化为 `supportedLocales` 中的一项：缺失/非法/不在列表中时回退 `zh-CN`（若支持）否则 `supported[0]`，并 `console.warn`；保证后续 `resolved` 不越界 |
| `supportedLocales` | 非空字符串数组，去重、规范化；最多 20 个；可包含只有前端词典、没有 `messages` 的语言 |
| `messages` | 纯 JSON 对象；key 必须是 `supportedLocales` 的子集；只允许覆盖展示文本，不允许改 `type/default/players` 等行为字段 |
| `messages[locale].name/description/tags` | 省略则用基础字段；`tags` 整体替换，不做数组合并 |
| `messages[locale].aiSlotLabel/aiSlotDescription` | 省略则用基础字段/大厅默认 AI 席位文案 |
| `messages[locale].settings[key]` | 只允许 `label`、`description`、`options`（`value -> label` 映射）；未知 key 忽略 |
| `web.locales` | 可选；locale → 相对 `web.dir` 的文件路径；路径规则与 `web.client` 相同（不得含 `..`、不得越出目录、文件必须存在）；用于生成 `host.locale.files` 并提前校验 |

为什么 `settings` 用按 key 覆盖，而不是重写整个 `settingsSpec`：避免本地化意外改变设置类型、默认值或选项集合，把「翻译」和「玩法配置」分开。

`localize(locale)` 是 Mod **顶层**的可选钩子，不放进 `i18n`；`i18n` 保持纯 JSON，便于序列化、校验和下发。

### 7.2 可选：动态元数据 `localize(locale)`

像诡镇的战役名、调查员名来自内容注册表，无法全部写死在静态 `messages` 里。可以在 Mod 的 default export 顶层额外声明 `localize(locale)`（不是 `i18n.localize`）：

```js
localize(locale) {
  if (locale !== 'en') return null
  return {
    settings: {
      campaignId: {
        options: Object.fromEntries(campaignListForUi(contentRegistry).map(c => [c.id, c.nameEn || c.name])),
      },
    },
  }
}
```

约束：

- **同步**纯函数（`catalogView()` 是同步渲染，不能 await）；不得修改入参；不得做重 I/O。
- 返回值形状与 `messages[locale]` 相同，在静态合并之后应用，优先级最高。
- 抛错时大厅 `console.warn` 并忽略该次结果，不能让整个目录 500。
- 动态内容建议缓存到模块内（按 locale），避免每次 catalog 请求重算。
- v1 只用于文本覆盖；不能通过它增删设置项或改变默认值。

### 7.3 合并算法

`lib/i18n.js` 提供 `localizeMod(mod, requestedLocale)`，返回一个**只含展示字段的视图**，不修改 `mod`，也不要展开整个 Mod 对象。它内部先调用只做解析的 `resolveModLocale(mod, requestedLocale)`；只需要语言、不需要元数据的路径（如 `handleApi`）直接用它，避免触发 `settingsSpec` getter：

```
canonical = normalizeLocale(requestedLocale) || 'zh-CN'
localeInfo = resolveModLocale(mod, canonical)   // { requested, resolved, defaultLocale, supportedLocales, matched, fellBack }
localeInfo = { ...localeInfo, files: mod.web?.localeUrls || null }  // resolveWeb() 已校验路径
resolved   = localeInfo.resolved
defaultLocale = localeInfo.defaultLocale
messages   = mod.i18n?.messages || {}
base = {
  name: mod.name, description: mod.description, tags: mod.tags,
  aiSlotLabel: mod.aiSlotLabel, aiSlotDescription: mod.aiSlotDescription,
  settingsSpec: mod.settingsSpec,
}
result = { ...base, i18n: localeInfo }
for layer of [messages[defaultLocale], messages[resolved]]:   // 先默认，后 resolved；顺序不能反
  if layer:
    result.name        = textOr(layer.name, result.name)
    result.description = textOr(layer.description, result.description)
    result.tags        = Array.isArray(layer.tags) ? layer.tags : result.tags
    result.aiSlotLabel = textOr(layer.aiSlotLabel, result.aiSlotLabel)
    result.aiSlotDescription = textOr(layer.aiSlotDescription, result.aiSlotDescription)
    result.settingsSpec = mergeSettings(result.settingsSpec, layer.settings)
result = applyLocalizeHook(result, resolved)   // 可选，最后应用
return result
```

- **不要 `{ ...mod }`**：`clientData`、`settingsSpec` 在诡镇是 getter，展开会触发不必要的构建；`catalogView()` 本来就只取需要的字段。
- **不要改 `mod` 本体**：`description` 等字段还会进入 agent 的 system prompt（见 `lib/mods.js` 契约），改它会改变 AI 行为与回归结果。本地化只发生在展示视图/catalog 上。
- `applyLocalizeHook(result, resolved)` 就是调用顶层的 `mod.localize?.(resolved)`；返回值按 `messages[locale]` 的字段规则合并，非对象、异步返回值或抛错时忽略并 `console.warn`。
- `textOr(value, fallback)` 只接受非空字符串，空串/`null`/`undefined` 都继续用下一层；不要用 `??` 把空串当成有效翻译。
- `mergeSettings` 按 `spec.key` 找对应项，只覆盖 `label` / `description` / `options`；`options` 用 `String(value)` 查表，未命中保留原 label。
- `messages` 缺失某字段时保留上一层/基础值；因此「英文只翻译了名称」也能工作。
- `i18n` 不完整或非法时按「无 i18n」处理，基础字段仍可用。

### 7.4 catalog 下发

`catalogView()` 改为接收当前 locale，并只下发**解析后的字段**，不下发完整词典：

```json
{
  "id": "gobang",
  "name": "Gobang",
  "description": "Place five stones in a row on a 15×15 board to win.",
  "tags": ["Abstract", "2 players", "Strategy"],
  "settingsSpec": [
    {
      "key": "firstMove",
      "type": "select",
      "label": "First move",
      "options": [
        { "value": "player", "label": "Player (black moves first)" },
        { "value": "ai", "label": "AI (black moves first)" }
      ]
    }
  ],
  "i18n": {
    "requested": "en",
    "resolved": "en",
    "defaultLocale": "zh-CN",
    "supportedLocales": ["zh-CN", "en"],
    "matched": "exact",
    "fellBack": false,
    "files": {
      "zh-CN": "/mods/gobang/locales/zh-CN.js",
      "en": "/mods/gobang/locales/en.js"
    }
  }
}
```

这个 `i18n` 对象是 Mod 前端 `host.locale` 的基础；服务端在下发前把 `web.locales` 生成的 `files` 放进 `i18n`（`resolveWeb()` 已经解析并校验过路径），前端直接复用，不再自己拼 URL。**不要**把 `messages` 原样下发：体积大、会把所有语言暴露给客户端，也会让「服务端已解析」失去意义。

`catalogView()` 的组装顺序：先用 `localizeMod(m, locale)` 得到展示字段，再用它覆盖 `m` 的 `name` / `description` / `tags` / `aiSlotLabel` / `aiSlotDescription` / `settingsSpec`；`players` / `seats` / `cover` / `render` / `defaults` / `clientData` 仍取原 Mod。然后按现有逻辑注入 `OPPONENTS_SPEC`（并给它的 label/description 做本地化，见 §6.3），最后拼出 `i18n`（含 `files`）。

### 7.5 旧 Mod 的 `nameEn`

`nameEn` 是现成字段，但 UI 从未使用。为了不强迫所有旧 Mod 立刻补 `i18n`，v1 做一层兼容：

- 没有 `i18n`、请求语言是 `en`、`nameEn` 非空：catalog 的 `name` 用 `nameEn`；
- 在 catalog 的 `i18n` 上标记 `matched = 'legacy-name'`、`fellBack = true`，表示「只有名称是英文，其余仍为默认语言」；这是**catalog 层的兼容标记**，`resolveLocale()` 本身不会返回这个值；
- 不改 `description` / `tags` / 设置项（仍中文）；
- 有 `i18n` 时以 `i18n` 为准，忽略 `nameEn`。

这样英文首页至少不会把「五子棋 / 井字棋」显示成中文名，同时不会假装整款游戏已经支持英文。

### 7.6 校验与安全边界

在 `lib/mods.js` 的 `validateMod()` / `resolveWeb()` 中增加：

- `i18n` 必须是普通对象；`messages` 必须是普通对象；`i18n` 内拒绝数组、函数、`__proto__` / `constructor` / `prototype` 键（防原型污染）。
- 顶层 `localize` 若存在必须是函数（同步），不能把函数塞进 `i18n.messages`。
- `supportedLocales` 每项必须通过 §3.2 的格式；规范化后去重；`defaultLocale` 必须在其中。
- `messages` 的 key 必须属于 `supportedLocales`；超出范围的忽略并警告。
- `web.locales` 的每个值必须是相对路径，解析后必须落在 `web.root` 内，且文件存在；否则**拒绝加载该 Mod**（与现有 `web.client` / `web.styles` 的边界检查一致，属于路径安全问题，不做降级）。
- 结构性问题（如 `messages` 不是对象）可以「警告 + 当作没有 i18n」继续加载，避免一个翻译字段写错就让游戏消失；路径越界必须硬失败。
- `web.locales` 的 key 也必须属于 `supportedLocales`；未声明的语言文件忽略并警告。
- 不因为 `i18n` 缺失或格式错误而提升 `hallApi` 要求；新增字段全部可选。

### 7.7 游戏商店的 registry

游戏**未安装**时，大厅只能读 `registry/index.json`，所以商店列表的翻译要放在目录条目里（可选字段）：

```json
{
  "schema": 1,
  "games": [
    {
      "id": "arkhamhorror",
      "repo": "Dr-Liao/boardgame-arkhamhorror",
      "name": "诡镇奇谈：卡牌版",
      "description": "合作卡牌，1~4 人",
      "coverEmoji": "🐙",
      "localized": {
        "en": {
          "name": "Arkham Horror: The Card Game",
          "description": "Cooperative card game for 1–4 players"
        }
      }
    }
  ]
}
```

- `lib/store.js` 的 `parseRegistry()` 增加可选的 `localized` 校验：普通对象、key 是合法 locale、值只允许 `name` / `description` 两个非空字符串；非法条目忽略该语言并保留基础文案。
- `server.js` 的 `updatesView()` 在组装商店状态时调用 `localizeStoreGame(game, locale)`：精确匹配 → 同主语言（规则同 §9，但 registry 没有 `defaultLocale`，所以找不到就回退基础中文）；已安装的 Mod 以 Mod 的 `i18n` 为准，registry 只负责「还没装」的展示。实现上对 `store.status().games` 做一次 map：能按 id 找到已加载 Mod 的，用 `localizeMod(mod, locale).name/description`；找不到的才用 registry 的 `localized`。
- registry 的改动只推 `main` 分支即可生效，不需要发大厅版本；`docs/updates.md` 的目录示例同步补上该字段。
- 注意 `localized` 是可选的：旧目录、旧客户端、旧大厅都能继续按 `name` / `description` 工作。

## 8. 游戏界面与内容本地化（Mod 客户端）

### 8.1 `host.locale`

`public/app.js` 的 `loadModUi()` 创建 host 时增加：

```js
const host = {
  h, api, render, state, game, reset, leave, beginInteraction,
  startGame, loadSavedSession, rememberSession, forgetSession,
  renderOnlineSetup: onlineUi.setupFields,
  openFeedback: () => feedbackUi.open(),
  locale: {
    requested: 'en',
    resolved: 'en',
    defaultLocale: 'zh-CN',
    supportedLocales: ['zh-CN', 'en'],
    matched: 'exact',
    fellBack: false,
    files: {
      'zh-CN': '/mods/gobang/locales/zh-CN.js',
      en: '/mods/gobang/locales/en.js',
    },
  },
}
```

- `locale` 来自 `game.i18n`；`files` 也来自 `game.i18n.files`，由服务端根据 `web.locales` 生成绝对 URL（挂载前缀 `/mods/<id>/`），前端不自己拼。
- 大厅保存 host 引用（例如 `modHosts` Map）。语言切换时更新 `host.locale`，并调用 `ui.onLocaleChange?.(host.locale)`。
- `host.game` 是加载时的快照，语言切换后不会自动替换；不要从 `host.game.name` 之类字段读本地化文案，统一用 `host.locale`（以及大厅每次重绘时传入的新 `game`）。
- 旧 Mod 不读 `host.locale` 也不会报错；新 Mod 必须对 `host.locale` 缺失做防御（旧版大厅可能没有这个字段）：

```js
const active = host.locale?.resolved || 'zh-CN'
```

### 8.2 Mod 的语言包

约定放在 Mod 自己的 `web/` 下（这样打包、静态挂载、跨目录检查都沿用现有机制）：

```
games/gobang/web/locales/zh-CN.js
games/gobang/web/locales/en.js
```

```js
// games/gobang/web/locales/en.js
export default {
  'board.turn': 'Your turn',
  'board.thinking': 'AI is thinking…',
  'setup.firstMove': 'First move',
}
```

- 语言包是 ES module，default export 扁平对象；与大厅词典同一套 `{name}` 插值规则。
- 由 Mod 自己 `import()` 对应文件，或使用 `host.locale.files` 拼 URL；大厅**不**替 Mod 加载/合并词典。
- 缺失 key 回退顺序：`resolved` → `defaultLocale` → 源文案 → key。实现放在 Mod 自己的 `web/i18n.js` 小工具里，约 30 行，不需要大厅包。
- 如果某语言只有 `messages`（大厅元数据）而没有 `web.locales` 文件，表示「目录是英文、游戏界面仍是默认语言」；`supportedLocales` 允许这种情况，但游戏应尽快补齐，否则会出现中英混排。

### 8.3 运行时切换

新增可选接口：

```js
export function createUI(host) {
  let locale = host.locale?.resolved || 'zh-CN'
  return {
    // ...
    onLocaleChange(next) {
      locale = next.resolved
      // 只更新文案 + 重绘，不重置对局、不重新请求存档
      host.render()
    },
  }
}
```

大厅在设置保存成功后的顺序：

1. `setLocale()` 切换大厅词典并更新 `<html lang>`；
2. `reloadCatalog()` 拿到新的已本地化元数据；
3. 对每个已加载的 Mod UI：更新 `host.locale = game.i18n`，调用 `ui.onLocaleChange?.(host.locale)`；
4. `render()` 重绘大厅。

要求：

- `onLocaleChange` 必须**幂等**、**同步**、**不重置状态**；不要在里面 `location.reload()` 或重新 `fetch('/api/session')`。
- 如果 Mod 没实现 `onLocaleChange`，界面会保留旧语言直到刷新页面；大厅不强制重载 Mod 模块（会丢 UI 状态）。设置页提示「未实现 `onLocaleChange` 的游戏需要刷新页面，部分游戏的内容需要重新开局才完全生效」。
- 切换语言不应触发新的 AI 回合、不应修改 `state` 或 `revision`。
- 如果 Mod 的界面是服务端数据驱动的（如卡牌列表），它需要按新 locale 重新请求自己的 `/api/mods/<id>/...`，并在请求里带 `?lang=<resolved>`（或依赖服务端 `handleApi` 的 `locale` 参数）。

### 8.4 服务端钩子

给 Mod 的服务端接口增加语言上下文（全部是**增量**参数，旧 Mod 忽略即可）：

```js
// lib/server.js 调用处
const localeInfo = resolveModLocale(mod, currentLocale) // 只解析，不构建 settingsSpec
const result = await mod.handleApi({
  method, path: modPath, searchParams: url.searchParams,
  locale: localeInfo.resolved,          // 新增
  requestedLocale: localeInfo.requested, // 新增
})
```

- `handleLocalApi` 同样增加 `locale` / `requestedLocale`。
- `createState(settings, players, context)` 增加第三个参数：

```js
mod.createState(settings, players, {
  locale: localeInfo.resolved,
  requestedLocale: localeInfo.requested,
})
```

- `createState` 里建议把 `state.locale = context.locale`（或 `state.i18n = { ... }`）存下来，供 `applyMove` 生成玩家可见事件文本时使用；大厅不强制。
- `describeState()` 是给 AI 看的局面描述，**默认仍用源语言/中文**，避免模型提示词混入未验证的翻译；如果 Mod 明确希望 AI 看到本地化术语，可自行读取 `state.locale` 并承担质量风险。
- `validateMove()` 的错误字符串会同时用于玩家提示和模型纠错；v1 明确**保持源语言（中文）**，不要按 `state.locale` 改它，以免模型看到未验证的翻译。英文界面里的校验错误可能显示中文，这是已知限制；需要彻底解决时再给 `validateMove` 加 `context.locale` 或错误码（见 §16）。

### 8.5 Mod 自己的语言偏好

需求里的「游戏会储存自己的本地化」有两层含义，这里都覆盖：

1. **资源归属**：语言包在游戏包内，随游戏版本发布；大厅不维护游戏正文。
2. **偏好归属**：游戏可以保存自己的展示偏好（诡镇已有 `arkham.presentation`），但**默认必须是「跟随大厅」**；只有玩家显式改过才覆盖。

以诡镇为例：

```js
// 新结构（建议）
{
  language: 'zh-cn',        // 'zh-cn' | 'en'
  followHall: true,         // 默认 true；玩家在游戏内改语言时置 false
  host: '...',
  enabled: true,
  variant: ''
}
```

- 迁移：读取旧 `arkham.presentation` 时，如果没有 `followHall`：
  - 旧值 `language === 'en'` → 视为玩家显式选择过英文，置 `followHall: false`，避免升级后突然被大厅语言改回中文；
  - 其它情况（没有旧值，或旧值是 `zh-cn`）→ `followHall: true`。
  这个迁移规则需要产品确认（见 §16），因为旧版里 `zh-cn` 也可能是玩家显式选过的。
- 映射：大厅 `zh-CN` → 游戏 `zh-cn`；大厅 `en` → 游戏 `en`；大厅其它语言 → 游戏 `defaultLocale` 映射（`zh-CN` → `zh-cn`）。
- 大厅切换语言时，若 `followHall === true`，Mod 在 `onLocaleChange` 里更新 `language` 并重绘；若为 `false`，只更新 UI chrome 的词典，卡牌/卡图保留玩家选择。

### 8.6 会话语言与存档

- 创建对局时，大厅把最终 `resolved` 写进 `session.locale`（新增字段，`lib/server.js` 的 `createSession()`），并传给 `createState` 的 context。
- `lib/sessions.js` 的 `snapshotRecord()` 保存整个 session，新增字段自动落盘；`schema` 不变（向后兼容的增量字段）。
- 读旧存档时 `session.locale` 可能不存在：UI 用当前大厅语言渲染 chrome，游戏正文保持存档里已写入的文本；**不要**因为存档语言而反向修改大厅设置。
- 重开（`POST /api/reset`）按当前大厅语言创建新会话，而不是沿用旧 session 的 locale。
- 如果 Mod 的状态里存了本地化文本（事件日志、选项标签），切换语言不会重写历史；这是 v1 的明确限制。要彻底解决，需要把状态文本改成 message key + 参数，由 `viewState` 按观察者语言渲染，属于后续项目。
- `session.locale` 主要用于：Mod 在 `applyMove` 里生成新事件时选择语言；联机/读档时解释这份存档是用什么语言创建的；调试。
- 注意 `sessionView()` 的联机分支是显式挑字段的（`session.online ? {...} : session`），新增 `locale` 时要把它加进联机分支，否则客人视图里读不到；单机分支因为展开 `...session` 会自动带上。

### 8.7 诡镇奇谈参考实现

诡镇是最大、最复杂的 Mod，建议按下面顺序接入，避免一次性重写：

**第一步：目录与设置元数据**

- `games/arkhamhorror/index.js` 增加 `i18n`：
  - `defaultLocale: 'zh-CN'`，`supportedLocales: ['zh-CN', 'en']`；
  - `messages.en` 覆盖 `name`、`description`、`tags`、`aiSlotLabel`、`aiSlotDescription`；
  - `messages.en.settings` 覆盖 `playerCount`、`campaignId`、`cardPoolScope`、`allowRollback` 等设置项标签；
  - 战役名等动态选项用 §7.2 的 `localize('en')` 从内容注册表取 `nameEn`，没有英文名时保留中文。
- `web.locales` 声明 `web/locales/zh-CN.js`、`web/locales/en.js`。
- 这一阶段只改大厅渲染的元数据，游戏界面不动；英文用户至少能看懂目录和开局表单。

**第二步：卡牌展示统一入口**

- 在 `web/catalog.js` 把 `cardFaceText()` 提升为唯一的卡牌文本入口，并新增 `cardDisplayName(card, locale)` / `cardDisplayText(card, locale)`：
  - `locale === 'en'`：基础字段（英文）；
  - `locale === 'zh-CN'`：`nameZh || name`、`textZh || text`（逐字段回退）；
  - 其它：按 Mod 的 `defaultLocale` 处理。
- 替换 `web/game-ui.js`、`web/hub.js`、`web/table-regions.js`、`web/card-zoom.js` 等处的 `card.nameZh || card.name` / `textZh || text`，统一走这两个函数。这样「卡牌语言」才真正覆盖桌面、牌堆、图鉴、详情。
- 卡图继续用 `imageCandidates()` 的 zh → 通用回退；`language` 由 `host.locale` 映射得到，不再只读 `preferences.language`。

**第三步：界面词典**

- 新建 `web/i18n.js`（约 30 行，`t()` + fallback）和 `web/locales/zh-CN.js` / `en.js`。
- 从 `web/game-ui.js`、`web/hub.js`、`web/catalog.js`、`web/table-*.js` 等抽取按钮、标题、空状态、错误提示；优先覆盖「开局 → 主界面 → 桌面 → 卡牌详情」这条主路径。
- `createUI(host)` 里保存 `host.locale`，实现 `onLocaleChange` 重新渲染。
- 英文文案可以分两批：先主路径，再长尾（教程、规则书、战报）。

**第四步：引擎文本（可选，较大）**

- `src/engine/**`、`src/cards/**` 的事件日志、选项、规则说明目前是中文模板字符串，且同时用于 AI 提示词和玩家 UI。
- 完整本地化需要「文本 key + 参数」的数据模型，并区分 `playerText` 与 `agentText`；这会影响存档兼容、测试快照和 AI 提示词，建议单独立项，不塞进本次 i18n。
- 过渡方案：`createState` 把 `state.locale` 存下来，新增事件按 `state.locale` 生成玩家可见文本（AI 仍用中文）；旧事件保持原样。这样英文玩家看到的**新**事件是英文，历史事件仍是中文。

**第五步：偏好迁移**

- `web/catalog.js` 的 `preferences` 增加 `followHall`；默认 `true`。
- 大厅语言变化时，`onLocaleChange` 更新 `preferences.language`（若 follow）并重绘；玩家在游戏内切换卡牌语言时置 `followHall = false` 并写 `localStorage`。
- 注意 `preferences` 是模块级单例，多个大厅标签页共享同一个 localStorage；切换语言后需要重新读取/合并，避免另一个标签页的旧值覆盖。

### 8.8 联机

- 每位玩家运行自己的大厅（`docs/multiplayer.md`），所以「大厅语言」是每位玩家的本机设置，不需要同步给其他玩家。
- 房主创建房间时，对局状态按**房主**的语言生成（`session.locale`）。其他玩家看到的共享事件文本、AI 台词、剧情描述可能是房主语言；他们自己的大厅 chrome 和 Mod UI 仍按各自语言渲染。
- 大厅不做「把房主语言强推给客人」：那会覆盖客人的本机设置，而且客人可能看不懂房主语言。
- 如果以后要求每位玩家看到自己的语言，需要把 state 文本改成 key，并让 `viewState` 按观察者 locale 渲染，同时在大厅同步每位成员的 locale；这是 v2 范围。
- 邀请文案里的游戏名由房主大厅本地化；客人复制/粘贴邀请时原样显示，不需要翻译。

## 9. 回退规则（核心）

### 9.1 选语言

```js
const SOURCE_LOCALE = 'zh-CN'

export function resolveLocale(requested, i18n) {
  const supported = (i18n?.supportedLocales || []).map(normalizeLocale).filter(Boolean)
  const wanted = normalizeLocale(requested) || SOURCE_LOCALE

  // 0. 没有声明任何语言：旧 Mod，按源语言
  if (!supported.length) {
    return { requested: wanted, resolved: SOURCE_LOCALE, defaultLocale: SOURCE_LOCALE,
             supportedLocales: [], matched: 'source', fellBack: true }
  }

  // 0.1 归一化 defaultLocale：保证它一定在 supported 中。
  let defaultLocale = normalizeLocale(i18n?.defaultLocale)
  if (!defaultLocale || !contains(supported, defaultLocale)) {
    defaultLocale = contains(supported, SOURCE_LOCALE) ? SOURCE_LOCALE : supported[0]
    console.warn('[i18n] defaultLocale 不在 supportedLocales 中，已回退到 ' + defaultLocale)
  }

  // 1. 精确匹配（大小写不敏感）
  if (contains(supported, wanted)) {
    return { requested: wanted, resolved: wanted, defaultLocale, supportedLocales: supported,
             matched: 'exact', fellBack: false }
  }

  // 2. 同主语言：只接受「唯一的、语言-only 的」候选。
  //    en-US -> en 可以；zh-TW -> zh-CN 不可以（简繁不同，必须走默认语言）。
  const base = wanted.split('-')[0].toLowerCase()
  const sameBase = supported.filter(tag => tag.split('-')[0].toLowerCase() === base)
  if (sameBase.length === 1 && sameBase[0].split('-').length === 1) {
    return { requested: wanted, resolved: sameBase[0], defaultLocale, supportedLocales: supported,
             matched: 'base-language', fellBack: false }
  }

  // 3. 游戏自己的默认语言（上面已保证 defaultLocale ∈ supported）
  return { requested: wanted, resolved: defaultLocale, defaultLocale, supportedLocales: supported,
           matched: 'mod-default', fellBack: true }
}
```

细节：

- 第 2 步只接受**语言-only 的候选**（如 `en`），所以 `en-US` / `en-GB` 能落到 `en`；但 `zh-TW` 请求不会落到 `zh-CN`（简繁不能靠同主语言猜），而是走默认语言。如果以后支持 `zh` 这种语言-only 候选，`zh-TW` 会落到 `zh`，需要产品明确接受这种泛化。
- `defaultLocale` 在加载/解析时归一化：缺失、非法或不在 `supportedLocales` 中 → 若支持 `zh-CN` 则用 `zh-CN`，否则用 `supported[0]`，并 `console.warn`。因此**只要 supported 非空，`resolved` 与 `defaultLocale` 一定在 `supportedLocales` 中**；只有 supported 为空（旧 Mod/无声明）才退回源语言。
- `resolveLocale()` 返回 `{ requested, resolved, defaultLocale, supportedLocales, matched, fellBack }`；`resolveModLocale(mod, requested)` 只是把 `mod.i18n` 传给它的包装，不构建展示字段或 `files`（`files` 由 `localizeMod` / `catalogView` 补）。
- `matched` 的取值是 `exact` / `base-language` / `mod-default` / `source`；`legacy-name` 只由 §7.5 的 catalog 兼容层产生。
- `fellBack` 只表示「语言层面没匹配上」；字段层面的缺失不改变它，单独用 `missing` / 开发日志观察。
- `matched` 用于调试和可选的 UI 提示；不要把它暴露成用户可见的技术术语。

### 9.2 逐字段/逐 key 回退

对 Mod 元数据：

```
i18n.messages[resolved][field]
  → i18n.messages[defaultLocale][field]
  → mod 基础字段
```

对大厅词典：

```
当前语言[key]
  → zh-CN[key]
  → key（开发环境 warn）
```

对 Mod 前端词典：同大厅，只是默认层换成 Mod 的 `defaultLocale`。

对卡牌/图片这类结构化内容，由 Mod 自己定义字段级回退（诡镇的例子是 `nameZh || name`、`textZh || text`、`img/zh/... || img/...`），大厅不参与。只要最终结果遵循「resolved → default → source」的语义即可。

### 9.3 示例矩阵

| 大厅语言 | Mod 支持 | 结果 | `matched` | `fellBack` |
| --- | --- | --- | --- | --- |
| `zh-CN` | `['zh-CN', 'en']` | `zh-CN` | exact | false |
| `en` | `['zh-CN', 'en']` | `en` | exact | false |
| `en-US` | `['zh-CN', 'en']` | `en` | base-language | false |
| `en` | `['zh-CN']` | `zh-CN` | mod-default | true |
| `fr` | `['zh-CN', 'en']` | `zh-CN` | mod-default | true |
| `en` | 无 `i18n` | `zh-CN`（名称可用 `nameEn`） | source / legacy-name | true |
| 非法 `../../x` | 任意 | 按 `zh-CN` 处理，不拼路径 | 按 zh-CN 正常匹配（exact / mod-default / source） | 视支持而定 |
| `zh-CN` | `['zh-CN', 'en']` 但 `messages.zh-CN` 缺 `name` | 中文名（基础字段） | exact | false |

### 9.4 用户提示

- 默认**静默回退**：不弹窗、不打断游戏；设置页用一句说明告诉用户规则（§5.3）。
- 开发模式（`?debug=1` 或 `NODE_ENV !== 'production'`）可以在 `console.info` 打印 `[i18n] gobang requested=en resolved=zh-CN matched=mod-default`，方便排查。
- 可选（v2）：游戏卡片右上角显示一个小语言角标（`中文` / `English`），或在设置页列出「当前语言下哪些游戏会回退」；v1 不做，避免 UI 噪音。

### 9.5 不允许的回退

- 不因为游戏缺英文就自动把大厅切回中文（偏好是全局的，不能被某个游戏改写）。
- 不把 `defaultLocale` 当作「用户请求的语言」；它只是游戏自己的默认。
- 不用机器翻译或网络接口临时补文案；缺就是缺，按规则回退。
- 不把 `null`/`''` 当作有效翻译（空字符串也会被跳过，继续下一层）。
- 不从 locale 字符串拼文件路径（`web.locales` 是显式白名单，见 §7.6）。

## 10. 首次运行、切换与存档

### 10.1 首次运行

- 没有 `settings.json` → `zh-CN`。
- 不读取浏览器 `navigator.language` 做自动判断（v1）：项目现有用户与文案以中文为主，自动判断会让测试和首次体验不可预测。以后可以增加「跟随系统」选项，但仍以 `zh-CN` 为最终兜底。
- 不因为系统是英文就自动切英文；用户可以在设置里改。

### 10.2 切换

1. 用户在设置页选择语言。
2. `POST /api/settings` 原子落盘。
3. 大厅 `setLocale()`、重新拉 catalog、通知已加载的 Mod UI、整体重绘。
4. 新开/重开的对局使用新语言；进行中的对局不重写已有状态文本。
5. 刷新/重启后从 `settings.json` 恢复。
6. 设置是服务端全局偏好：同一个大厅进程的其它标签页不会收到推送，需要刷新后才换语言（v1 不做跨标签同步；需要时用 `storage`/SSE，不在本方案内）。

### 10.3 存档

- 新存档记录 `session.locale`（resolved）。
- 旧存档没有该字段：按当前大厅语言渲染 chrome；正文按存档里已有的文本显示。
- 不因读档而修改大厅语言；不因切换语言而批量重写存档。
- Mod 的 `saveCompatibilityError` / `migrateState` 不要求处理 locale；新增字段对旧快照是透明的。

### 10.4 联机

- 语言偏好是**每位玩家本机**的；不通过房间同步，不覆盖别人的设置。
- 房主开局时的 `resolved` 决定共享状态文本的语言；客人自己的 UI 用各自语言。
- 如果客人加入的是房主的房间，客人的大厅仍然读自己的 `settings.json`；房主重启/房主语言变化不会影响客人的界面语言。
- 这是 v1 的明确取舍；需要「全房间统一语言」时再讨论房间级设置（会与「每位玩家可读」冲突）。

## 11. 安全、性能与可访问性

### 11.1 安全

- locale 只作为**查表 key**，绝不拼进文件系统路径；`web.locales` 的路径是 Mod 显式声明的，走 `resolveWeb()` 的同一套越界检查。
- 词典是静态 JSON/ES module；不 `eval`、不 `new Function`、不把词典内容写入 `innerHTML`。
- 合并只接受白名单字段（name/description/tags/aiSlotLabel/aiSlotDescription/settings 的文本字段），拒绝 `__proto__` 等键。
- 旧 Mod 的 `validateMove` 错误文本仍可能包含未转义内容，但现有前端用文本节点渲染；本地化不改变这一点。
- `settings.json` 只含一个语言 tag，不含密钥/路径；写入使用临时文件 + rename，避免半截文件。

### 11.2 性能

- 大厅词典随 `app.js` 静态加载，启动多两个小模块（预计各 < 20 KB），不增加网络往返。
- Mod 语言包只在打开该游戏时由 Mod 动态 import；首页不会下载未打开游戏的语言包（与现有 Mod 脚本懒加载策略一致）。
- `localizeMod()` 只在需要展示 Mod 元数据的地方执行（`/api/catalog`、`updatesView()` 的已安装商店条目）；创建会话只需要 `resolveModLocale()`，不构建 `settingsSpec`。Mod 数量个位数、字段很少，开销可忽略；如未来 Mod 很多，可按 `(modVersion, locale)` 做进程内缓存。
- catalog 不携带完整 `messages`，避免把多语言词典发给客户端。
- 静态资源缓存沿现有规则：Mod 的 JS 走 `must-revalidate`，图片/音频走长缓存；语言包是 JS，更新后刷新即可生效。

### 11.3 可访问性

- `<html lang>` 与 `dir` 正确；语言切换后用 `role="status"` 播报。
- 英文布局在 390px 宽度、200% 缩放下不横向溢出；按钮/页签允许换行。
- 不依赖颜色/图标表达「当前语言」；下拉框本身显示语言名。
- 屏幕阅读器读到的是当前语言文本，不是 key。

## 12. 文件级改动清单

| 文件 | 改动 | 阶段 |
| --- | --- | --- |
| `lib/settings.js` | **新增**：`loadSettings` / `saveSettings` / `settingsView`，原子读写 `settings.json` | P1 |
| `lib/i18n.js` | **新增**：`HALL_LOCALES`、`normalizeLocale`、`resolveLocale`、`resolveModLocale`、`localizeMod`、`localizeStoreGame` | P1 |
| `lib/server.js` | 新增 `GET/POST /api/settings`；`catalogView(locale)`；`createSession()` 写 `session.locale` 并传 `createState` context；`handleApi`/`handleLocalApi` 传 locale；`sessionView` 用当前语言取 Mod 名 | P1/P3 |
| `lib/mods.js` | 校验 `i18n` / 顶层 `localize` / `web.locales`；`resolveWeb()` 生成 `localeUrls`；顶部契约注释补 i18n 段 | P3 |
| `lib/store.js` | `parseRegistry()` 支持可选 `localized`；`status()` 保持中立，由 `server.js` 按 locale 选取展示名 | P5 |
| `public/i18n.js` | **新增**：`setLocale` / `getLocale` / `t` / `formatDate` / `formatNumber` | P2 |
| `public/locales/zh-CN.js` | **新增**：大厅源语言词典（从现有中文抽取） | P2 |
| `public/locales/en.js` | **新增**：大厅英文词典 | P2 |
| `public/app.js` | boot 拉 `/api/settings`；新增语言页签；`loadModUi` 加 `host.locale`；语言切换通知 Mod；全量 `t()` | P2/P4 |
| `public/online-ui.js`、`updates-ui.js`、`feedback-ui.js`、`chat-compose.js`、`chat-notifications.js` | 文案 `t()` 化；日期/数字格式化 | P2 |
| `public/index.html` | 保留 `lang="zh-CN"` 兜底；可加 `data-locale`；标题由 `setLocale()` 更新 | P2 |
| `public/style.css` | 语言页签/下拉框；英文长文案的换行与宽度 | P2 |
| `games/arkhamhorror/index.js` | 增加 `i18n`（目录/设置元数据）与 `web.locales` | P5 |
| `games/arkhamhorror/web/i18n.js` | **新增**：Mod 侧 `t()` + fallback | P5 |
| `games/arkhamhorror/web/locales/{zh-CN,en}.js` | **新增**：游戏界面词典 | P5 |
| `games/arkhamhorror/web/catalog.js` | `cardFaceText` / 名称/文本统一入口；`preferences` 增加 `followHall` | P5 |
| `games/arkhamhorror/web/{game-ui,hub,table-regions,card-zoom,...}.js` | 替换直接 `nameZh \|\| name` 的写法；接入 `host.locale` / `onLocaleChange` | P5 |
| `tests/hall/i18n.test.mjs` | **新增**：解析、合并、设置读写、API、路径安全 | P1/P3 |
| `tests/hall/browser/i18n.browser.mjs` | **新增**：切换语言、刷新保持、回退、Mod 通知 | P2 |
| `tests/fixtures/mods/fixture-cards/index.js` | 增加 `i18n.messages` 与（可选）`web.locales`，供大厅回归验证契约 | P3 |
| `tests/fixtures/mods/fixture-i18n/` | **新增**：带最小 `createUI` / `onLocaleChange` 的测试 Mod；不随发布包分发 | P4 |
| `docs/updates.md` | 补 `registry/index.json` 的 `localized` 字段与游戏语言包打包说明 | P5 |
| `README.md` | 设置项、Mod 契约、目录结构补 i18n 链接 | P5 |
| `registry/index.json` | 可选：为商店里的游戏补 `localized.en` 名称/描述 | P5 |

打包注意：语言包放在 `web/locales/` 下会随现有 Mod 打包流程进入 ZIP；不要放到 `games/<id>/locales/` 或仓库根，否则 `web` 挂载和 `exclude` 规则都要改。`boardgame-mod.json` 的 `exclude` 不要误排除 `web/locales/`；`preserve` 不需要包含它。

## 13. 实施顺序与工作量

| 阶段 | 内容 | 估时 | 可独立上线 |
| --- | --- | --- | --- |
| P1 核心 | `settings.json` + `/api/settings` + `lib/i18n.js` + 单元/API 测试 | 1–1.5 人日 | 是（先无 UI） |
| P2 大厅壳 | `public/i18n.js`、`zh-CN` 抽取、`en` 词典、语言设置页、浏览器测试 | 2–3 人日 | 是 |
| P3 Mod 元数据 | `i18n` 契约、catalog 合并、`nameEn` 兼容、fixture 回归 | 1–1.5 人日 | 是 |
| P4 Mod 运行时 | `host.locale`、`onLocaleChange`、`createState`/`handleApi` 上下文、存档字段 | 0.5–1 人日 | 是 |
| P5 诡镇接入 | 目录/设置元数据、卡牌统一入口、界面主路径词典、偏好迁移 | 3–5 人日 | 是（可分两次发版） |
| P6 商店/文档 | registry `localized`、`docs/updates.md`、README、验收 | 0.5–1 人日 | 是 |

建议顺序：**P1 → P2 → P3 → P4 → P5 → P6**。P1/P3 可以并行开发（都依赖 `lib/i18n.js`），但 P2 的最终联调需要 P1 的 API。

## 14. 测试与验收

### 14.1 单元测试（`tests/hall/i18n.test.mjs`）

| 用例 | 断言 |
| --- | --- |
| 精确匹配 | `resolveLocale('en', { supportedLocales: ['zh-CN','en'], defaultLocale: 'zh-CN' })` → `en` / exact / false |
| 地区变体 | `en-US` + `['zh-CN','en']` → `en` / base-language / false |
| 同主语言多候选 | `zh-HK` + `['zh-CN','zh-TW']` → `zh-CN`（default）/ mod-default / true |
| 不支持 | `fr` + `['zh-CN','en']` → `zh-CN` / mod-default / true |
| 无 i18n | 返回源语言 + source / true |
| 非法输入 | `''`、`null`、`'../../x'`、超长、含空格 → 安全回退，不抛 |
| `defaultLocale` 非法 | 警告 + 归一化为 `zh-CN`（若支持）否则 `supported[0]`；只有空支持列表才回退源语言 |
| 字段合并 | 只覆盖提供的字段；`tags` 整体替换；未提供字段保留基础值 |
| 设置项合并 | 只覆盖 label/description/options；未知 key 忽略；选项按 `String(value)` 匹配 |
| `localize` 钩子 | 同步生效；抛错时忽略并保留静态结果 |
| 旧 Mod `nameEn` | en 请求只改 name，`matched=legacy-name`，`fellBack=true` |
| 路径安全 | `web.locales` 含 `..` / 绝对路径 / 不存在文件 → 拒绝加载 |
| 设置文件 | 缺省、损坏、非法 locale、保存后重读、未知字段保留、tmp 文件不残留 |

### 14.2 API 集成测试

用临时 `DSH_HOME` + `createServer({ mods })`（参考 `tests/hall/mod-boundary.test.mjs` 的写法）：

1. `GET /api/settings` 默认 `zh-CN`。
2. `POST /api/settings { locale: 'en' }` 后 `GET /api/catalog` 返回英文元数据。
3. 非法 locale → 400 + `code=INVALID_LOCALE`；设置不变。
4. 关闭服务器再启动（同一 `DSH_HOME`）→ 仍是 `en`。
5. 无 `i18n` 的旧 Mod → catalog 仍可用，英文下 `nameEn` 仅影响名称。
6. 带 `i18n` 但 `messages` 不完整 → 缺字段回退基础值，不 500。

### 14.3 浏览器测试（`tests/hall/browser/i18n.browser.mjs`）

1. 打开首页 → 设置 → 语言 → 选 English：
   - 页签、按钮、说明立即变英文（无需刷新）；
   - 语言下拉框保持 `English`；
   - `<html lang="en">`。
2. 刷新页面 → 仍是英文（`settings.json` 持久化）。
3. 切回 `简体中文` → 中文恢复；无控制台报错。
4. 打开一个带 `i18n` 的 fixture Mod（`tests/fixtures/mods/fixture-i18n`）：
   - 目录名/描述/设置标签是英文；
   - 模拟切换语言 → `onLocaleChange` 被调用，文本更新，对局状态不变。
5. 打开一个只有 `nameEn` 的旧 Mod：名称为英文，描述/设置仍中文，且 `fellBack` 在 catalog 里为 true。
6. 390px 宽度下英文设置页不横向溢出。
7. 现有中文用例保持通过（默认 `zh-CN`，选择器不变）。

### 14.4 诡镇回归

```bash
npm run test:hall
npm run test:hall:browser
npm run test:mod -- arkhamhorror fast
npm run test:mod -- arkhamhorror browser
```

手工验收：

- 大厅 English → 诡镇目录/开局表单英文；
- 游戏内主界面按钮/标题英文；
- 卡牌图鉴与桌面卡名一致（不再出现图鉴英文、桌面中文）；
- 卡图缺失英文版时回退中文/通用图，不显示破图；
- 切回中文后全部恢复；
- 旧 `arkham.presentation` 数据能正常读取，不丢失卡图主机/变体设置。

### 14.5 验收清单

- [ ] 设置里能切换 `简体中文` / `English`，立即生效。
- [ ] 刷新/重启大厅后语言保持。
- [ ] 大厅所有主路径文案、`title`、`aria-label` 跟随语言。
- [ ] 游戏目录/描述/标签/设置项跟随语言。
- [ ] 游戏没有当前语言时回退到 `defaultLocale`，可观察到 `fellBack=true`。
- [ ] 游戏语言包缺失单个 key 时回退默认语言/源文案，不出现空白/裸 key。
- [ ] 新对局记录 `session.locale`；旧存档可读、不被改写。
- [ ] 旧 Mod、旧版大厅、旧 `registry` 数据不受影响。
- [ ] `npm run test:hall`、`npm run test:hall:browser`、诡镇 fast/browser 全绿。

## 15. 兼容、迁移与回滚

| 场景 | 行为 |
| --- | --- |
| 旧大厅（无 `/api/settings`） | 新前端请求 404 → 回退 `zh-CN`；不阻塞启动（但新语言包不会生效） |
| 旧 Mod（无 `i18n`） | 按基础中文字段加载；英文下可选 `nameEn` 兼容；`HALL_API` 不变 |
| 新 Mod + 旧大厅 | 旧大厅忽略 `i18n` / `web.locales` 字段（`web` 只认已知字段），游戏仍显示中文基础文案；Mod 前端需对 `host.locale` 缺失做防御 |
| 旧存档 | 无 `session.locale`；按当前大厅语言渲染 chrome，正文保持原文本；不迁移、不重写 |
| 旧 `settings.json` / 无文件 | 默认 `zh-CN` |
| 回滚大厅版本 | 旧大厅忽略 `settings.json`，按中文运行；语言包文件留在磁盘无副作用 |
| 回滚 Mod 版本 | 新语言包随包回退；存档中的 locale 字段被旧 Mod 忽略（普通 JSON 字段） |

`HALL_API` 决策：**本次不升级**。新增字段与参数全部向后兼容；只有未来要求 Mod 必须声明 `i18n.defaultLocale` 或改变 `host.locale` 语义时才需要升 `HALL_API`。

## 16. 未决问题

| 问题 | 建议 | 理由 |
| --- | --- | --- |
| 首次运行是否跟随系统语言 | v1 固定 `zh-CN`，以后加「跟随系统」选项 | 可预测、测试稳定；中文用户占多数 |
| 游戏内的卡牌语言是否允许覆盖大厅 | 允许，但默认 `followHall=true`；只有玩家显式改过才覆盖 | 诡镇玩家常中英卡混用；默认仍满足「同步大厅」 |
| AI 台词/角色人设是否翻译 | v1 不翻译；以后在 system prompt 里加 `reply in <locale>` 并单独评估质量/成本 | 翻译提示词会改变模型行为，影响现有回归与角色一致性 |
| 是否在游戏卡片上显示回退角标 | v1 不显示；保留 `i18n.fellBack` 字段供以后使用 | 避免 UI 噪音；设置页已有规则说明 |
| 服务端错误是否全部本地化 | v1 用错误码 + 客户端映射，逐步覆盖高频错误 | 比服务端维护词典简单，且联机时错误来自房主，语言未必一致 |
| 商店列表的翻译由谁维护 | 大厅仓库的 `registry/index.json` 维护；游戏仓库只负责包内语言 | 未安装时只能读 registry；已安装时以 Mod 为准 |
| 繁体中文 | 暂不加入 `zh-TW`；需要时作为独立 locale 增加词典与测试 | 简繁不是字符串替换，需人工校对 |
| 复数/ICU | v1 用不依赖复数的句式；需要时引入 `Intl.PluralRules` 小工具，不引第三方库 | 控制体积与复杂度 |
| 联机是否统一语言 | v1 各自本机语言；共享正文按房主开局语言 | 强推会覆盖客人设置；逐观察者本地化需要状态 key 化 |
| `validateMove` 的错误文本同时给玩家和模型，是否本地化 | v1 保持源语言（中文）；玩家侧错误可能中英混排，后续加 `context.locale` 或错误码 | 避免模型看到未验证的翻译，也避免为一个错误字符串改函数签名 |
| `session.locale` 是否用于读档时切换大厅 | 不切换 | 偏好是全局的；读一份英文存档不应该把整个大厅变英文 |

## 17. 参考资料

- `lib/mods.js`：Mod 接口契约（顶部注释是完整文档）。
- `lib/server.js`：`catalogView()`、`createSession()`、`handleApi()`、`handleModApi()`。
- `public/app.js`：`boot()`、`loadModUi()`、`renderSettingsModal()`、`renderSetupModal()`。
- `lib/update-common.js`：`hallDataDir()` / `loadUpdateSettings()` 的原子读写模式。
- `lib/agent/config.js`：`saveConfig()` 的「仅覆盖传入字段」写法。
- `lib/sessions.js`：快照结构与向后兼容。
- `games/arkhamhorror/web/catalog.js`：`preferences`、`cardFaceText()`。
- `games/arkhamhorror/web/images.js`：`imageCandidates()` 的中文/通用回退顺序。
- `docs/updates.md`：`registry/index.json`、游戏打包与 `hallApi` 规则。
- `docs/multiplayer.md`：每人运行自己的大厅、房主执行规则的联机模型。
- `docs/testing.md`：大厅/Mod 测试分层与命令。
- BCP 47（RFC 5646）：<https://www.rfc-editor.org/rfc/rfc5646>
- MDN `Intl`：<https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Intl>

## 18. 实现记录（2026-10-24）

### 18.1 落地范围

| 阶段 | 状态 | 主要文件 |
| --- | --- | --- |
| P1 核心 | ✅ | `lib/settings.js`、`lib/i18n.js`、`lib/server.js`（`GET/POST /api/settings`、`catalogView(locale)`、`updatesView(locale)`）、`tests/hall/i18n.test.mjs` |
| P2 大厅壳 | ✅ | `public/i18n.js`、`public/locales/{zh-CN,en}.js`（429 key，1:1）、`public/app.js`、`public/index.html`、`public/style.css`、`public/online-ui.js`、`public/updates-ui.js`、`public/feedback-ui.js`、`tests/hall/i18n-dict.test.mjs`、`tests/hall/browser/i18n.browser.mjs`、`tests/hall/browser/settings.browser.mjs` |
| P3 Mod 元数据 | ✅ | `lib/mods.js`（i18n/localize/web.locales 校验 + `web.localeUrls`）、`lib/store.js`（registry `localized`）、`tests/fixtures/mods/fixture-i18n/`、`tests/fixtures/mods/fixture-cards/`、`tests/hall/mod-i18n.test.mjs` |
| P4 Mod 运行时 | ✅ | `public/app.js`（`host.locale` / `onLocaleChange` / `hosts` 表）、`lib/server.js`（`createState`/`handleApi`/`handleLocalApi` 语言上下文、`session.locale`、联机 `sessionView` 分支） |
| P5 诡镇接入 | ◐ 第一、二阶段完成，第三步部分 | `games/arkhamhorror/index.js`、`web/i18n.js`、`web/locales/{zh-CN,en}.js`（120 key）、`web/catalog.js` 卡牌展示统一入口、`web/{game-ui,hub,table-regions,card-zoom,story-reader,situation-view,tcu-ui}.js`、`preferences.followHall` |
| P6 商店/文档 | ✅ | `registry/index.json`（arkhamhorror `localized.en`）、`docs/updates.md`、`README.md` |

P5 第三步剩余项：hub 开局弹窗/各页签正文、situation/chaos bag/rulebook/music/tcu 面板、`renderFullCard` 内部字段标签、服务端下发的卡包/职业名；引擎生成事件、剧情、地点/幕名属于 §1.2 非目标。

### 18.2 相对本方案的实现取舍

1. **legacy-name 兼容层放在 `lib/i18n.js` 的 `localizeMod()`**，catalog 与商店「已安装」条目共用；`resolveLocale()` 本身仍只返回 `exact/base-language/mod-default/source`（符合 §7.5「catalog 层兼容标记」的语义）。
2. **商店排序在 `server.js` 的 `updatesView()` 里按当前 locale 重排**（§5.5 允许的第二种做法）：`lib/store.js` 的 `status()` 保持中立；`parseRegistry()` 校验并保留 `localized`，`status()` 把 `localized` 带到游戏条目上，由服务端选展示名。
3. `public/i18n.js` 额外导出 `normalizeLocale` / `HALL_LOCALES` / `hallLocales` / `hasKey`，供设置页兜底与词典完整性测试使用；解析/回退算法与服务端 `lib/i18n.js` 保持同一规则，但两端各自独立（浏览器不 import 服务端模块）。
4. 浏览器用例在「已开局、设置页不可达」时通过 `await import('/app.js')` 调用导出的 `saveLocale()`，走与设置页完全相同的保存链路；这是测试出口，无生产副作用。
5. `errorText()` 按 §6.3 映射带 `code` 的服务端错误；大量旧错误仍无 code，继续显示服务端中文兜底（后续触碰对应代码时逐步补 code）。
6. 语言页签放在设置页最后；语言下拉使用 `data-testid="hall-locale"`，`aria-label` 保持参数名等既有测试选择器不变（模型高级参数页的 `maxTurnCalls` 等）。
7. §1.2 非目标保持不变：AI 台词、引擎文本、历史存档回译、RTL/ICU、机器翻译均未做。

### 18.3 验证结果（2026-10-24）

- `npm run test:hall`：**210 passed / 0 failed**（含新增 `i18n`、`mod-i18n`、`i18n-dict` 与既有 29 个用例文件）。
- `npm run test:hall:browser`：**14 passed**（含新增 `i18n.browser.mjs` 4 个用例；其余既有用例保持通过）。
- 诡镇奇谈：`npm run test:mod -- arkhamhorror fast` 3322 passed / 4 failed；4 项失败均为**改动前已存在的**内容/账本用例（dunwich 卡牌槽位、state-presentation 旧存档补槽、tcu 发布与迁移账本），不 import 本次改动的展示模块；`build-presentation --check` 的 `audit/presentation-report.json` drift 也是既有状态，按约定未盲目重生成。
- 端到端抽查：`localizeMod(indexMod,'en')` 输出全英文名称/描述/标签/16 项设置/5 个战役名；`loadModFrom` 后 `mod.web.localeUrls` 与 catalog `i18n.files` 一致；切回 zh-CN 与基础字段 deep-equal。
