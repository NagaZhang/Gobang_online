'use strict';

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');
const game = require('./src/game');

const PORT = process.env.PORT || 3000;
const TURN_SECONDS = Number(process.env.TURN_SECONDS) || 30; // 每回合思考时间（秒），可用环境变量调整，超时判负
const DROP_GRACE_MS = 10 * 60 * 1000; // 掉线保留对局 10 分钟
const ROOM_TTL_MS = 10 * 60 * 1000; // 对局结束后房间保留 10 分钟
const NAME_MAX = 12;
const CHAT_MAX = 200;
const CHAT_KEEP = 100;
const CHAT_LIMIT = 5; // 5 秒内最多 5 条
const CHAT_WINDOW = 5000;
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 去掉易混淆字符

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

/** @type {Map<string, any>} code -> room */
const rooms = new Map();

// ---------- 工具函数 ----------

function randomCode() {
  let code;
  do {
    code = Array.from({ length: 6 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join('');
  } while (rooms.has(code));
  return code;
}

const randomId = () => crypto.randomBytes(12).toString('hex');

// 允许客户端预生成合法 ID（开局消息丢失时可凭此 ID 重连恢复），非法或冲突时回退为服务端生成
function resolveId(raw, existing) {
  const id = String(raw || '');
  if (/^[a-f0-9]{16,40}$/.test(id) && !(existing || []).some((p) => p && p.id === id)) return id;
  return randomId();
}

function send(ws, obj) {
  if (!ws || ws.readyState !== ws.OPEN) return;
  try {
    ws.send(JSON.stringify(obj));
  } catch (_) {
    /* 忽略发送失败 */
  }
}

function broadcast(room, obj) {
  for (const p of room.players) send(p.ws, obj);
}

function cleanName(raw) {
  return String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
}

function colorName(color) {
  return color === game.BLACK ? '黑方' : '白方';
}

function makePlayer(color, name, tabId, id) {
  return {
    id: id || randomId(),
    name,
    color,
    tabId: tabId || null,
    ws: null,
    online: false,
    chatTimes: [],
    dropTimer: null,
  };
}

function makeRoom(code) {
  return {
    code,
    players: [],
    board: game.createBoard(),
    turn: game.BLACK,
    status: 'waiting', // waiting | playing | over
    winner: null,
    reason: null,
    winLine: null,
    moves: [],
    chat: [],
    pending: null, // { kind: 'draw' | 'undo', from: color }
    timer: null, // { color, deadline, timeout }
    frozenRemaining: null, // 掉线暂停时剩余毫秒
    closeTimer: null,
  };
}

function addChat(room, entry) {
  room.chat.push(entry);
  if (room.chat.length > CHAT_KEEP) room.chat.splice(0, room.chat.length - CHAT_KEEP);
  broadcast(room, entry);
}

function systemChat(room, text) {
  addChat(room, { type: 'chat', system: true, text, t: Date.now() });
}

// ---------- 快照与计时 ----------

function snapshot(room) {
  let timer = null;
  if (room.status === 'playing') {
    if (room.timer) timer = Math.max(0, room.timer.deadline - Date.now());
    else if (room.frozenRemaining != null) timer = room.frozenRemaining;
  }
  return {
    code: room.code,
    status: room.status,
    board: room.board,
    moves: room.moves,
    turn: room.turn,
    winner: room.winner,
    reason: room.reason,
    winLine: room.winLine,
    pending: room.pending ? { kind: room.pending.kind, from: room.pending.from } : null,
    timer,
    players: room.players.map((p) => ({ name: p.name, color: p.color, online: p.online })),
    chat: room.chat,
  };
}

function stopTurnTimer(room) {
  if (room.timer) {
    clearTimeout(room.timer.timeout);
    room.timer = null;
  }
}

function launchTimer(room, ms) {
  stopTurnTimer(room);
  room.frozenRemaining = null;
  const color = room.turn;
  const deadline = Date.now() + ms;
  room.timer = {
    color,
    deadline,
    timeout: setTimeout(() => {
      // 到点二次校验，避免暂停/换回合后误判
      if (room.status === 'playing' && room.timer && room.timer.color === color) {
        const loser = room.players.find((p) => p.color === color);
        const winner = room.players.find((p) => p.color !== color);
        systemChat(room, `${loser ? loser.name : colorName(color)} 思考超时，判负`);
        finishGame(room, winner ? winner.color : null, 'timeout');
      }
    }, ms + 100),
  };
}

function pauseTimer(room) {
  if (!room.timer) return;
  room.frozenRemaining = Math.max(0, room.timer.deadline - Date.now());
  stopTurnTimer(room);
  broadcast(room, { type: 'tick', turn: room.turn, remaining: Math.ceil(room.frozenRemaining / 1000), paused: true });
}

function resumeTimerIfNeeded(room) {
  if (room.status === 'playing' && !room.timer && room.players.every((p) => p.online)) {
    launchTimer(room, room.frozenRemaining != null ? room.frozenRemaining : TURN_SECONDS * 1000);
  }
}

// 每秒广播一次剩余时间
setInterval(() => {
  for (const room of rooms.values()) {
    if (room.status === 'playing' && room.timer) {
      broadcast(room, {
        type: 'tick',
        turn: room.turn,
        remaining: Math.max(0, Math.ceil((room.timer.deadline - Date.now()) / 1000)),
      });
    }
  }
}, 1000).unref();

function finishGame(room, winner, reason, extra = {}) {
  if (room.status === 'over') return;
  room.status = 'over';
  room.winner = winner;
  room.reason = reason;
  room.winLine = extra.winLine || null;
  room.pending = null;
  stopTurnTimer(room);
  broadcast(room, { type: 'gameover', winner: room.winner, reason: room.reason, winLine: room.winLine });
  clearTimeout(room.closeTimer);
  room.closeTimer = setTimeout(() => rooms.delete(room.code), ROOM_TTL_MS);
}

// ---------- 业务处理 ----------

function bindPlayer(ws, room, player) {
  player.ws = ws;
  player.online = true;
  ws.playerRef = { code: room.code, id: player.id };
}

// 掉线玩家找回座位：更新标签页标识、清掉判负定时器并绑定新连接
function rebindSeat(ws, room, player, tabId) {
  if (tabId) player.tabId = tabId;
  clearTimeout(player.dropTimer);
  player.dropTimer = null;
  bindPlayer(ws, room, player);
}

function handleCreate(ws, msg) {
  const name = cleanName(msg.name);
  if (!name) return send(ws, { type: 'error', text: '请输入昵称（1-12 个字）' });
  if (ws.playerRef) return;

  const room = makeRoom(randomCode());
  const tabId = String(msg.tabId || '').slice(0, 64) || null;
  const black = makePlayer(game.BLACK, name, tabId, resolveId(msg.playerId));
  room.players[game.BLACK - 1] = black;
  rooms.set(room.code, room);
  bindPlayer(ws, room, black);
  addChat(room, { type: 'chat', system: true, text: '房间已创建，把房间码发给好友，等待加入…', t: Date.now() });

  send(ws, { type: 'waiting', selfColor: game.BLACK, playerId: black.id, ...snapshot(room) });
}

function handleJoin(ws, msg) {
  const name = cleanName(msg.name);
  if (!name) return send(ws, { type: 'error', text: '请输入昵称（1-12 个字）' });
  if (ws.playerRef) return;
  const code = String(msg.code || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(code)) return send(ws, { type: 'error', text: '房间码应为 6 位字符' });
  const room = rooms.get(code);
  if (!room) return send(ws, { type: 'error', text: '房间不存在或已过期' });
  const tabId = String(msg.tabId || '').slice(0, 64) || null;

  // 对局中/已结束：允许掉线玩家用原昵称找回自己的座位
  if (room.status !== 'waiting') {
    const seat = room.players.find((p) => p && p.name === name);
    if (!seat) {
      const canRejoin = room.players.some((p) => p && !p.online);
      return send(ws, { type: 'error', text: canRejoin ? '对局进行中，请用掉线前的昵称进入找回座位' : '对局已经开始或房间已满' });
    }
    if (seat.online && seat.ws && seat.ws !== ws && tabId && seat.tabId && tabId !== seat.tabId) {
      return send(ws, { type: 'error', text: '这个房间已在另一个浏览器标签页打开' });
    }
    const wasOffline = !seat.online;
    rebindSeat(ws, room, seat, tabId);
    send(ws, { type: 'restore', selfColor: seat.color, playerId: seat.id, ...snapshot(room) });
    if (wasOffline && room.status === 'playing') {
      systemChat(room, `${seat.name} 已重新上线`);
      broadcast(room, { type: 'opponent:status', color: seat.color, online: true });
      resumeTimerIfNeeded(room);
    }
    return;
  }

  // 等待中：房主掉线时可用原昵称找回座位
  const host = room.players[0];
  if (host && host.name === name) {
    if (host.online && host.ws && host.ws !== ws && tabId && host.tabId && tabId !== host.tabId) {
      return send(ws, { type: 'error', text: '这个房间已在另一个浏览器标签页打开' });
    }
    const wasOffline = !host.online;
    rebindSeat(ws, room, host, tabId);
    send(ws, { type: 'restore', selfColor: host.color, playerId: host.id, ...snapshot(room) });
    if (wasOffline) systemChat(room, `${host.name} 回来了，继续等待好友加入…`);
    return;
  }
  if (!host || !host.online) return send(ws, { type: 'error', text: '房主不在线，请稍后再试' });
  if (host.name === name) return send(ws, { type: 'error', text: '昵称与房主重复了，换一个吧' });

  const white = makePlayer(game.WHITE, name, tabId, resolveId(msg.playerId, room.players));
  room.players[game.WHITE - 1] = white;
  bindPlayer(ws, room, white);
  room.status = 'playing';
  room.turn = game.BLACK;
  clearTimeout(room.players[0].dropTimer);
  room.players[0].dropTimer = null;

  systemChat(room, `${name}（白方）加入对局，黑方先行，祝好运！`);

  send(room.players[0].ws, { type: 'start', selfColor: game.BLACK, playerId: room.players[0].id, ...snapshot(room) });
  send(white.ws, { type: 'start', selfColor: game.WHITE, playerId: white.id, ...snapshot(room) });
  launchTimer(room, TURN_SECONDS * 1000);
}

function handleReconnect(ws, msg) {
  const code = String(msg.code || '').trim().toUpperCase();
  const room = rooms.get(code);
  const playerId = String(msg.playerId || '');
  const player = room && room.players.find((p) => p && p.id === playerId);
  if (!room || !player) {
    return send(ws, { type: 'error', fatal: true, text: '对局不存在或已过期，请重新建房' });
  }

  // 同一座位仍被另一个标签页的活动连接占用：禁止顶号（同标签页刷新 tabId 相同，放行）
  const tabId = String(msg.tabId || '').slice(0, 64) || null;
  if (player.online && player.ws && player.ws !== ws && tabId && player.tabId && tabId !== player.tabId) {
    return send(ws, { type: 'error', fatal: true, text: '这个房间已在另一个浏览器标签页打开' });
  }

  const wasOffline = !player.online;
  rebindSeat(ws, room, player, tabId);

  send(ws, { type: 'restore', selfColor: player.color, playerId: player.id, ...snapshot(room) });

  if (wasOffline) {
    if (room.status === 'playing') {
      systemChat(room, `${player.name} 已重新上线`);
      broadcast(room, { type: 'opponent:status', color: player.color, online: true });
      resumeTimerIfNeeded(room);
    } else if (room.status === 'waiting') {
      systemChat(room, `${player.name} 回来了，继续等待好友加入…`);
    }
  }
}

function requireSeat(ws) {
  if (!ws.playerRef) return null;
  const room = rooms.get(ws.playerRef.code);
  const player = room && room.players.find((p) => p && p.id === ws.playerRef.id);
  return room && player && player.ws === ws ? { room, player } : null;
}

function handleMove(room, player, msg) {
  if (room.status !== 'playing') return send(player.ws, { type: 'error', text: '对局不在进行中' });
  if (!room.players.every((p) => p.online)) return send(player.ws, { type: 'error', text: '对手掉线中，棋局暂停' });
  if (room.turn !== player.color) return send(player.ws, { type: 'error', text: '还没轮到你落子' });

  const x = Math.trunc(Number(msg.x));
  const y = Math.trunc(Number(msg.y));
  if (!game.isInside(x, y)) return send(player.ws, { type: 'error', text: '落子位置无效' });
  if (!game.placeStone(room.board, x, y, player.color)) {
    return send(player.ws, { type: 'error', text: '这个位置已经有棋子了' });
  }

  room.moves.push({ x, y, color: player.color });
  room.pending = null;
  const winLine = game.getWinLine(room.board, x, y, player.color);
  broadcast(room, { type: 'move', x, y, color: player.color, t: Date.now() });

  if (winLine) {
    systemChat(room, `${player.name}（${colorName(player.color)}）五连珠，获得胜利！`);
    return finishGame(room, player.color, 'win', { winLine });
  }
  if (game.isBoardFull(room.board)) {
    systemChat(room, '棋盘下满，本局和棋');
    return finishGame(room, null, 'draw-full');
  }
  room.turn = player.color === game.BLACK ? game.WHITE : game.BLACK;
  launchTimer(room, TURN_SECONDS * 1000);
}

function handleChat(room, player, msg) {
  if (!player.online) return;
  const now = Date.now();
  player.chatTimes = player.chatTimes.filter((t) => now - t < CHAT_WINDOW);
  if (player.chatTimes.length >= CHAT_LIMIT) {
    return send(player.ws, { type: 'error', text: '消息发得太频繁了，歇几秒再试' });
  }
  const text = String(msg.text == null ? '' : msg.text).trim().slice(0, CHAT_MAX);
  if (!text) return;
  player.chatTimes.push(now);
  addChat(room, { type: 'chat', from: player.color, name: player.name, text, t: now });
}

function handleSignal(room, player, kind, action) {
  if (room.status !== 'playing') return send(player.ws, { type: 'error', text: '对局不在进行中' });
  if (!room.players.every((p) => p.online)) return send(player.ws, { type: 'error', text: '对手掉线中，请稍候' });

  if (action === 'offer') {
    if (room.pending) return send(player.ws, { type: 'error', text: '已经有一个请求在等待回应了' });
    room.pending = { kind, from: player.color };
    broadcast(room, { type: 'signal', kind, action: 'offer', from: player.color, name: player.name });
    return;
  }

  // accept / decline 只能由被请求方发出
  if (!room.pending || room.pending.kind !== kind || room.pending.from === player.color) {
    return send(player.ws, { type: 'error', text: '当前没有待回应的请求' });
  }
  const requesterColor = room.pending.from;
  const requester = room.players.find((p) => p.color === requesterColor);
  room.pending = null;
  broadcast(room, { type: 'signal', kind, action, from: player.color, name: player.name });

  if (action === 'decline') {
    systemChat(room, `${player.name} 拒绝了${kind === 'draw' ? '和棋' : '悔棋'}请求`);
    return;
  }

  if (kind === 'draw') {
    systemChat(room, `${player.name} 同意和棋，本局结束`);
    return finishGame(room, null, 'draw-agree');
  }

  // 悔棋：撤销最后一手，回合回到被撤销的那一方
  const last = room.moves.pop();
  if (!last) return;
  room.board[last.y][last.x] = game.EMPTY;
  room.turn = last.color;
  broadcast(room, { type: 'undo', x: last.x, y: last.y, turn: room.turn });
  systemChat(room, `${player.name} 同意悔棋，${requester ? requester.name : colorName(last.color)} 重新落子`);
  launchTimer(room, TURN_SECONDS * 1000);
}

// ---------- WebSocket 连接 ----------

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (_) {
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;

    // 尚未绑定座位的消息
    if (msg.type === 'create') return handleCreate(ws, msg);
    if (msg.type === 'join') return handleJoin(ws, msg);
    if (msg.type === 'reconnect') return handleReconnect(ws, msg);

    const ctx = requireSeat(ws);
    if (!ctx) return send(ws, { type: 'error', fatal: true, text: '连接状态异常，请刷新页面' });
    const { room, player } = ctx;

    switch (msg.type) {
      case 'move':
        return handleMove(room, player, msg);
      case 'chat':
        return handleChat(room, player, msg);
      case 'resign': {
        if (room.status !== 'playing') return send(player.ws, { type: 'error', text: '对局不在进行中' });
        const winner = room.players.find((p) => p.color !== player.color);
        systemChat(room, `${player.name}（${colorName(player.color)}）认输，${winner ? winner.name : '对手'}获胜`);
        return finishGame(room, winner ? winner.color : null, 'resign');
      }
      case 'draw:offer':
      case 'draw:accept':
      case 'draw:decline':
        return handleSignal(room, player, 'draw', msg.type.split(':')[1]);
      case 'undo:request':
        return handleSignal(room, player, 'undo', 'offer');
      case 'undo:accept':
        return handleSignal(room, player, 'undo', 'accept');
      case 'undo:decline':
        return handleSignal(room, player, 'undo', 'decline');
      case 'ping':
        return send(ws, { type: 'pong' });
      case 'sync':
        // 客户端主动拉取最新房间状态（用于开局消息丢失等异常场景的补偿）
        return send(ws, { type: 'restore', selfColor: player.color, playerId: player.id, ...snapshot(room) });
      default:
        return;
    }
  });

  ws.on('close', () => onDisconnect(ws));
  ws.on('error', () => {
    /* close 事件会负责清理 */
  });
});

function onDisconnect(ws) {
  const ref = ws.playerRef;
  if (!ref) return;
  const room = rooms.get(ref.code);
  const player = room && room.players.find((p) => p && p.id === ref.id);
  if (!room || !player || player.ws !== ws) return;

  player.ws = null;
  player.online = false;
  ws.playerRef = null;

  if (room.status === 'playing') {
    pauseTimer(room);
    broadcast(room, { type: 'opponent:status', color: player.color, online: false });
    systemChat(room, `${player.name} 掉线了，棋局暂停，等待 10 分钟内重连…`);
    clearTimeout(player.dropTimer);
    player.dropTimer = setTimeout(() => {
      if (rooms.get(room.code) !== room || player.online) return;
      if (room.status === 'playing') {
        const winner = room.players.find((p) => p.color !== player.color);
        systemChat(room, `${player.name} 超时未归，判负`);
        finishGame(room, winner ? winner.color : null, 'disconnect');
      }
    }, DROP_GRACE_MS);
  } else if (room.status === 'waiting') {
    clearTimeout(room.closeTimer);
    room.closeTimer = setTimeout(() => {
      if (rooms.get(room.code) === room && !room.players[0].online) rooms.delete(room.code);
    }, DROP_GRACE_MS);
  }
}

// 心跳：清理僵尸连接
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch (_) {
      /* ignore */
    }
  }
}, 15000);
heartbeat.unref();

wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, () => {
  console.log(`五子棋服务已启动：http://localhost:${PORT}`);
});
