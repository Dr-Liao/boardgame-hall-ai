import { fixture, move, settle, enemy, asset } from '../games/arkhamhorror/tests/core-fixture.mjs'
const s = fixture()
const threshold = s.agendas[0].doomThreshold
console.log('threshold', threshold, 'agenda', s.agendas[0].originalCode || s.agendas[0].code, 'status', s.status)
const ghoul = enemy(s, { code: 'acolyte', engagedSeat: null, doom: threshold - 1 })
const relic = asset(s, '01063', { doom: 1 })
s.locations[0].doom = 1
s.agendas[0].doom = 1
s.doom = 1
console.log('before endTurn: agendaDoom?', 'enemy', ghoul.doom, 'loc', s.locations[0].doom, 'agendaInst', s.agendas[0].doom, 's.doom', s.doom)
move(s, { action: 'endTurn' }); settle(s)
console.log('after: agendaIndex', s.agendaIndex, 's.doom', s.doom, 'enemy.doom', ghoul.doom, 'asset.doom', relic.doom, 'loc.doom', s.locations[0]?.doom, 'agendaInst.doom', s.agendas[0].doom)
console.log(s.log.filter(l => /毁灭|密谋/.test(String(l))).slice(-12).join('\n'))
