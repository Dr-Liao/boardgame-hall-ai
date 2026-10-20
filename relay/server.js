import http from 'node:http'
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { WebSocketServer, WebSocket } from 'ws'

const id = () => randomBytes(18).toString('base64url')
const fail = message => { throw new Error(message) }
const name = value => String(value || '玩家').trim().slice(0, 32) || '玩家'
// 大厅版本号：旧版大厅不发送，按“不校验”处理，以兼容已部署的旧客户端。
const readHallVersion = value => (typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value) ? value : null)
const MAX_BYTES = 8 * 1024 * 1024
function reservedSeats(value, capacity) {
  if (value == null) return []
  if (!Array.isArray(value) || value.length >= capacity) fail('AI 席位设置无效')
  const seats = new Set()
  return value.map(item => {
    if (!item || !Number.isInteger(item.seat) || item.seat <= 0 || item.seat >= capacity || seats.has(item.seat)) fail('AI 席位设置无效')
    seats.add(item.seat)
    return { seat: item.seat, name: name(item.name || 'AI') }
  })
}

// The relay never runs game rules or receives model credentials. Only the host
// may send game state, and each snapshot has exactly one recipient.
export function createRelay({ secret = process.env.RELAY_SECRET || id(), maxRooms = 500, idleMs = 6 * 3600000 } = {}) {
  const rooms = new Map(), pending = new Map()
  const server = http.createServer((req, res) => {
    res.writeHead(req.url === '/health' || req.url === '/' ? 200 : 404, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(req.url === '/health' || req.url === '/' ? { ok: true, service: 'boardgame-relay', protocol: 1, features: ['reserved-ai-seats', 'select-seat', 'webrtc-signaling'] } : { ok: false }))
  })
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_BYTES, perMessageDeflate: false })
  const sign = payload => {
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
    return encoded + '.' + createHmac('sha256', secret).update(encoded).digest('base64url')
  }
  const verify = token => {
    if (typeof token !== 'string' || token.length > 4096) fail('重连凭证无效')
    const [data, signature] = token.split('.')
    const expected = createHmac('sha256', secret).update(data || '').digest()
    const actual = Buffer.from(signature || '', 'base64url')
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) fail('重连凭证无效')
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString())
    if (payload.expires < Date.now()) fail('重连凭证已过期，请重新创建或加入房间')
    return payload
  }
  const send = (socket, value) => {
    if (socket?.readyState !== WebSocket.OPEN) return
    if (socket.bufferedAmount > MAX_BYTES * 2) { socket.close(1013, '连接过慢'); return }
    socket.send(JSON.stringify(value))
  }
  const view = room => ({ code: room.code, game: room.game, hallVersion: room.hallVersion, capacity: room.capacity, aiSeats: room.aiSeats, phase: room.phase,
    members: [...room.members.values()].map(({ socket, ...member }) => ({ ...member, online: socket?.readyState === WebSocket.OPEN })) })
  const announce = room => {
    room.touched = Date.now()
    for (const member of room.members.values()) send(member.socket, { type: 'room', room: view(room) })
  }
  const attach = (socket, room, member) => {
    const previous = member.socket
    member.socket = socket
    socket.room = room; socket.member = member
    if (previous && previous !== socket) previous.close(4001, '此席位已重新连接')
    const token = sign({ code: room.code, nonce: room.nonce, member: { id: member.id, seat: member.seat, name: member.name, host: member.host }, expires: Date.now() + 7 * 86400000 })
    return { room: view(room), memberId: member.id, token }
  }
  const removeRoom = (room, reason) => {
    rooms.delete(room.code)
    for (const member of room.members.values()) {
      send(member.socket, { type: 'closed', reason })
      if (member.socket) { member.socket.room = null; member.socket.member = null }
    }
    for (const [key, item] of pending) if (item.room === room) {
      clearTimeout(item.timer); pending.delete(key)
      send(item.socket, { type: 'result', id: item.id, ok: false, error: reason })
    }
  }
  wss.on('connection', socket => {
    if (wss.clients.size > 2000) { socket.close(1013, '中转连接已满'); return }
    const joinTimer = setTimeout(() => { if (!socket.room) socket.close(1008, '请先加入房间') }, 20000)
    joinTimer.unref()
    socket.alive = true; socket.windowStart = Date.now(); socket.count = 0
    socket.on('pong', () => { socket.alive = true })
    socket.on('error', () => {})
    socket.on('message', raw => {
      let message
      try {
        if (Date.now() - socket.windowStart > 10000) { socket.windowStart = Date.now(); socket.count = 0 }
        if (++socket.count > 600) fail('请求过于频繁')
        message = JSON.parse(raw.toString())
        if (!message || typeof message !== 'object' || typeof message.id !== 'string' || message.id.length > 100) fail('无效消息')
        let data = {}
        if (message.type === 'create') {
          if (socket.room) fail('请先退出当前房间')
          if (rooms.size >= maxRooms) fail('中转服务房间已满')
          if (!message.game || typeof message.game.id !== 'string' || !/^[a-z0-9_-]{1,64}$/i.test(message.game.id) || typeof message.game.version !== 'string' || message.game.version.length > 128) fail('游戏信息无效')
          const capacity = message.capacity
          if (!Number.isInteger(capacity) || capacity < 2 || capacity > 8) fail('房间人数需为 2–8 人')
          const aiSeats = reservedSeats(message.aiSeats, capacity)
          let code
          do { code = randomBytes(5).toString('hex').toUpperCase() } while (rooms.has(code))
          const room = { code, nonce: id(), game: { id: message.game.id, name: name(message.game.name), version: message.game.version }, hallVersion: readHallVersion(message.hallVersion), capacity, aiSeats, phase: 'waiting', members: new Map(), touched: Date.now() }
          const member = { id: id(), seat: 0, name: name(message.name), host: true, ready: true }
          room.members.set(member.id, member); rooms.set(code, room)
          data = attach(socket, room, member)
        } else if (message.type === 'join') {
          if (socket.room) fail('请先退出当前房间')
          const room = rooms.get(String(message.code).toUpperCase())
          if (!room) fail('房间不存在，请检查中转地址和房间码')
          // 兼容性只看两个版本号：大厅版本号（未上报的旧大厅跳过）与游戏版本号。
          if (room.hallVersion && readHallVersion(message.hallVersion) !== room.hallVersion) fail('大厅版本不一致，请双方更新到同一版本')
          if (message.versions?.[room.game.id] !== room.game.version) fail('游戏版本不一致，请双方更新到同一版本')
          if (room.phase !== 'waiting') fail('游戏已经开始，暂不接受新玩家')
          if (![...room.members.values()].find(member => member.host)?.socket) fail('房主已离线，请稍后重试')
          const available = i => !room.aiSeats.some(m => m.seat === i) && ![...room.members.values()].some(m => m.seat === i)
          if (message.seat != null && (!Number.isInteger(message.seat) || message.seat <= 0 || message.seat >= room.capacity || !available(message.seat))) fail('该席位不可加入：可能已有人、已预留 AI，或不在房间范围内')
          const seat = message.seat ?? Array.from({ length: room.capacity }, (_, i) => i).find(available)
          if (seat === undefined) fail('玩家席位已满，AI 席位不可加入')
          const member = { id: id(), seat, name: name(message.name), host: false, ready: false }
          room.members.set(member.id, member)
          data = attach(socket, room, member)
        } else if (message.type === 'resume') {
          if (socket.room) fail('连接已经在房间中')
          const ticket = verify(message.token)
          let room = rooms.get(ticket.code)
          if (!room && ticket.member.host) {
            if (rooms.size >= maxRooms) fail('中转服务房间已满')
            const saved = message.recovery
            if (!saved || !Number.isInteger(saved.capacity) || saved.capacity < 2 || saved.capacity > 8 || !Array.isArray(saved.members) || saved.members.length > saved.capacity) fail('房间恢复信息无效')
            const aiSeats = reservedSeats(saved.aiSeats, saved.capacity)
            if (saved.members.some(member => aiSeats.some(ai => ai.seat === member.seat))) fail('房间席位恢复信息冲突')
            room = { code: ticket.code, nonce: ticket.nonce, game: saved.game, hallVersion: readHallVersion(saved.hallVersion), capacity: saved.capacity, aiSeats, phase: saved.phase, members: new Map(), touched: Date.now() }
            for (const m of saved.members) room.members.set(m.id, { id: m.id, seat: m.seat, name: name(m.name), host: m.id === ticket.member.id, ready: !!m.ready, socket: null })
            rooms.set(room.code, room)
          }
          if (!room) fail('等待房主重新连接')
          if (room.nonce !== ticket.nonce) fail('房间已失效')
          const member = room.members.get(ticket.member.id)
          if (!member) fail('席位已释放，请重新加入')
          data = attach(socket, room, member)
        } else {
          const room = socket.room, member = socket.member
          if (!room || !member || member.socket !== socket) fail('请先加入房间')
          room.touched = Date.now()
          if (message.type === 'ready') {
            if (room.phase !== 'waiting') fail('游戏已开始')
            member.ready = member.host || message.ready === true
          } else if (message.type === 'phase') {
            if (!member.host) fail('只有房主可以开始游戏')
            if (!['waiting', 'starting', 'playing'].includes(message.phase)) fail('房间状态无效')
            if (message.phase === 'starting' && [...room.members.values()].some(m => !m.socket || (room.phase === 'waiting' && !m.ready))) fail('请等待所有玩家上线并准备')
            room.phase = message.phase
          } else if (message.type === 'request') {
            if (!['start', 'move', 'reset', 'chat', 'sync', 'aiRetry', 'save'].includes(message.action)) fail('不支持的房间操作')
            const host = [...room.members.values()].find(m => m.host)
            if (!host?.socket) fail('房主已离线，正在等待重连')
            if ([...pending.values()].filter(p => p.socket === socket).length >= 8) fail('请等待上一操作完成')
            const requestId = id()
            const item = { room, socket, id: message.id, memberId: member.id }
            item.timer = setTimeout(() => { pending.delete(requestId); send(socket, { type: 'result', id: message.id, ok: false, error: '房主响应超时，请刷新对局状态' }) }, 180000)
            item.timer.unref(); pending.set(requestId, item)
            send(host.socket, { type: 'command', requestId, memberId: member.id, seat: member.seat, action: message.action, body: message.body })
            return
          } else if (message.type === 'reply') {
            if (!member.host) fail('只有房主可以确认操作')
            const item = pending.get(message.requestId)
            if (item?.room === room) {
              pending.delete(message.requestId); clearTimeout(item.timer)
              send(item.socket, { type: 'result', id: item.id, ok: message.ok === true, data: message.data, error: message.error })
            }
            return
          } else if (message.type === 'snapshot') {
            if (!member.host) fail('只有房主可以同步对局')
            send(room.members.get(message.target)?.socket, { type: 'snapshot', ...message.data })
            return
          } else if (message.type === 'signal') {
            const target = room.members.get(message.target)
            if (!target?.socket || (member.host === target.host)) fail('直连目标不可用')
            if (!message.data || typeof message.data !== 'object' || Array.isArray(message.data)
                || JSON.stringify(message.data).length > 16384
                || !['offer', 'answer', 'candidate'].includes(message.data.type)) fail('直连协商内容无效')
            send(target.socket, { type: 'signal', from: member.id, data: message.data })
            send(socket, { type: 'result', id: message.id, ok: true, data: {} })
            return
          } else if (message.type === 'leave') {
            if (member.host) removeRoom(room, '房主已解散房间')
            else if (room.phase === 'waiting') room.members.delete(member.id)
            else { member.socket = null; member.ready = false }
            socket.room = null; socket.member = null
          } else if (message.type !== 'ping') fail('未知消息类型')
        }
        send(socket, { type: 'result', id: message.id, ok: true, data })
        if (socket.room && message.type !== 'ping') announce(socket.room)
      } catch (error) {
        send(socket, { type: 'result', id: typeof message?.id === 'string' ? message.id : '', ok: false, error: error.message })
      }
    })
    socket.on('close', () => {
      clearTimeout(joinTimer)
      if (socket.member?.socket === socket) { socket.member.socket = null; announce(socket.room) }
    })
  })
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (!socket.alive) { socket.terminate(); continue }
      socket.alive = false; socket.ping()
    }
    for (const room of rooms.values()) if (![...room.members.values()].some(m => m.socket) && Date.now() - room.touched > idleMs) removeRoom(room, '房间已过期')
  }, 30000)
  heartbeat.unref()
  server.stopRelay = () => {
    clearInterval(heartbeat)
    for (const item of pending.values()) clearTimeout(item.timer)
    pending.clear()
    for (const socket of wss.clients) socket.terminate()
    wss.close()
  }
  server.on('close', server.stopRelay)
  return server
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.env.RENDER && !process.env.RELAY_SECRET) throw new Error('请配置 RELAY_SECRET，以便部署后验证重连凭证')
  const server = createRelay()
  server.listen(Number(process.env.PORT) || 10000, '0.0.0.0', () => console.log('Boardgame relay listening on', server.address().port))
  process.on('SIGTERM', () => { server.stopRelay(); server.close(() => process.exit(0)) })
}
