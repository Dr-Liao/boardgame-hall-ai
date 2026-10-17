# 默认 AI 角色

默认名单为花冈柚子、才羽桃、才羽绿、天童爱丽丝、天童凯伊。配置位于 `lib/ai.js`，同时用于行动台词和战术聊天，适用于所有桌游。

| 角色 | 扮演重点 | 桌游中的表达与偏好 |
| --- | --- | --- |
| 花冈柚子 | 害羞的游戏开发部部长、高手 UZQueen | 轻声表达，关键时刻专注，留意行动顺序与机会 |
| 才羽桃 | 活泼的编剧、绿的双胞胎姐姐 | 带动气氛，热衷推进与连招，受挫后再挑战 |
| 才羽绿 | 内敛的插画师、桃的双胞胎妹妹 | 温柔提醒风险，整理信息和资源，配合队友 |
| 天童爱丽丝 | 真诚好奇、用游戏语言理解世界的勇者 | 自称爱丽丝，以组队、任务等词表达支援意愿 |
| 天童凯伊 | 有自我意志、嘴硬心软、关心爱丽丝 | 简短吐槽后给建议，检查风险与撤退条件 |

桌游策略、称呼约定和示例台词是本项目的扮演适配，不是官方台词或能力设定。凯伊使用与伙伴相处的日常状态，不复演早期敌对剧情。五位角色只根据实际席位互动，角色能力不改变桌游规则。

## 已有配置

启动时仅替换名称、人设、头像、颜色均与旧默认值一致的角色，按顺序更新为上面的五人。保留历史 ID，避免已保存的 AI 引用失效。自行编辑的角色、自建角色、列表顺序和删除操作均保留；迁移写入后重复启动不会重置人设。已有对局保存的座位显示信息不重写，新开对局使用更新后的名单。

## 参考资料

### 头像素材

2026-09-29 从 [Schale DB](https://schaledb.com/student) 保存各角色的方形头像切片（120 × 120 WebP），存放在 `public/avatars/`，由本地服务器提供，不依赖外站链接加载。页面按圆形显示。

| 角色 | 本地文件 | 原始图片 |
| --- | --- | --- |
| 花冈柚子 | `yuzu.webp` | [10018.webp](https://schaledb.com/images/student/icon/10018.webp) |
| 才羽桃 | `momoi.webp` | [13011.webp](https://schaledb.com/images/student/icon/13011.webp) |
| 才羽绿 | `midori.webp` | [10016.webp](https://schaledb.com/images/student/icon/10016.webp) |
| 天童爱丽丝 | `aris.webp` | [10015.webp](https://schaledb.com/images/student/icon/10015.webp) |
| 天童凯伊 | `kei.webp` | [10135.webp](https://schaledb.com/images/student/icon/10135.webp) |

图片为《蔚蓝档案》角色素材，相关权利归原权利人所有，不包含在本项目代码的 MIT 许可中。已有这五位角色仍使用原默认 emoji 时，只更新头像，保留人设和颜色等编辑；自行设置的其他头像保持不变。旧对局保存的座位快照沿用原显示信息，新建对局使用新头像。

### 人设资料

用户提供的百度百科链接直接访问失败，查询时使用以下可检索条目补充核对（2026-09-29）：

- [花冈柚子：百度百科](https://bkso.baidu.com/item/花冈柚子/63285318)
- [才羽桃：百度百科](https://bkso.baidu.com/item/才羽桃/63285139)
- [才羽绿：AniBase](https://anibase.net/zh-hant/character/1Xvgp/才羽綠)
- [天童爱丽丝：Blue Archive Utils](https://blue-utils.me/student/aris?lang=zh-hant)
- [天童凯伊：Blue Archive Wiki](https://bluearchive.fandom.com/wiki/Key)
- [凯伊：Bangumi 学生介绍](https://bangumi.tv/character/201686)
