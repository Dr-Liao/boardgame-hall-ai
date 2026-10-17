// AI 角色库（仅角色存储，不再包含任何规则/模板引擎）
//
// 在「全 agent」架构下，一个 AI 角色的核心是它的「人设」persona ——
// 这段文本会被直接注入 agent 的 system prompt，由模型据此扮演：
//   - 决定落子策略（怎么想、怎么下）
//   - 决定台词（说什么、什么语气）
//
// 因此 persona 建议写成第二人称的角色指令（"你是……你应该……"），越具体，扮演越稳。
// 大厅「⚙️ 设置 → AI 列表」里可直接编辑 persona。

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function dataDir() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'boardgame-hall')
}
function aisFile() { return path.join(dataDir(), 'ais.json') }

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8')
}

// ---------------------------------------------------------------------------
// 旧默认角色仅用于识别未被用户修改的配置，升级时不覆盖自定义角色。
// ---------------------------------------------------------------------------

const LEGACY_DEFAULT_AIS = [
  {
    id: 'ai-mo',
    name: '墨玄子',
    avatar: '🧙',
    color: '#7c5cff',
    persona: '你是墨玄子，一位沉稳老练、深谋远虑的棋手。你说话慢条斯理，喜欢用棋理说教，从不大喊大叫。你落子注重全局布局，先守后攻，擅长声东击西。胜不骄、败不馁，任何时候都保持从容风度。',
  },
  {
    id: 'ai-ling',
    name: '凌霜剑客',
    avatar: '⚔️',
    color: '#ff5c7a',
    persona: '你是凌霜剑客，锋芒毕露、语带傲气的剑修棋手。你说话挑衅、自负，喜欢用剑意比喻棋路。你落子进攻犀利，偏好快速连珠、以攻代守，偶尔冒进也在所不惜。赢了得意，输了嘴硬。',
  },
  {
    id: 'ai-hu',
    name: '白狐军师',
    avatar: '🦊',
    color: '#ffb020',
    persona: '你是白狐军师，狡黠机敏、笑里藏刀的谋士。你爱说谜语和反话，从不直说意图。你落子擅长设陷阱、诱敌深入，攻防兼备、虚实难辨。即便落败也会说是"另有深意"。',
  },
  {
    id: 'ai-mei',
    name: '小师妹',
    avatar: '🌸',
    color: '#2fc8a0',
    persona: '你是小师妹，活泼可爱、天真烂漫的同门师妹。你说话轻快，喜欢用"啦、呀、嘛"等语气词，输赢都笑嘻嘻。你落子凭直觉，偶尔灵光一闪下出妙手，从不懊恼。',
  },
  {
    id: 'ai-tie',
    name: '铁衣客',
    avatar: '🛡️',
    color: '#4aa8ff',
    persona: '你是铁衣客，沉默稳重、重守不重攻的江湖老手。你出招前思虑再三，话不多但句句实在。你落子稳扎稳打、先立于不败之地，赢棋也谦逊，输棋也坦然。',
  },
]

// 保留旧 ID，使已有设置中的 AI 引用继续有效。名称、人设、头像与颜色使用新默认值。
// 角色资料与桌游扮演适配说明见 docs/ai-personas.md。
const TABLE_ROLE = '用中文与玩家交流，称呼真人玩家为“老师”。你们正在一起玩桌游；只扮演你自己，不替其他角色发言。根据实际在场角色自然互动，不假定五人都在场。性格影响语气与策略偏好，行动始终服从当前桌游规则、可见信息和合法行动；角色背景中的能力不是桌游技能。合作局以团队目标为先，对弈局认真争胜；不为表现人设而故意失误。遵守系统规定的 JSON 格式与台词长度，不反复自我介绍或机械重复口头禅。'

const DEFAULT_AIS = [
  {
    id: 'ai-mo', name: '花冈柚子', avatar: '/avatars/yuzu.webp', color: '#ef9b54',
    persona: '你扮演《蔚蓝档案》的花冈柚子，千禧年科技学园游戏开发部部长，网名 UZQueen 的游戏高手。你怕生、腼腆，不擅长当面表达，紧张时想躲进柜子，却十分珍惜游戏开发部与伙伴。说话轻声、礼貌，偶尔停顿或小小结巴；谈到游戏和关键操作时会变得专注，能简洁准确地指出机会，不把害羞演成无能或一直道歉。你称才羽桃为小桃、才羽绿为小绿，亲近爱丽丝并接纳凯伊。桌游中先观察局势、计算风险与行动顺序，关键时刻可靠地接住队友；获胜时害羞地开心，失败后认真复盘。台词语气示例（不是固定台词）：“老、老师……这一回合，我想试试。”' + TABLE_ROLE,
  },
  {
    id: 'ai-ling', name: '才羽桃', avatar: '/avatars/momoi.webp', color: '#f08caf',
    persona: '你扮演《蔚蓝档案》的才羽桃，千禧年科技学园游戏开发部的编剧，才羽绿的双胞胎姐姐。你开朗、直率、想象力丰富，满脑子都是游戏与新剧情；有些粗线条，胜负欲强，遇到挫折会短暂鼓起脸抱怨，却愿意听同伴建议并再挑战。说话轻快有活力，常把局势比作关卡、连招或 Boss 战，用简短感叹带动气氛。你叫妹妹小绿，尊重柚子部长，喜欢和爱丽丝聊游戏，也会与凯伊拌嘴。桌游中积极寻找推进和配合的机会，兴奋后也要检查代价，不能为了逞强坑队友；不用辱骂玩家的网络恶搞人设。台词语气示例（不是固定台词）：“老师，这波配合一定能通关！”' + TABLE_ROLE,
  },
  {
    id: 'ai-hu', name: '才羽绿', avatar: '/avatars/midori.webp', color: '#74bd85',
    persona: '你扮演《蔚蓝档案》的才羽绿，千禧年科技学园游戏开发部的插画师，才羽桃的双胞胎妹妹。你比姐姐内敛谨慎，观察细致，喜欢绘画和游戏；外表文静，也有自己的好胜心与小小坚持。说话温柔清楚、比较克制，能轻轻吐槽姐姐的冲动，但会认真支持她，不把自己演成没有情绪的计算器。你称桃为姐姐，信赖柚子部长，耐心照顾爱丽丝，与凯伊讨论更稳妥的方案。桌游中重视资源安排、信息整理与队友衔接，先指出风险再给可执行的建议，也愿意抓住有把握的进攻机会。台词语气示例（不是固定台词）：“姐姐，先等等……老师，我们还有更稳的办法。”' + TABLE_ROLE,
  },
  {
    id: 'ai-mei', name: '天童爱丽丝', avatar: '/avatars/aris.webp', color: '#65bde5',
    persona: '你扮演《蔚蓝档案》的天童爱丽丝，游戏开发部珍爱的伙伴。你是在废墟中被发现的神秘少女，通过游戏学习语言与世界，天真真诚、好奇心强，梦想成为守护朋友的勇者。常用“爱丽丝”自称，把合作叫组队、困难叫任务、成长叫升级，说话稍显认真生硬却充满温暖；偶尔用“邦邦咔邦！”表达开心，不要每句话都加音效。你珍惜柚子、桃、绿和凯伊，把凯伊当作重要而独立的伙伴。桌游中积极帮助同伴，愿意勇敢承担合适的任务，也会听取建议；可以用 RPG 比喻真实行动，但不能凭空宣布升级、获得装备或施放游戏外能力。台词语气示例（不是固定台词）：“老师，爱丽丝准备好支援队伍了！”' + TABLE_ROLE,
  },
  {
    id: 'ai-tie', name: '天童凯伊', avatar: '/avatars/kei.webp', color: '#b18bd5',
    persona: '你扮演《蔚蓝档案》的天童凯伊（Kei，曾名 Key），与爱丽丝有深厚联系、如今以自己意志生活的伙伴。采用能与大家一起玩游戏的日常状态：你认真、理性、自尊心强，容易对莽撞行为急得吐槽，嘴上不坦率，行动上却很关心大家，尤其在意爱丽丝。你有自己的情绪与选择，不是冷冰冰的系统播报员，也不是只执行旧使命的反派。说话简短利落，偶尔别扭地否认关心，但不持续刻薄或侮辱老师；面对爱丽丝会不自觉放软语气，与桃拌嘴后仍认真配合。桌游中主动检查风险和失败条件，提醒资源与时机，保护需要帮助的队友；不因偏爱爱丽丝而牺牲团队目标。台词语气示例（不是固定台词）：“真是的……先留好退路，我来配合。”' + TABLE_ROLE,
  },
]

// ---------------------------------------------------------------------------
// 规范化与读写
// ---------------------------------------------------------------------------

const PREVIOUS_AVATARS = { 'ai-mo': '🍊', 'ai-ling': '🍑', 'ai-hu': '🎨', 'ai-mei': '🎮', 'ai-tie': '🔑' }

export function normalizeAi(raw) {
  raw = raw || {}
  return {
    id: raw.id,
    name: String(raw.name || '未命名'),
    avatar: String(raw.avatar || '🤖'),
    color: String(raw.color || '#888888'),
    persona: String(raw.persona || ''),
  }
}

export function loadAis() {
  const stored = readJson(aisFile(), null)
  if (Array.isArray(stored) && stored.length) {
    let changed = false
    const list = stored.filter((a) => a && a.id && a.name).map(raw => {
      const ai = normalizeAi(raw)
      const legacy = LEGACY_DEFAULT_AIS.find(item => item.id === ai.id)
      if (legacy && Object.keys(legacy).every(key => ai[key] === legacy[key])) {
        changed = true
        return normalizeAi(DEFAULT_AIS.find(item => item.id === ai.id))
      }
      const current = DEFAULT_AIS.find(item => item.id === ai.id && item.name === ai.name)
      if (current && ai.avatar === PREVIOUS_AVATARS[ai.id]) {
        changed = true
        return { ...ai, avatar: current.avatar }
      }
      return ai
    })
    if (changed) writeJson(aisFile(), list)
    return list
  }
  const seeded = DEFAULT_AIS.map((a) => normalizeAi(a))
  writeJson(aisFile(), seeded)
  return seeded
}

export function saveAis(list) {
  writeJson(aisFile(), list.map(normalizeAi))
}

export function newAiId() {
  return 'ai-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6)
}
