// The local hall remains authoritative. Browsers only carry its commands and
// seat-specific snapshots over a WebRTC data channel when ICE finds a route.
const STUN = 'stun:stun.cloudflare.com:3478'
const PART_SIZE = 12000
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

export function createP2P({ request, onChange = () => {} }) {
  let current = null, roomKey = '', lastSignal = 0, signalChain = Promise.resolve(), unavailable = false, nextAttemptAt = 0, failures = 0
  const peers = new Map()
  const pending = new Map()
  const own = () => current?.room?.members?.find(member => member.id === current.memberId)
  const host = () => current?.room?.members?.find(member => member.host)
  const active = peer => peer?.channel?.readyState === 'open' && peer.pc.connectionState === 'connected'
  const direct = () => !own()?.host && !!peers.get(host()?.id)?.ready && active(peers.get(host()?.id))

  function rejectPending(peer, error) {
    for (const [id, item] of pending) if (item.peer === peer) {
      clearTimeout(item.timer); pending.delete(id); item.reject(error)
    }
  }
  function closePeer(peer) {
    if (!peer || peers.get(peer.id) !== peer) return
    peers.delete(peer.id)
    clearTimeout(peer.timer)
    peer.stream?.abort()
    peer.channel?.close()
    peer.pc.close()
    rejectPending(peer, Object.assign(new Error('直连已断开'), { transport: true }))
    onChange()
    if (current?.connected && !own()?.host && host()?.id === peer.id) {
      nextAttemptAt = Date.now() + Math.min(60000, 5000 * 2 ** Math.min(failures++, 4))
      retry()
    }
  }
  function reset() {
    for (const peer of [...peers.values()]) closePeer(peer)
    peers.clear()
    unavailable = false
    nextAttemptAt = 0
    failures = 0
  }
  function retry() {
    if (!current?.connected || own()?.host || unavailable || !host()?.online) return
    setTimeout(() => {
      if (current?.connected && !own()?.host && !peers.has(host()?.id) && !unavailable && Date.now() >= nextAttemptAt) offer().catch(() => {})
    }, Math.max(0, nextAttemptAt - Date.now()))
  }
  async function signal(target, data) {
    try { await request('POST', '/online/signal', { target, data }) }
    catch (error) {
      // An older relay has no signaling route. Keep the existing relay path.
      if (/未知消息类型|未知联机操作|直连协商内容无效/.test(error.message)) unavailable = true
      throw error
    }
  }
  function makePeer(id, initiator, negotiationId = crypto.randomUUID()) {
    const previous = peers.get(id)
    if (previous) closePeer(previous)
    const pc = new RTCPeerConnection({ iceServers: [{ urls: STUN }] })
    const peer = { id, negotiationId, pc, channel: null, ready: false, timer: null, stream: null, parts: new Map(), outbox: Promise.resolve(), inbound: Promise.resolve(), candidates: [], initialSignalSent: false, outboundCandidates: [] }
    peers.set(id, peer)
    peer.timer = setTimeout(() => closePeer(peer), 18000)
    pc.onicecandidate = event => {
      if (event.candidate && peers.get(id) === peer) {
        const data = { type: 'candidate', negotiationId, candidate: event.candidate.toJSON() }
        if (!peer.initialSignalSent) peer.outboundCandidates.push(data)
        else signal(id, data).catch(() => closePeer(peer))
      }
    }
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') onChange()
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) closePeer(peer)
    }
    pc.ondatachannel = event => bindChannel(peer, event.channel)
    if (initiator) bindChannel(peer, pc.createDataChannel('boardgame', { ordered: true }))
    return peer
  }
  async function offer() {
    if (!current?.connected || own()?.host || !host()?.online || peers.has(host().id) || unavailable) return
    const peer = makePeer(host().id, true)
    try {
      await peer.pc.setLocalDescription(await peer.pc.createOffer())
      await signal(peer.id, { type: 'offer', negotiationId: peer.negotiationId, description: peer.pc.localDescription.toJSON() })
      peer.initialSignalSent = true
      for (const candidate of peer.outboundCandidates.splice(0)) await signal(peer.id, candidate)
    } catch { closePeer(peer) }
  }
  async function handleSignal(message) {
    if (!current?.room || !current.connected) return
    const member = current.room.members.find(item => item.id === message.from)
    if (!member || member.host === own()?.host) return
    const data = message.data
    if (data?.type === 'offer' && own()?.host) {
      if (typeof data.description?.sdp !== 'string' || typeof data.negotiationId !== 'string' || data.negotiationId.length > 100) return
      const peer = makePeer(member.id, false, data.negotiationId)
      try {
        await peer.pc.setRemoteDescription(data.description)
        await peer.pc.setLocalDescription(await peer.pc.createAnswer())
        await signal(peer.id, { type: 'answer', negotiationId: peer.negotiationId, description: peer.pc.localDescription.toJSON() })
        peer.initialSignalSent = true
        for (const candidate of peer.outboundCandidates.splice(0)) await signal(peer.id, candidate)
        await flushCandidates(peer)
      } catch { closePeer(peer) }
    } else {
      const peer = peers.get(member.id)
      if (!peer || data?.negotiationId !== peer.negotiationId) return
      try {
        if (data?.type === 'answer' && !own()?.host && typeof data.description?.sdp === 'string') {
          await peer.pc.setRemoteDescription(data.description)
          await flushCandidates(peer)
        } else if (data?.type === 'candidate' && data.candidate?.candidate) {
          if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(data.candidate)
          else peer.candidates.push(data.candidate)
        }
      } catch { closePeer(peer) }
    }
  }
  async function flushCandidates(peer) {
    for (const candidate of peer.candidates.splice(0)) await peer.pc.addIceCandidate(candidate)
  }
  function bindChannel(peer, channel) {
    peer.channel = channel
    channel.bufferedAmountLowThreshold = 65536
    channel.onopen = () => {
      clearTimeout(peer.timer)
      failures = 0
      onChange()
      if (own()?.host) streamSnapshots(peer)
    }
    channel.onclose = () => closePeer(peer)
    channel.onerror = () => closePeer(peer)
    channel.onmessage = event => receivePart(peer, event.data)
  }
  async function write(peer, value) {
    const channel = peer.channel
    const serialized = JSON.stringify(value), id = crypto.randomUUID(), total = Math.ceil(serialized.length / PART_SIZE)
    if (total > 1024) throw new Error('直连消息过大')
    for (let part = 0; part < total; part++) {
      while (channel.bufferedAmount > 262144) {
        if (channel.readyState !== 'open') throw Object.assign(new Error('直连已断开'), { transport: true })
        await sleep(10)
      }
      if (channel.readyState !== 'open') throw Object.assign(new Error('直连已断开'), { transport: true })
      channel.send(JSON.stringify({ id, part, total, data: serialized.slice(part * PART_SIZE, (part + 1) * PART_SIZE) }))
    }
  }
  function send(peer, value) {
    const task = peer.outbox.then(() => write(peer, value))
    peer.outbox = task.catch(() => closePeer(peer))
    return task
  }
  function receivePart(peer, raw) {
    let part
    try { part = JSON.parse(raw) } catch { closePeer(peer); return }
    if (!part || typeof part.id !== 'string' || !Number.isInteger(part.part) || !Number.isInteger(part.total)
        || part.total < 1 || part.total > 1024 || part.part < 0 || part.part >= part.total || typeof part.data !== 'string') { closePeer(peer); return }
    let record = peer.parts.get(part.id)
    if (!record) {
      if (peer.parts.size > 4 || part.part !== 0) { closePeer(peer); return }
      record = { pieces: [], total: part.total, length: 0 }; peer.parts.set(part.id, record)
    }
    if (part.part !== record.pieces.length || part.total !== record.total || (record.length += part.data.length) > 12 * 1024 * 1024) { closePeer(peer); return }
    record.pieces.push(part.data)
    if (record.pieces.length !== record.total) return
    peer.parts.delete(part.id)
    try {
      const packet = JSON.parse(record.pieces.join(''))
      peer.inbound = peer.inbound.then(() => receive(peer, packet)).catch(() => closePeer(peer))
    } catch { closePeer(peer) }
  }
  async function receive(peer, packet) {
    if (peers.get(peer.id) !== peer || !packet || typeof packet !== 'object') return
    if (own()?.host && packet.type === 'command') {
      try {
        const data = await request('POST', '/online/direct-command', { memberId: peer.id, action: packet.action, body: packet.body })
        await send(peer, { type: 'result', id: packet.id, ok: true, data })
      } catch (error) { await send(peer, { type: 'result', id: packet.id, ok: false, error: error.message }) }
    } else if (!own()?.host && packet.type === 'snapshot') {
      await request('POST', '/online/direct-snapshot', { data: packet.data })
    } else if (!own()?.host && packet.type === 'ready') {
      peer.ready = true
      onChange()
    } else if (!own()?.host && packet.type === 'result') {
      const item = pending.get(packet.id)
      if (!item || item.peer !== peer) return
      pending.delete(packet.id); clearTimeout(item.timer)
      if (packet.ok) item.resolve(packet.data)
      else item.reject(new Error(packet.error || '操作失败'))
    }
  }
  async function streamSnapshots(peer) {
    const abort = new AbortController()
    peer.stream = abort
    try {
      const response = await fetch('/api/online/direct-stream?memberId=' + encodeURIComponent(peer.id),
        { headers: { 'x-boardgame-online': '1' }, signal: abort.signal })
      if (!response.ok || !response.body) throw new Error('无法读取房主直连状态')
      await send(peer, { type: 'ready' })
      const reader = response.body.getReader(), decoder = new TextDecoder()
      let buffer = ''
      while (peers.get(peer.id) === peer) {
        const { done, value } = await reader.read()
        if (done) throw new Error('房主直连状态已断开')
        buffer += decoder.decode(value, { stream: true })
        let end
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
          if (line) await send(peer, { type: 'snapshot', data: JSON.parse(line) })
        }
      }
    } catch { if (!abort.signal.aborted) closePeer(peer) }
  }
  function update(status) {
    current = status
    const key = status?.room ? `${status.instanceId}:${status.room.code}:${status.memberId}` : ''
    if (key !== roomKey || !status?.connected) {
      reset(); roomKey = key; lastSignal = 0
    }
    if (!key || !status.connected || typeof RTCPeerConnection !== 'function') return
    for (const message of status.signals || []) if (message.seq > lastSignal) {
      lastSignal = message.seq
      signalChain = signalChain.then(() => handleSignal(message)).catch(() => {})
    }
    if (!own()?.host && host()?.online && !peers.has(host().id) && !unavailable && Date.now() >= nextAttemptAt) offer().catch(() => {})
    if (own()?.host) for (const peer of [...peers.values()]) {
      if (!status.room.members.some(member => member.id === peer.id && member.online)) closePeer(peer)
    }
  }
  function command(action, body) {
    const peer = peers.get(host()?.id)
    if (!active(peer) || !peer.ready) return Promise.reject(Object.assign(new Error('直连不可用'), { transport: true }))
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID()
      const timer = setTimeout(() => { pending.delete(id); closePeer(peer); reject(Object.assign(new Error('直连操作超时'), { transport: true })) }, 180000)
      pending.set(id, { peer, resolve, reject, timer })
      send(peer, { type: 'command', id, action, body }).catch(error => {
        if (pending.delete(id)) { clearTimeout(timer); reject(Object.assign(error, { transport: true })) }
      })
    }).then(async result => {
      const deadline = Date.now() + 15000
      while (Date.now() < deadline && active(peer)) {
        let local
        try { local = await request('GET', '/online/status') }
        catch (error) {
          closePeer(peer)
          throw Object.assign(error, { transport: true })
        }
        if (local.session?.sessionId === result.sessionId && local.session.state.revision >= result.revision
            && local.session.events.length >= result.eventCount) return { ...result, session: local.session }
        await sleep(100)
      }
      closePeer(peer)
      throw Object.assign(new Error('直连状态未及时同步'), { transport: true })
    })
  }
  return { update, direct, command, status: () => own()?.host ? [...peers.values()].filter(active).length ? `直连 ${[...peers.values()].filter(active).length} 人` : '中转' : direct() ? '直连' : '中转' }
}
