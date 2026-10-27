// 验证：往事回声里「密谋推进时清除场上所有毁灭」的修复。
// 复刻玩家当局的成因：1a 因敌人身上的毁灭达到阈值推进 → 旧代码把 5 点毁灭留在异教徒身上，
// 随后 03146「邪教的搜查」会把它们搬进新密谋（截图里的 9/6）。修复后推进即清空。
import { createGameState, startScenario, applyMove, decisionSeat } from '../games/arkhamhorror/src/engine/engine.js'
import { resolveTransaction } from '../games/arkhamhorror/src/engine/resolution.js'

function answerAll(state) {
  for (let i = 0; state.pendingChoice && i < 200; i++) {
    const c = state.pendingChoice
    const id = ['done', 'skip', 'self'].find(id => c.options.some(o => o.id === id)) ?? c.options[0]?.id
    applyMove(state, decisionSeat(state), { action: 'choose', choiceId: c.id, optionId: id })
  }
}
const codes = ['01001', '01002', '01003']
const players = codes.map((_, seat) => ({ seat, role: 'ai', name: 'P' + seat }))
const state = createGameState({
  campaignId: 'thePathToCarcosa', playerInvestigator: '01001', seed: 'doom-clear-check',
  seatInvestigators: codes,
}, players)
answerAll(state)
state.campaign.records.vipsInterviewed = ['03079']
resolveTransaction(state, 0, { action: 'setup' }, (draft, seat, move, events) => startScenario(draft, 2, events), { initial: true })
answerAll(state)
console.log('scenario', state.scenario?.id, 'agenda', state.agendas[state.agendaIndex]?.nameZh || state.agendas[state.agendaIndex]?.name,
  'threshold', state.agendas[state.agendaIndex]?.doomThreshold, 'doom', state.doom)

// 复刻第 3 回合神话阶段的开局：密谋上 1 点毁灭 + 异教徒敌人身上 5 点毁灭（线索翻面/神秘咏唱累积）。
state.doom = 1
const cultist = {
  id: 'cultist-check', code: '03144', originalCode: '03144', name: '卡尔克萨探求者',
  location: state.investigators[0].location, traits: ['Humanoid', 'Cultist'], fight: 2, evade: 2, health: 3,
  damageTaken: 0, damage: 1, horror: 1, engagedSeat: null, exhausted: false, doom: 5, clues: 0,
}
state.enemies.push(cultist)
const loc = state.locations.find(l => l.id === state.investigators[0].location)
if (loc) loc.doom = 1
const { agendaDoom, totalDoom } = await import('../games/arkhamhorror/src/engine/rules-state.js')
console.log('before advance: agendaDoom(total in play)=', agendaDoom(state), 'agenda-instance doom=', state.agendas[state.agendaIndex].doom || 0)

// 走一次神话阶段的推进判定：下一回合开始（endTurn → enemy/upkeep/mythos）。
applyMove(state, decisionSeat(state), { action: 'endTurn' })
answerAll(state)
const agenda = state.agendas[state.agendaIndex]
console.log('after mythos: agendaIndex', state.agendaIndex, 'current', agenda?.nameZh || agenda?.name, 'threshold', agenda?.doomThreshold)
console.log('after advance: state.doom=', state.doom, 'cultist.doom=', state.enemies.find(e => e.code === '03144')?.doom ?? '(left play)',
  'loc.doom=', state.locations.find(l => l.id === loc?.id)?.doom ?? '-', 'agendaDoom(total)=', agendaDoom(state), 'totalDoom=', totalDoom(state))
const log = (state.log || []).filter(t => /毁灭|密谋/.test(String(t)))
console.log('--- last doom log ---')
for (const line of log.slice(-8)) console.log(String(line).replace(/\n/g, ' | ').slice(0, 160))
