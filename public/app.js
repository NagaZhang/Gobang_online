'use strict';

/* ================= 常量与状态 ================= */

const SIZE = 15;
const BLACK = 1;
const WHITE = 2;
const TURN_SECONDS = 35;
const SESSION_KEY = 'gomoku.session';
const NAME_KEY = 'gomoku.name';
const TAB_KEY = 'gomoku.tab';

// 标签页标识：同一标签页内刷新保持不变，新开的标签页会不同（用于防止同浏览器多标签顶号）
function getTabId() {
  try {
    let t = sessionStorage.getItem(TAB_KEY);
    if (!t) {
      t = 'tab-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      sessionStorage.setItem(TAB_KEY, t);
    }
    return t;
  } catch (_) {
    return 'tab-' + Math.random().toString(36).slice(2);
  }
}

// 生成与服务端 randomId 同格式的玩家 ID（24 位十六进制），用于开局消息丢失时凭 ID 恢复
function genId() {
  try {
    const b = new Uint8Array(12);
    crypto.getRandomValues(b);
    return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  } catch (_) {
    return Array.from({ length: 12 }, () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0')).join('');
  }
}

const S = {
  ws: null,
  netOpen: false,
  inRoom: false,
  retryTimer: null,
  code: null,
  playerId: null,
  tabId: getTabId(),
  selfColor: 0,
  status: 'lobby', // lobby | waiting | playing | over
  board: null,
  moves: [],
  turn: 0,
  players: [],
  chat: [],
  pending: null,
  winner: null,
  reason: null,
  winLine: null,
  remainSec: null,
  hover: null,
  pendingMove: null, // 已点选待确认的落子位置 {x,y}（需二次点击“确认落子”）
  cssSize: 0,
  syncTimer: null, // 等待期间定期同步状态的定时器
  joinWatch: null, // 好友提交加入后、收到开局前的补偿轮询定时器
  unreadChat: 0, // 未读聊天消息数（聊天区不在视口内时累加）
};

const $ = (id) => document.getElementById(id);
const els = {};

/* ================= 工具 ================= */

function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 2600);
}

function storageGet(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch (_) { return null; }
}
function storageSet(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch (_) { /* ignore */ }
}
function storageRemove(key) {
  try { localStorage.removeItem(key); } catch (_) { /* ignore */ }
}

function colorLabel(c) { return c === BLACK ? '黑方' : '白方'; }
function opponentOf(color) { return color === BLACK ? WHITE : BLACK; }
function bothOnline() {
  return S.players.length === 2 && S.players.every((p) => p.online);
}

/* ================= WebSocket ================= */

function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
}

function wsConnect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl());
    S.ws = ws;

    ws.addEventListener('open', () => {
      S.netOpen = true;
      setConnUI();
      resolve(ws);
    });
    ws.addEventListener('message', (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch (_) { return; }
      dispatch(msg);
    });
    ws.addEventListener('error', () => {
      reject(new Error('ws error'));
    });
    ws.addEventListener('close', () => {
      S.netOpen = false;
      setConnUI();
      if (S.inRoom || S.joinWatch) {
        toast('网络连接中断，正在尝试重连…');
        clearTimeout(S.retryTimer);
        S.retryTimer = setTimeout(safeReconnect, 1500);
      }
    });
  });
}

async function safeReconnect() {
  try {
    await wsConnect();
    // 只有手里握有房间码+玩家 ID（已建房/已加入/加入请求在途）才需要重连恢复
    if (S.code && S.playerId) {
      S.ws.send(JSON.stringify({ type: 'reconnect', code: S.code, playerId: S.playerId, tabId: S.tabId }));
    }
  } catch (_) {
    S.retryTimer = setTimeout(safeReconnect, 1500);
  }
}

function sendMsg(obj) {
  if (!S.ws || S.ws.readyState !== WebSocket.OPEN) {
    toast('网络未连接，正在重连…');
    return false;
  }
  S.ws.send(JSON.stringify(obj));
  return true;
}

/* ================= 大厅 ================= */

function initLobby() {
  const savedName = storageGet(NAME_KEY);
  if (savedName) {
    $('createName').value = savedName;
    $('joinName').value = savedName;
  }

  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
      const isCreate = tab.dataset.tab === 'create';
      $('paneCreate').hidden = !isCreate;
      $('paneJoin').hidden = isCreate;
      $('lobbyMsg').hidden = true;
    });
  });

  $('paneCreate').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('createName').value.trim();
    if (!name) return lobbyError('请输入昵称');
    storageSet(NAME_KEY, name);
    try {
      await wsConnect();
      S.playerId = genId();
      sendMsg({ type: 'create', name, tabId: S.tabId, playerId: S.playerId });
    } catch (_) {
      S.playerId = null;
      lobbyError('无法连接服务器，请检查网络后重试');
    }
  });

  $('paneJoin').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('joinName').value.trim();
    const code = $('joinCode').value.trim().toUpperCase();
    if (!name) return lobbyError('请输入昵称');
    if (!/^[A-Z0-9]{6}$/.test(code)) return lobbyError('房间码应为 6 位字符');
    storageSet(NAME_KEY, name);
    try {
      await wsConnect();
      // 先在本地记住 code + 预生成的 playerId：即使开局消息丢失，也能凭它重连/轮询恢复
      S.code = code;
      S.playerId = genId();
      sendMsg({ type: 'join', name, code, tabId: S.tabId, playerId: S.playerId });
      startJoinWatch();
    } catch (_) {
      stopJoinWatch();
      S.code = null;
      S.playerId = null;
      lobbyError('无法连接服务器，请检查网络后重试');
    }
  });

  // 启动时尝试恢复未结束的对局（URL 带 ?new 表示新开身份，跳过自动恢复）
  const isFreshEntry = new URLSearchParams(location.search).has('new');
  const session = isFreshEntry ? null : storageGet(SESSION_KEY);
  if (session && session.code && session.playerId) {
    $('reconnectBar').hidden = false;
    (async () => {
      try {
        await wsConnect();
        S.code = session.code;
        S.playerId = session.playerId;
        sendMsg({ type: 'reconnect', code: session.code, playerId: session.playerId, tabId: S.tabId });
      } catch (_) {
        $('reconnectBar').hidden = true;
      }
    })();
  }
}

function lobbyError(text) {
  const el = $('lobbyMsg');
  el.textContent = text;
  el.hidden = false;
}

/* ================= 进入/离开房间 ================= */

function enterRoom() {
  S.inRoom = true;
  $('lobby').hidden = true;
  $('room').hidden = false;
  $('reconnectBar').hidden = true;
  resizeBoard();
}

function leaveRoom() {
  S.inRoom = false;
  clearTimeout(S.retryTimer);
  if (S.syncTimer) { clearInterval(S.syncTimer); S.syncTimer = null; }
  stopJoinWatch();
  storageRemove(SESSION_KEY);
  if (S.ws) {
    S.ws.onclose = null; // 阻止自动重连
    try { S.ws.close(); } catch (_) { /* ignore */ }
  }
  Object.assign(S, {
    code: null, playerId: null, selfColor: 0, status: 'lobby',
    board: null, moves: [], players: [], chat: [], pending: null,
    winner: null, reason: null, winLine: null, remainSec: null, hover: null,
    pendingMove: null, unreadChat: 0,
  });
  $('room').hidden = true;
  $('lobby').hidden = false;
  $('lobbyMsg').hidden = true;
  $('reconnectBar').hidden = true;
  $('chatLog').innerHTML = '';
}

/* ================= 服务端消息分发 ================= */

function dispatch(msg) {
  switch (msg.type) {
    case 'waiting':
    case 'start':
    case 'restore':
      applySnapshot(msg);
      break;
    case 'move':
      onRemoteMove(msg);
      break;
    case 'undo':
      onRemoteUndo(msg);
      break;
    case 'tick':
      onTick(msg);
      break;
    case 'gameover':
      onGameOver(msg);
      break;
    case 'chat':
      appendChat(msg);
      if (S.inRoom) S.chat.push(msg);
      // 等待期间收到聊天（尤其是系统提示"加入对局"），立即拉取一次状态，
      // 防止开局消息丢失导致一直卡在等待界面
      if (S.status === 'waiting') requestSync();
      break;
    case 'signal':
      onSignal(msg);
      break;
    case 'opponent:status':
      onOpponentStatus(msg);
      break;
    case 'error':
      toast(msg.text);
      if (msg.fatal) {
        leaveRoom();
      } else if (S.joinWatch) {
        // 加入失败（房间不存在/昵称重复等）：停止补偿轮询，回到干净的大厅状态
        stopJoinWatch();
        S.code = null;
        S.playerId = null;
      }
      break;
    default:
      break;
  }
}

function applySnapshot(msg) {
  stopJoinWatch();
  storageSet(SESSION_KEY, { code: msg.code, playerId: msg.playerId });
  enterRoom();

  S.code = msg.code;
  S.playerId = msg.playerId;
  S.selfColor = msg.selfColor;
  S.status = msg.status;
  S.board = msg.board.map((row) => row.slice());
  S.moves = msg.moves.slice();
  S.turn = msg.turn;
  S.players = (msg.players || []).map((p) => ({ ...p }));
  S.chat = (msg.chat || []).slice();
  S.pending = msg.pending || null;
  S.pendingMove = null;
  S.winner = msg.winner;
  S.reason = msg.reason;
  S.winLine = msg.winLine;
  S.remainSec = msg.timer != null ? Math.ceil(msg.timer / 1000) : null;

  $('roomCode').textContent = S.code;
  rebuildChat();
  renderPlayers();
  renderSignal();
  refreshAll();
  updateSyncTimer();
}

// 向服务器拉取最新房间状态（用于开局消息丢失等异常的补偿）
function requestSync() {
  if (!S.inRoom || !S.netOpen) return;
  sendMsg({ type: 'sync' });
}

// 仅在"等待好友"状态下定期同步，避免开局消息丢失后一直卡住
function updateSyncTimer() {
  if (S.syncTimer) { clearInterval(S.syncTimer); S.syncTimer = null; }
  if (S.status === 'waiting') {
    S.syncTimer = setInterval(requestSync, 4000);
  }
}

// 好友提交加入后、收到开局前：定期凭预生成 ID 拉取状态，
// 防止好友侧的开局消息丢失导致永远停在大厅（最多补偿约 30 秒）
function startJoinWatch() {
  stopJoinWatch();
  let tries = 0;
  S.joinWatch = setInterval(() => {
    tries += 1;
    if (S.inRoom || tries > 12 || !S.code || !S.playerId) { stopJoinWatch(); return; }
    sendMsg({ type: 'reconnect', code: S.code, playerId: S.playerId, tabId: S.tabId });
  }, 2500);
}

function stopJoinWatch() {
  if (S.joinWatch) { clearInterval(S.joinWatch); S.joinWatch = null; }
}

function onRemoteMove(msg) {
  if (!S.board) return;
  S.board[msg.y][msg.x] = msg.color;
  S.moves.push({ x: msg.x, y: msg.y, color: msg.color });
  S.turn = opponentOf(msg.color);
  S.pending = null;
  S.pendingMove = null;
  S.remainSec = TURN_SECONDS;
  renderSignal();
  refreshAll();
}

function onRemoteUndo(msg) {
  if (!S.board) return;
  S.board[msg.y][msg.x] = 0;
  S.moves.pop();
  S.turn = msg.turn;
  S.pending = null;
  S.pendingMove = null;
  S.remainSec = TURN_SECONDS;
  renderSignal();
  refreshAll();
}

function onTick(msg) {
  if (S.status !== 'playing') return;
  S.turn = msg.turn;
  S.remainSec = msg.remaining;
  if (msg.paused && S.players.length === 2) {
    S.players.forEach((p) => { /* 掉线状态以 opponent:status 为准 */ });
  }
  renderTimer();
  renderPlayerCards();
}

function onGameOver(msg) {
  S.status = 'over';
  S.winner = msg.winner;
  S.reason = msg.reason;
  S.winLine = msg.winLine;
  S.pending = null;
  S.pendingMove = null;
  renderSignal();
  refreshAll();
  updateSyncTimer();
}

function onOpponentStatus(msg) {
  const p = S.players.find((x) => x.color === msg.color);
  if (p) p.online = msg.online;
  if (msg.online) S.remainSec = S.remainSec == null ? TURN_SECONDS : S.remainSec;
  refreshAll();
}

/* ================= 玩家信息 / 计时 / 状态 ================= */

function renderPlayers() {
  for (const color of [BLACK, WHITE]) {
    const p = S.players.find((x) => x.color === color);
    const nameEl = $(color === BLACK ? 'nameBlack' : 'nameWhite');
    const badgeEl = $(color === BLACK ? 'badgeBlack' : 'badgeWhite');
    if (p) {
      nameEl.textContent = p.name;
      if (p.color === S.selfColor) {
        badgeEl.textContent = '（你）';
        badgeEl.className = 'pbadge';
      } else {
        badgeEl.textContent = p.online ? '在线' : '掉线';
        badgeEl.className = 'pbadge' + (p.online ? ' online' : '');
      }
    } else {
      nameEl.textContent = color === BLACK ? '黑方' : '等待加入…';
      badgeEl.textContent = '';
      badgeEl.className = 'pbadge';
    }
  }
}

function renderPlayerCards() {
  for (const color of [BLACK, WHITE]) {
    const card = $(color === BLACK ? 'cardBlack' : 'cardWhite');
    card.classList.toggle('active', S.status === 'playing' && S.turn === color && bothOnline());
    card.classList.toggle('over', S.status === 'over' && S.winner === color);
  }
}

function renderTimer() {
  for (const color of [BLACK, WHITE]) {
    const el = $(color === BLACK ? 'timerBlack' : 'timerWhite');
    el.classList.remove('running', 'urgent', 'paused');
    if (S.status !== 'playing') {
      el.textContent = '--';
    } else if (S.turn === color) {
      const paused = !bothOnline();
      el.textContent = paused ? `${S.remainSec == null ? '--' : S.remainSec} 暂停` : String(S.remainSec == null ? TURN_SECONDS : S.remainSec);
      el.classList.add(paused ? 'paused' : 'running');
      if (!paused && S.remainSec != null && S.remainSec <= 10) el.classList.add('urgent');
    } else {
      el.textContent = String(TURN_SECONDS);
    }
  }
}

function updateStatusBar() {
  const bar = $('statusBar');
  if (!S.netOpen) { bar.textContent = '网络连接中断，正在尝试重连…'; return; }
  if (S.status === 'waiting') { bar.textContent = '房间已建好，等待好友输入房间码加入…'; return; }
  if (S.status === 'over') { bar.textContent = resultText().title; return; }
  if (S.status === 'playing') {
    if (!bothOnline()) { bar.textContent = '对手掉线，棋局已暂停，等待重连…'; return; }
    if (S.turn === S.selfColor) bar.textContent = `轮到你落子（你执${colorLabel(S.selfColor)}）`;
    else {
      const op = S.players.find((p) => p.color === opponentOf(S.selfColor));
      bar.textContent = `等待 ${op ? op.name : '对手'} 落子…`;
    }
  }
}

function resultText() {
  if (S.winner == null) return { title: '和棋', sub: overReasonSub() };
  const win = S.winner === S.selfColor;
  return { title: win ? '你赢了！' : '你输了', sub: overReasonSub(win) };
}

function overReasonSub(win) {
  const winnerName = (S.players.find((p) => p.color === S.winner) || {}).name;
  switch (S.reason) {
    case 'win': return '五连珠，对局结束';
    case 'resign': return win === undefined ? `${winnerName || '一方'}获胜` : (win ? '对手认输' : '你已认输');
    case 'timeout': return win ? '对手思考超时' : '你思考超时判负';
    case 'disconnect': return win ? '对手超时未重连' : '掉线超过 10 分钟';
    case 'draw-agree': return '双方同意和棋';
    case 'draw-full': return '棋盘下满，无子可落';
    default: return '';
  }
}

function updateControls() {
  const active = S.status === 'playing' && bothOnline() && S.netOpen;
  const outgoing = S.pending && S.pending.from === S.selfColor;
  $('btnUndo').disabled = !active || outgoing || S.moves.length === 0;
  $('btnDraw').disabled = !active || outgoing;
  $('btnResign').disabled = !active;
}

function refreshAll() {
  renderPlayers();
  renderPlayerCards();
  renderTimer();
  updateStatusBar();
  updateControls();
  updateMask();
  updateMoveConfirm();
  drawBoard();
}

function setConnUI() {
  if (!S.inRoom) return;
  updateStatusBar();
  updateControls();
  updateMask();
}

/* ================= 遮罩（等待 / 掉线 / 结束） ================= */

function updateMask() {
  const mask = $('boardMask');
  const title = $('maskTitle');
  const sub = $('maskSub');
  const back = $('btnMaskBack');
  const rematch = $('btnRematch');

  let show = null;
  if (!S.netOpen) {
    show = { title: '网络中断', sub: '正在尝试重新连接…', back: false, rematch: false };
  } else if (S.status === 'waiting') {
    show = { title: '等待好友加入', sub: `把房间码 ${S.code} 发给好友，好友在首页输入房间码即可进入`, back: false, rematch: false };
  } else if (S.status === 'playing' && !bothOnline()) {
    show = { title: '对手掉线了', sub: '棋局已暂停，对手 10 分钟内回来可继续', back: false, rematch: false };
  } else if (S.status === 'over') {
    const r = resultText();
    const canRematch = S.players.length === 2 && S.players.every((p) => p.online) && !S.pending;
    show = { title: r.title, sub: r.sub, back: true, rematch: canRematch };
  }

  if (!show) { mask.hidden = true; return; }
  title.textContent = show.title;
  sub.textContent = show.sub || '';
  back.hidden = !show.back;
  rematch.hidden = !show.rematch;
  mask.hidden = false;
}

/* ================= 和棋 / 悔棋请求条 ================= */

function renderSignal() {
  const bar = $('signalBar');
  bar.innerHTML = '';
  if (!S.pending) { bar.hidden = true; return; }

  const labelMap = { draw: '和棋', undo: '悔棋', rematch: '续战' };
  const label = labelMap[S.pending.kind] || '请求';
  // 续战请求在对局结束后才出现，其他请求只在 playing 中显示
  if (S.pending.kind !== 'rematch' && S.status !== 'playing') { bar.hidden = true; return; }
  if (S.pending.kind === 'rematch' && S.status !== 'over') { bar.hidden = true; return; }

  if (S.pending.from === S.selfColor) {
    bar.textContent = `已发起${label}请求，等待对方回应…`;
  } else {
    const from = S.players.find((p) => p.color === S.pending.from);
    const fragment = document.createElement('div');
    const line = document.createElement('div');
    line.textContent = `${from ? from.name : '对手'} 请求${label}`;
    const actions = document.createElement('div');
    actions.className = 'signal-actions';
    const ok = document.createElement('button');
    ok.className = 'btn primary tiny';
    ok.textContent = '接受';
    ok.addEventListener('click', () => sendMsg({ type: `${S.pending.kind}:accept` }));
    const no = document.createElement('button');
    no.className = 'btn tiny';
    no.textContent = '拒绝';
    no.addEventListener('click', () => sendMsg({ type: `${S.pending.kind}:decline` }));
    actions.append(ok, no);
    fragment.append(line, actions);
    bar.append(fragment);
  }
  bar.hidden = false;
}

function onSignal(msg) {
  if (msg.action === 'offer') {
    S.pending = { kind: msg.kind, from: msg.from };
  } else {
    S.pending = null;
  }
  renderSignal();
  updateControls();
}

/* ================= 聊天 ================= */

function buildChatNode(entry) {
  const wrap = document.createElement('div');
  if (entry.system) {
    wrap.className = 'chat-msg system';
    const s = document.createElement('span');
    s.className = 'sys';
    s.textContent = entry.text;
    wrap.append(s);
  } else {
    const mine = entry.from === S.selfColor;
    wrap.className = 'chat-msg' + (mine ? ' mine' : '');
    if (!mine) {
      const who = document.createElement('div');
      who.className = 'who';
      who.textContent = entry.name;
      wrap.append(who);
    }
    const bubble = document.createElement('span');
    bubble.className = 'bubble';
    bubble.textContent = entry.text;
    wrap.append(bubble);
  }
  return wrap;
}

function rebuildChat() {
  const log = $('chatLog');
  log.innerHTML = '';
  S.chat.forEach((entry) => log.append(buildChatNode(entry)));
  log.scrollTop = log.scrollHeight;
  clearUnread();
}

function appendChat(entry) {
  const log = $('chatLog');
  log.append(buildChatNode(entry));
  // 如果聊天区在视口内且已滚到底部，自动跟随；否则累加未读
  if (isChatVisible() && isScrolledToBottom(log)) {
    log.scrollTop = log.scrollHeight;
  } else {
    S.unreadChat += 1;
    updateChatBadge();
  }
}

function isScrolledToBottom(el) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 40;
}

function isChatVisible() {
  const box = $('chatLog').getBoundingClientRect();
  return box.top < window.innerHeight && box.bottom > 0;
}

function clearUnread() {
  S.unreadChat = 0;
  updateChatBadge();
}

function updateChatBadge() {
  const badge = $('chatBadge');
  if (S.unreadChat > 0) {
    badge.hidden = false;
    $('chatBadge').querySelector('.badge-text').textContent = `${S.unreadChat} 条新消息`;
  } else {
    badge.hidden = true;
  }
}

/* ================= Canvas 棋盘 ================= */

const canvas = $('board');
const ctx = canvas.getContext('2d');

function geometry(size) {
  const pad = size * 0.052;
  return { pad, cell: (size - pad * 2) / (SIZE - 1) };
}

function resizeBoard() {
  const box = canvas.parentElement;
  const size = box.clientWidth;
  if (!size) return;
  S.cssSize = size;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(size * dpr);
  canvas.height = Math.round(size * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawBoard();
}

function drawBoard() {
  const size = S.cssSize;
  if (!size || !S.board) return;
  const { pad, cell } = geometry(size);

  // 木纹底色
  const bg = ctx.createLinearGradient(0, 0, size, size);
  bg.addColorStop(0, '#eec882');
  bg.addColorStop(1, '#dfaf5f');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, size, size);

  // 网格
  ctx.strokeStyle = '#6b4a1f';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i < SIZE; i++) {
    const p = pad + i * cell;
    ctx.moveTo(pad, p);
    ctx.lineTo(size - pad, p);
    ctx.moveTo(p, pad);
    ctx.lineTo(p, size - pad);
  }
  ctx.stroke();

  // 星位
  const stars = [[3, 3], [3, 11], [11, 3], [11, 11], [7, 7]];
  ctx.fillStyle = '#6b4a1f';
  for (const [sx, sy] of stars) {
    ctx.beginPath();
    ctx.arc(pad + sx * cell, pad + sy * cell, Math.max(3, cell * 0.09), 0, Math.PI * 2);
    ctx.fill();
  }

  const winSet = new Set((S.winLine || []).map(([x, y]) => `${x},${y}`));
  const last = S.moves.length ? S.moves[S.moves.length - 1] : null;
  const r = cell * 0.44;

  // 待确认的选点：半透明棋子 + 醒目高亮圈
  if (S.pendingMove && canPlayNow() && S.board[S.pendingMove.y][S.pendingMove.x] === 0) {
    const { x, y } = S.pendingMove;
    drawStone(x, y, S.selfColor, r, true);
    ctx.save();
    ctx.strokeStyle = '#e67e22';
    ctx.lineWidth = Math.max(2, cell * 0.08);
    ctx.setLineDash([cell * 0.18, cell * 0.14]);
    ctx.beginPath();
    ctx.arc(pad + x * cell, pad + y * cell, r + cell * 0.12, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  } else if (S.hover && S.status === 'playing' && S.turn === S.selfColor && bothOnline() &&
             S.board[S.hover.y][S.hover.x] === 0) {
    // 悬停预览（尚未点选时）
    drawStone(S.hover.x, S.hover.y, S.selfColor, r, true);
  }

  // 棋子
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (S.board[y][x] !== 0) drawStone(x, y, S.board[y][x], r, false);
    }
  }

  // 最后一手标记
  if (last && S.status !== 'over') {
    ctx.fillStyle = last.color === BLACK ? '#e74c3c' : '#c0392b';
    ctx.beginPath();
    ctx.arc(pad + last.x * cell, pad + last.y * cell, cell * 0.1, 0, Math.PI * 2);
    ctx.fill();
  }

  // 胜利连线高亮
  if (S.winLine && S.winLine.length >= 2) {
    const first = S.winLine[0];
    const endP = S.winLine[S.winLine.length - 1];
    ctx.strokeStyle = 'rgba(231,76,60,.85)';
    ctx.lineWidth = Math.max(3, cell * 0.12);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(pad + first[0] * cell, pad + first[1] * cell);
    ctx.lineTo(pad + endP[0] * cell, pad + endP[1] * cell);
    ctx.stroke();
  }
}

function drawStone(x, y, color, r, ghost) {
  const { pad, cell } = geometry(S.cssSize);
  const cx = pad + x * cell;
  const cy = pad + y * cell;

  ctx.save();
  if (ghost) ctx.globalAlpha = 0.4;

  const grad = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.35, r * 0.15, cx, cy, r);
  if (color === BLACK) {
    grad.addColorStop(0, '#666');
    grad.addColorStop(1, '#0e0e0e');
  } else {
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(1, '#c8c8c8');
  }
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();

  if (color === WHITE) {
    ctx.strokeStyle = 'rgba(0,0,0,.18)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  ctx.restore();
}

function eventToCoord(e) {
  const rect = canvas.getBoundingClientRect();
  const { pad, cell } = geometry(rect.width);
  const fx = (e.clientX - rect.left - pad) / cell;
  const fy = (e.clientY - rect.top - pad) / cell;
  const x = Math.round(fx);
  const y = Math.round(fy);
  if (x < 0 || x >= SIZE || y < 0 || y >= SIZE) return null;
  if (Math.abs(fx - x) > 0.45 || Math.abs(fy - y) > 0.45) return null;
  return { x, y };
}

canvas.addEventListener('pointermove', (e) => {
  if (S.status !== 'playing' || S.turn !== S.selfColor || !bothOnline()) return;
  const c = eventToCoord(e);
  const changed = !S.hover || !c || S.hover.x !== c.x || S.hover.y !== c.y;
  S.hover = c;
  if (changed) drawBoard();
});
canvas.addEventListener('pointerleave', () => {
  if (S.hover) { S.hover = null; drawBoard(); }
});
canvas.addEventListener('pointerdown', (e) => {
  if (S.status !== 'playing' || S.turn !== S.selfColor || !bothOnline()) return;
  const c = eventToCoord(e);
  if (!c || !S.board || S.board[c.y][c.x] !== 0) return;
  // 第一次点击：选中位置（不直接落子），再点其他空位可改选
  selectPendingMove(c.x, c.y);
});

/* ================= 二次确认落子 ================= */

function canPlayNow() {
  return S.status === 'playing' && S.turn === S.selfColor && bothOnline() && S.netOpen;
}

function selectPendingMove(x, y) {
  S.pendingMove = { x, y };
  drawBoard();
  updateMoveConfirm();
}

function clearPendingMove() {
  if (!S.pendingMove) return;
  S.pendingMove = null;
  drawBoard();
  updateMoveConfirm();
}

function updateMoveConfirm() {
  const bar = $('moveConfirmBar');
  const show = !!(S.pendingMove && canPlayNow());
  if (show) {
    $('moveConfirmHint').textContent = `已选第 ${S.pendingMove.y + 1} 行、第 ${S.pendingMove.x + 1} 列，确认落子？`;
  }
  bar.hidden = !show;
}

window.addEventListener('resize', resizeBoard);
// 标签页从后台切回时画布尺寸 0→实际值，用 ResizeObserver 保证重新绘制
if (typeof ResizeObserver !== 'undefined') {
  new ResizeObserver(resizeBoard).observe(canvas.parentElement);
}

/* ================= 房间内操作 ================= */

function bindRoomControls() {
  $('btnCopy').addEventListener('click', async () => {
    const text = `来和我下五子棋！打开 ${location.origin} ，输入房间码 ${S.code} 加入对局`;
    try {
      await navigator.clipboard.writeText(text);
      toast('邀请语已复制，发给好友吧');
    } catch (_) {
      toast(`房间码：${S.code}`);
    }
  });

  $('btnLeave').addEventListener('click', () => {
    if (S.status === 'playing' && bothOnline()) {
      if (!confirm('对局正在进行，确定离开吗？离开后对局将暂停 10 分钟。')) return;
    }
    leaveRoom();
  });

  $('btnMaskBack').addEventListener('click', () => leaveRoom());

  $('btnUndo').addEventListener('click', () => {
    if (confirm('向对手发起悔棋申请？')) sendMsg({ type: 'undo:request' });
  });
  $('btnDraw').addEventListener('click', () => sendMsg({ type: 'draw:offer' }));
  $('btnResign').addEventListener('click', () => {
    if (confirm('确定认输吗？')) sendMsg({ type: 'resign' });
  });

  $('chatForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('chatText');
    const text = input.value.trim();
    if (!text) return;
    if (sendMsg({ type: 'chat', text })) input.value = '';
  });

  // 聊天区滚动到底部时清除未读红点
  $('chatLog').addEventListener('scroll', () => {
    if (isScrolledToBottom($('chatLog'))) clearUnread();
  });
  // 点击红点提示滚动到聊天区
  $('chatBadge').addEventListener('click', () => {
    $('chatLog').scrollIntoView({ behavior: 'smooth', block: 'center' });
    $('chatLog').scrollTop = $('chatLog').scrollHeight;
    clearUnread();
  });

  // 续战按钮
  $('btnRematch').addEventListener('click', () => {
    sendMsg({ type: 'rematch:request' });
    toast('已发送续战请求，等待对方回应…');
  });

  // 二次确认落子
  $('btnConfirmMove').addEventListener('click', () => {
    if (!S.pendingMove || !canPlayNow()) return;
    const { x, y } = S.pendingMove;
    if (sendMsg({ type: 'move', x, y })) clearPendingMove();
  });
  $('btnCancelMove').addEventListener('click', () => clearPendingMove());
}

/* ================= 移动端软键盘适配 ================= */

// 聊天输入框聚焦（软键盘弹起）时压缩布局：隐藏非必要区块、按可视高度缩小棋盘，
// 保证打字时整个棋盘和聊天输入框都在屏幕内
function initKeyboardAware() {
  const input = $('chatText');
  const vv = window.visualViewport;
  const root = document.documentElement;
  const apply = () => {
    root.style.setProperty('--vvh', (vv ? vv.height : window.innerHeight) + 'px');
  };
  input.addEventListener('focus', () => {
    document.body.classList.add('keyboard-open');
    clearPendingMove();
    apply();
  });
  input.addEventListener('blur', () => {
    document.body.classList.remove('keyboard-open');
    apply();
  });
  if (vv) {
    vv.addEventListener('resize', apply);
    vv.addEventListener('scroll', apply);
  }
  apply();
}

/* ================= 启动 ================= */

initLobby();
bindRoomControls();
initKeyboardAware();
