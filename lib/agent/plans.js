// The hall only sanitizes the shared plan envelope. Games own plan semantics,
// persistence and observer visibility via mod.agentPlanning.
export function normalizePlan(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const plan = {}
  for (const key of ['role', 'objective', 'intent', 'upgrade', 'reason']) {
    if (typeof raw[key] === 'string') plan[key] = raw[key].replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 160)
  }
  return Object.keys(plan).length ? plan : null
}
