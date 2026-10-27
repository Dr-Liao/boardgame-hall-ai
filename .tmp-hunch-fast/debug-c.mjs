import { fixture, move, answer, settle } from '../games/arkhamhorror/tests/core-fixture.mjs'
const me = state => state.investigators[0]
const state = fixture('05002')
const inv = me(state)
inv.hunchDeck = []
inv.hunchRevealed = '01037'
inv.hand = []
inv.resources = 0
inv.discard = []
const loc = state.locations.find(l => l.id === inv.location)
loc.clues = Math.max(1, loc.clues || 0)
inv.actionsLeft = 1
console.log('before draw resources', me(state).resources, 'hand', JSON.stringify(me(state).hand))
move(state, { action: 'draw' })
console.log('after draw resources', me(state).resources, 'hand', JSON.stringify(me(state).hand))
console.log('choice', JSON.stringify(state.pendingChoice?.options?.map(o => ({ id: o.id, label: o.label }))))
const option = state.pendingChoice.options.find(o => o.id === 'fast-card:hunch:01037')
const before = me(state).resources
answer(state, option.id)
console.log('after play resources', me(state).resources, '(before', before + ')')
console.log('log', JSON.stringify((state.log || []).slice(-6).map(e => e && (e.text || e)), null, 1))
