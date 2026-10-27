import { fixture, enemy, asset } from '../games/arkhamhorror/tests/core-fixture.mjs'
import { advanceAgenda } from '../games/arkhamhorror/src/engine/engine.js'
const s = fixture()
const e = enemy(s, { code: 'acolyte', engagedSeat: null, doom: 2 })
const a = asset(s, '01063', { doom: 1 })
s.locations[0].doom = 1
s.agendas[0].doom = 1
s.doom = 1
console.log('enemies len', s.enemies.length, 'doom before', e.doom, a.doom, s.locations[0].doom, s.agendas[0].doom, s.doom)
try { advanceAgenda(s, []) } catch (err) { console.log('THREW', err.message) }
console.log('after: agendaIndex', s.agendaIndex, 'enemy.doom', s.enemies[0]?.doom, 'asset.doom', s.investigators[0].assets[0]?.doom, 'loc.doom', s.locations[0]?.doom, 'agendaInst.doom', s.agendas[0].doom, 's.doom', s.doom)
console.log('enemy in state?', s.enemies.includes(e), 'asset in inv?', s.investigators[0].assets.includes(a))
