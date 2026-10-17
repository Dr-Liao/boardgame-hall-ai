// Per-session, per-channel read cursors. Only newly received messages can toast.
export const chatChannel = (event, seat = 0) => event.to == null ? 'table' : String(event.participants ? event.participants.find(p => p !== seat) : event.to)
export function createChatNotifications({ load = () => null, save = () => {}, now = () => Date.now() } = {}) {
  const sessions = new Map()
  let activeId
  const messages = session => (session.events || []).filter(e => e.type === 'chat' && Number.isSafeInteger(e.seq))
  return {
    sync(session, { open = false, channel = 'table', visible = true } = {}) {
      const events = messages(session), id = session.sessionId, time = now(), mySeat = session.mySeat ?? 0
      let record = sessions.get(id)
      if (activeId !== id) {
        for (const value of sessions.values()) value.toasts = []
        activeId = id
      }
      if (!record) {
        let read
        try { read = load(id) } catch {}
        const valid = read && typeof read === 'object' && !Array.isArray(read)
        record = { read: valid ? { ...read } : {}, seen: new Set(events.map(e => e.seq)), toasts: [] }
        if (!valid) for (const event of events) record.read[chatChannel(event, mySeat)] = event.seq
        sessions.set(id, record)
      } else {
        for (const event of events) {
          if (record.seen.has(event.seq)) continue
          record.seen.add(event.seq)
          const current = visible && open && chatChannel(event, mySeat) === channel
          if (event.seat !== mySeat && !current && visible && Number.isFinite(event.ts) && time - event.ts <= 15000 && event.ts <= time + 30000) {
            record.toasts.push({ event, expires: time + 7000 })
          }
        }
      }
      if (open && visible) {
        for (const event of events.filter(e => chatChannel(e, mySeat) === channel)) record.read[channel] = Math.max(record.read[channel] ?? -1, event.seq)
      }
      record.toasts = record.toasts.filter(t => t.expires > time && t.event.seq > (record.read[chatChannel(t.event, mySeat)] ?? -1)).slice(-3)
      const unread = {}
      for (const event of events) if (event.seat !== mySeat && event.seq > (record.read[chatChannel(event, mySeat)] ?? -1)) {
        const key = chatChannel(event, mySeat); unread[key] = (unread[key] || 0) + 1
      }
      const serialized = JSON.stringify(record.read)
      if (record.saved !== serialized) { try { save(id, record.read); record.saved = serialized } catch {} }
      return { unread, total: Object.values(unread).reduce((a,b) => a+b,0), toasts: record.toasts }
    },
    dismiss(id, seq) { const record = sessions.get(id); if (record) record.toasts = record.toasts.filter(t => t.event.seq !== seq) },
  }
}
