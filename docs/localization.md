# 大厅与游戏本地化（i18n）设计框架

> 状态：已实现（2026-10）。本文档只保留设计框架；逐文件实现细节以代码、测试与提交历史为准。代码或旧文档注释里出现的章节号（如 §8.2、§8.7）对应本方案的历史长版本，内容已并入下列各节。

## 1. 目标与非目标

**目标**

1. 「设置」里能切换大厅语言，立即生效，刷新/重启后保留。
2. 大厅自身文案（导航、设置、开局、联机、更新等）跟随语言。
3. 每个游戏自带自己的本地化资源（目录/开局元数据 + 游戏界面），随游戏版本发布，不需要改大厅代码。
4. 游戏界面跟随大厅当前语言；游戏没有该语言时，回退到游戏自己声明的默认语言。
5. 单条文案缺失时逐字段回退，不出现空白或 `undefined`；主路径不出现裸 key。
6. 旧 Mod、旧存档、旧版大厅行为不变。

**非目标（v1）**：AI 台词/人设翻译、规则引擎全量文案 key 化、历史存档回译、RTL/ICU 复数、运行时机器翻译、把房主语言强推给联机玩家。

一句话设计：**语言偏好归大厅，本地化资源归游戏；服务端解析一次并下发已解析结果，客户端不重复实现解析算法。**

## 2. 总体结构

```
大厅
  settings.json { locale }  ←→  GET/POST /api/settings
        │
  lib/i18n.js  resolveLocale / localizeMod / resolveModLocale
        │
        ├─ /api/catalog      已本地化的游戏元数据 + game.i18n（解析结果与语言包 URL）
        ├─ createSession()   session.locale + createState(..., { locale, requestedLocale })
        └─ handleApi()       传入 locale / requestedLocale
        │
  public/i18n.js + public/locales/*.js（大厅自己的词典）
        │
  createUI(host) ── host.locale ──> Mod 前端（自带 web/locales/）
```

核心原则：

1. **偏好与资源分离**：大厅只保存「当前语言」一项偏好；文本资源属于各自所有者（大厅 `public/locales/`，游戏包内 `web/locales/`）。
2. **服务端解析一次**：语言选择、Mod 元数据合并、回退都在 `lib/i18n.js` 完成，避免两端结果不一致。
3. **元数据在服务端本地化**：目录卡片、开局表单由大厅渲染，不能等 Mod 脚本加载后再翻译。
4. **游戏正文由 Mod 自己翻译**：大厅不知道卡牌/战役/规则文本的结构，只把 `resolved` 与语言包 URL 交给 Mod。
5. **分层回退**：先选语言，再逐字段/逐 key 回退。
6. **渐进增强**：没有 `i18n` 的旧 Mod 按源语言工作；新增字段全部可选，不升级 `HALL_API`。

## 3. 语言标识与回退规则

大厅支持：`zh-CN`（源语言、默认值、简体中文）与 `en`（English），列表由服务端下发。

- 规范化：BCP 47 子集（语言[-地区]），如 `zh-cn → zh-CN`、`en_us → en-US`；`zh → zh-CN` 是最小别名；非法输入不抛异常。
- **选语言（Mod）**：精确匹配 → 同主语言且候选唯一且语言-only（`en-US → en`）→ 游戏 `defaultLocale` → 源语言。简繁不互相猜（`zh-TW` 不会自动落到 `zh-CN`）。
- **字段/key 回退**：`resolved` → `defaultLocale`（或大厅 `zh-CN`）→ Mod 基础字段 / 词条 key。空字符串不算有效翻译。
- 旧 Mod 英文兼容：无 `i18n` 时可用 `nameEn` 显示名称，目录标记 `matched='legacy-name'`、`fellBack=true`，其余文案保持默认语言。

## 4. 大厅侧

**偏好存储**：`<DSH_HOME 或 ~/.dsh>/boardgame-hall/settings.json`（原子写；损坏/非法回退 `zh-CN`，保留未知字段）。读写由 `lib/settings.js` 负责。

**API**：`GET /api/settings` 返回 `{ ok, settings, locales }`；`POST /api/settings { locale }` 立即落盘，成功返回同一结构，非法语言返回 `400 INVALID_LOCALE`。

**大厅文案**：`public/i18n.js` 提供 `setLocale / t(key, vars) / formatDate / formatNumber`；词典是 `public/locales/<tag>.js` 的扁平对象（`{name}` 插值，无格式化库）。切语言时 `boot()` 先 `setLocale` 再首次渲染，并重新拉取 catalog、通知已加载的 Mod。

**设置页**：设置弹窗中的「语言」页签，下拉选择后立即保存；失败回滚并提示。页签、滚动、焦点应保持。

## 5. Mod 契约

`games/<id>/index.js` 可选声明：

```js
export default {
  // 基础字段是源语言兜底
  name, description, tags, aiSlotLabel, aiSlotDescription,

  i18n: {
    defaultLocale: 'zh-CN',              // 游戏自己的默认语言，必须在 supportedLocales 中
    supportedLocales: ['zh-CN', 'en'],   // 规范化、去重、最多 20
    messages: {                          // 只覆盖展示文本，不改 type/default/选项集合
      en: { name, description, tags, aiSlotLabel, aiSlotDescription,
            settings: { <key>: { label, description, options: { value: 'label' } } } },
    },
  },

  // 可选：动态元数据（同步纯函数，如从内容注册表取英文名）
  localize(locale) { return null },

  web: {
    dir: 'web',
    locales: { 'zh-CN': 'locales/zh-CN.js', en: 'locales/en.js' }, // → mod.web.localeUrls
  },
}
```

约束：`messages` 只允许已知展示字段；`localize` 必须同步；`web.locales` 路径不得越界，文件必须存在；结构性问题警告后降级为"无 i18n"，路径越界直接拒绝加载。

**下发给前端**：catalog 条目附带 `i18n: { requested, resolved, defaultLocale, supportedLocales, matched, fellBack, files }`；`files` 是语言包绝对 URL。

**客户端运行时**：

- `createUI(host)` 的 `host.locale` 即上述 `i18n` 对象；旧大厅可能没有该字段，Mod 需防御（`host.locale?.resolved || 'zh-CN'`）。
- 语言切换时大厅更新 `host.locale` 并调用 `ui.onLocaleChange?.(host.locale)`；要求同步、幂等、只重绘文案，不重置对局、不重新请求存档。
- 长期存活的 DOM（音乐播放器、规则书等）可在 Mod 内用 `subscribeLocaleChange(listener)` 自行刷新。

**服务端/存档上下文**：`handleApi`/`handleLocalApi` 收到 `locale`/`requestedLocale`；`createState(settings, players, { locale, requestedLocale })`；新会话记录 `session.locale = resolved`。`describeState`/`validateMove` 默认保持源语言，避免模型看到未验证翻译。

## 6. 游戏商店

未安装的游戏只能读 `registry/index.json`，因此商店条目可选：

```json
{ "id": "arkhamhorror", "name": "诡镇奇谈：卡牌版",
  "localized": { "en": { "name": "Arkham Horror: The Card Game", "description": "..." } } }
```

已安装的游戏以 Mod 自己的 `i18n` 为准；registry 只负责"还没装"时的展示名与描述，非法条目忽略并回退基础文案。

## 7. 文件一览

| 位置 | 作用 |
| --- | --- |
| `lib/settings.js` | 大厅偏好（语言）读写 |
| `lib/i18n.js` | 语言规范化、选语言、Mod 元数据合并与回退 |
| `lib/mods.js` | Mod `i18n` / `localize` / `web.locales` 校验，生成 `localeUrls` |
| `lib/server.js` | `/api/settings`、catalog/商店本地化、会话与 Mod 接口语言上下文 |
| `lib/store.js` | registry `localized` 解析 |
| `public/i18n.js` | 浏览器端 `t/setLocale/formatDate/formatNumber` |
| `public/locales/<tag>.js` | 大厅词典（扁平 key） |
| `public/app.js` 及各 `*-ui.js` | 大厅界面文案、语言设置页、`host.locale` 注入与通知 |
| `games/<id>/web/locales/<tag>.js` | 游戏界面词典（游戏自带） |

新增大厅语言：改 `lib/i18n.js` 的 `HALL_LOCALES` → 新增 `public/locales/<tag>.js` 并在 `public/i18n.js` 注册 → 测试。新增游戏语言：在 Mod 的 `i18n` / `web.locales` 中声明即可，无需改大厅。

## 8. 验收与已知限制

验收命令：`npm run test:hall`、`npm run test:hall:browser`、`npm run test:mod -- <id> fast/browser`。关键回归点：语言设置持久化、目录/开局表单跟随语言、缺语言回退 `defaultLocale`、旧 Mod `nameEn` 兼容、旧存档可读、游戏内 `onLocaleChange` 不重置对局、词典完整性（中英 key/占位符一致、无重复 key、主路径无裸 key）。

已知限制：引擎生成的剧情/事件正文与内容数据名（卡牌/地点/战役等）保持源语言；服务端旧错误仍可能中文兜底（带 `code` 的错误由前端映射）；游戏内卡牌语言可独立于界面语言（`followHall` 默认开启）。
