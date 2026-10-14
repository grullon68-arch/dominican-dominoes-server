'use strict';
/*
 * server.js — Online multiplayer server for FichaFlow Dominican dominoes.
 *
 * One Node process:
 *   - serves the static client (client/) over HTTP,
 *   - runs the authoritative game over WebSocket (JSON messages),
 *   - holds rooms in memory (fine for friends & family; see README for limits).
 *
 * Run:  npm install && node server.js        (PORT env var, default 3000)
 *
 * PROTOCOL (see README.md for the full reference)
 *   C->S: create{name} | join{code,name} | rejoin{code,token} | start |
 *          play{tile,end} | pass
 *   S->C: room | seats | hand_start | turn | your_move | played | passed |
 *          hand_end | match_end | state | error
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const G = require('./game');
const { chooseMove } = require('./ai');

const PORT = process.env.PORT || 3000;
const AI_DELAY_MS = 900;          // pause before a computer player moves
const REJOIN_HOLD_MS = 2 * 60 * 1000; // how long a dropped seat is held
const NEXT_HAND_DELAY_MS = 6000;  // pause between hands so players can read results

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const AI_NAMES = ['Rosa', 'Papo', 'Chino'];

const rooms = new Map(); // code -> room

/* ---------------- helpers ---------------- */
const nowISO = () => new Date().toISOString();
function log(...args) { console.log(`[${nowISO()}]`, ...args); }

function makeCode() {
  let code;
  do {
    code = Array.from({ length: 6 },
      () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join('');
  } while (rooms.has(code));
  return code;
}
const makeToken = () => crypto.randomBytes(16).toString('hex');
const cleanName = (n) => String(n || '').trim().slice(0, 20) || 'Jugador';

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}
function seatPublic(room, s) {
  const seat = room.seats[s];
  if (!seat) return { name: null, human: false, connected: false, ai: false };
  return { name: seat.name, human: seat.human, connected: seat.connected, ai: seat.ai };
}
function publicSeats(room) {
  return [0, 1, 2, 3].map(s => ({ seat: s, ...seatPublic(room, s) }));
}
function broadcast(room, obj) {
  for (const seat of room.seats) if (seat && seat.ws) send(seat.ws, obj);
}
function sendTo(room, s, obj) {
  const seat = room.seats[s];
  if (seat && seat.ws) send(seat.ws, obj);
}
function tableSnapshot(room) {
  const st = room.st;
  return {
    chain: st.chain, ends: st.ends, turn: st.turn,
    remaining: [0, 1, 2, 3].map(s => st.hands[s].length),
    consecutivePasses: st.consecutivePasses,
  };
}
/* A seat is computer-driven when it is an AI seat or its human dropped. */
function isAiDriven(room, s) {
  const seat = room.seats[s];
  return !seat || seat.ai || !seat.connected;
}

/* ---------------- room flow ---------------- */
function handleCreate(ws, name) {
  const code = makeCode();
  const room = {
    code, phase: 'lobby',
    seats: [null, null, null, null],
    scores: [0, 0], handNumber: 0, st: null, lastWinner: null,
    aiTimer: null, handTimer: null, rejoinTimers: new Map(),
  };
  const token = makeToken();
  room.seats[0] = { name: cleanName(name), human: true, connected: true, ws, token, ai: false };
  ws._room = room; ws._seat = 0;
  rooms.set(code, room);
  log(`room ${code} created by "${room.seats[0].name}"`);
  send(ws, { t: 'room', code, seat: 0, token, seats: publicSeats(room) });
}

function handleJoin(ws, code, name, wantSeat) {
  code = String(code || '').toUpperCase().trim();
  const room = rooms.get(code);
  if (!room) return send(ws, { t: 'error', msg: 'No existe una mesa con ese código.' });
  if (room.phase !== 'lobby') return send(ws, { t: 'error', msg: 'La partida ya empezó.' });
  let free;
  const s = parseInt(wantSeat, 10);
  if (s >= 0 && s <= 3 && !room.seats[s]) {
    free = s;
  } else if (s >= 0 && s <= 3 && room.seats[s]) {
    return send(ws, { t: 'error', msg: 'Ese asiento está ocupado. Elige otro.' });
  } else {
    free = [0, 1, 2, 3].find(s => !room.seats[s]);
  }
  if (free === undefined) return send(ws, { t: 'error', msg: 'La mesa está llena.' });
  const token = makeToken();
  room.seats[free] = { name: cleanName(name), human: true, connected: true, ws, token, ai: false };
  ws._room = room; ws._seat = free;
  log(`"${room.seats[free].name}" joined room ${code} at seat ${free}`);
  send(ws, { t: 'room', code, seat: free, token, seats: publicSeats(room) });
  broadcast(room, { t: 'seats', seats: publicSeats(room) });
}

function handleMove(ws, fromSeat, toSeat) {
  const room = ws._room;
  if (!room || room.phase !== 'lobby') return;
  // Only the host (seat 0, the creator) can rearrange seats
  if (ws._seat !== 0) return send(ws, { t: 'error', msg: 'Solo el creador puede mover asientos.' });
  fromSeat = parseInt(fromSeat, 10); toSeat = parseInt(toSeat, 10);
  if (!(fromSeat >= 0 && fromSeat <= 3 && toSeat >= 0 && toSeat <= 3)) return;
  if (fromSeat === toSeat) return;
  if (!room.seats[fromSeat] || room.seats[toSeat]) return send(ws, { t: 'error', msg: 'Movimiento inválido.' });
  // Move the player
  room.seats[toSeat] = room.seats[fromSeat];
  room.seats[fromSeat] = null;
  // Update the moved player's seat reference if they're connected
  const moved = room.seats[toSeat];
  if (moved.ws) moved.ws._seat = toSeat;
  log(`room ${room.code}: host moved "${moved.name}" from seat ${fromSeat} to ${toSeat}`);
  broadcast(room, { t: 'seats', seats: publicSeats(room) });
}

function handleRejoin(ws, code, token) {
  code = String(code || '').toUpperCase().trim();
  const room = rooms.get(code);
  const seatIdx = room ? [0, 1, 2, 3].find(s => room.seats[s] && room.seats[s].token === token) : undefined;
  if (room === undefined || seatIdx === undefined) {
    return send(ws, { t: 'error', msg: 'No se pudo reconectar. Revisa el código.' });
  }
  const seat = room.seats[seatIdx];
  if (seat.rejoinExpired) return send(ws, { t: 'error', msg: 'Tu asiento ya fue tomado por la computadora.' });
  if (room.rejoinTimers.has(seatIdx)) { clearTimeout(room.rejoinTimers.get(seatIdx)); room.rejoinTimers.delete(seatIdx); }
  seat.ws = ws; seat.connected = true; seat.ai = false;
  ws._room = room; ws._seat = seatIdx;
  log(`"${seat.name}" reconnected to room ${code} at seat ${seatIdx}`);
  send(ws, fullState(room, seatIdx));
  broadcast(room, { t: 'seats', seats: publicSeats(room) });
  if (room.phase === 'playing' && room.st && !room.st.over) promptTurn(room);
}

function fullState(room, seatIdx) {
  const st = room.st;
  return {
    t: 'state', code: room.code, seat: seatIdx,
    phase: room.phase, scores: room.scores, handNumber: room.handNumber,
    seats: publicSeats(room),
    yourHand: st ? st.hands[seatIdx].map(t => t.id) : [],
    ...tableSnapshot(room),
  };
}

function handleStart(ws) {
  const room = ws._room;
  if (!room || ws._seat !== 0) return send(ws, { t: 'error', msg: 'Solo el creador puede empezar.' });
  if (room.phase !== 'lobby') return send(ws, { t: 'error', msg: 'La partida ya empezó.' });
  // Fill every empty seat with a computer player.
  const used = new Set(room.seats.filter(Boolean).map(s => s.name));
  let aiIdx = 0;
  for (let s = 0; s < 4; s++) {
    if (!room.seats[s]) {
      let nm = AI_NAMES.find(n => !used.has(n)) || `CPU ${++aiIdx}`;
      used.add(nm);
      room.seats[s] = { name: nm, human: false, connected: false, ws: null, token: null, ai: true };
    }
  }
  room.phase = 'playing';
  room.scores = [0, 0];
  room.handNumber = 0;
  room.lastWinner = null;
  log(`room ${room.code} started: ${room.seats.map(s => `${s.name}${s.ai ? '(CPU)' : ''}`).join(', ')}`);
  broadcast(room, { t: 'seats', seats: publicSeats(room) });
  startHand(room);
}

function startHand(room) {
  room.handNumber += 1;
  const st = G.newHand(room.scores, room.handNumber, 0); // leader corrected below
  room.st = st;
  if (room.handNumber === 1) st.turn = st.leader = G.findBurroHolder(st.hands);
  else st.turn = st.leader = room.lastWinner;
  log(`room ${room.code} — hand ${room.handNumber}, leads seat ${st.leader} (${room.seats[st.leader].name})`);
  for (let s = 0; s < 4; s++) {
    if (room.seats[s].human) {
      sendTo(room, s, {
        t: 'hand_start', handNumber: room.handNumber, leader: st.leader,
        yourHand: st.hands[s].map(t => t.id), scores: room.scores,
        seats: publicSeats(room),
      });
    }
  }
  broadcast(room, { t: 'table', ...tableSnapshot(room) });
  promptTurn(room);
}

function promptTurn(room) {
  const st = room.st;
  if (!st || st.over || room.phase !== 'playing') return;
  const seat = st.turn;
  broadcast(room, { t: 'turn', seat, ends: st.ends, consecutivePasses: st.consecutivePasses });
  if (isAiDriven(room, seat)) {
    clearTimeout(room.aiTimer);
    room.aiTimer = setTimeout(() => aiMove(room, seat),
      AI_DELAY_MS + Math.floor(Math.random() * 600));
  } else {
    sendTo(room, seat, {
      t: 'your_move', legal: G.legalTiles(st, seat), ends: st.ends,
      mustOpenBurro: st.chain.length === 0 && st.mustOpenBurro,
    });
  }
}

function aiMove(room, seat) {
  const st = room.st;
  if (!st || st.over || st.turn !== seat || room.phase !== 'playing') return;
  const mv = chooseMove(st, seat);
  try {
    if (mv.action === 'pass') {
      const r = G.applyPass(st, seat);
      log(`room ${room.code} — ${room.seats[seat].name} (CPU) pasa`);
      broadcast(room, { t: 'passed', seat, ...tableSnapshot(room) });
      afterMove(room, r);
    } else {
      const r = G.applyPlay(st, seat, mv.tile, mv.end);
      log(`room ${room.code} — ${room.seats[seat].name} (CPU) juega ${mv.tile} -> ${mv.end}`);
      broadcast(room, { t: 'played', seat, tile: mv.tile, end: mv.end, ...tableSnapshot(room) });
      afterMove(room, r);
    }
  } catch (err) {
    log(`room ${room.code} — AI error at seat ${seat}: ${err.message}`);
  }
}

function onHumanPlay(ws, tile, end) {
  const room = ws._room, seat = ws._seat;
  if (!room || room.phase !== 'playing' || !room.st) return send(ws, { t: 'error', msg: 'No hay partida activa.' });
  const st = room.st;
  try {
    const r = G.applyPlay(st, seat, tile, end);
    log(`room ${room.code} — ${room.seats[seat].name} juega ${tile} -> ${r.placement.end}`);
    broadcast(room, { t: 'played', seat, tile, end: r.placement.end, ...tableSnapshot(room) });
    afterMove(room, r);
  } catch (err) {
    send(ws, { t: 'error', msg: err.message === 'choose_end' ? 'choose_end' : err.message });
    if (room.st.turn === seat && !isAiDriven(room, seat)) {
      sendTo(room, seat, { t: 'your_move', legal: G.legalTiles(st, seat), ends: st.ends, mustOpenBurro: false });
    }
  }
}

function onHumanPass(ws) {
  const room = ws._room, seat = ws._seat;
  if (!room || room.phase !== 'playing' || !room.st) return send(ws, { t: 'error', msg: 'No hay partida activa.' });
  const st = room.st;
  try {
    const r = G.applyPass(st, seat);
    log(`room ${room.code} — ${room.seats[seat].name} pasa`);
    broadcast(room, { t: 'passed', seat, ...tableSnapshot(room) });
    afterMove(room, r);
  } catch (err) {
    send(ws, { t: 'error', msg: err.message });
  }
}

function afterMove(room, r) {
  if (r.handOver) return onHandOver(room, r.handOver);
  promptTurn(room);
}

function onHandOver(room, over) {
  clearTimeout(room.aiTimer);
  room.lastWinner = over.winnerSeat;
  const st = room.st;
  log(`room ${room.code} — hand ${room.handNumber} over: ${over.reason}, ` +
      `seat ${over.winnerSeat} (${room.seats[over.winnerSeat].name}), ` +
      `+${over.points} team ${over.winnerTeam} (bonuses: ${over.bonuses.map(b => b.type).join(',') || 'none'}), ` +
      `scores ${over.scores[0]}-${over.scores[1]}`);
  broadcast(room, {
    t: 'hand_end',
    reason: over.reason, winnerSeat: over.winnerSeat, winnerTeam: over.winnerTeam,
    points: over.points, bonuses: over.bonuses, detail: over.detail,
    scores: over.scores,
    hands: [0, 1, 2, 3].map(s => st.hands[s].map(t => t.id)), // reveal for the recap
  });
  const champ = over.scores[0] >= G.TARGET_SCORE ? 0 : over.scores[1] >= G.TARGET_SCORE ? 1 : null;
  clearTimeout(room.handTimer);
  room.handTimer = setTimeout(() => {
    if (champ !== null) {
      log(`room ${room.code} — MATCH over, team ${champ} wins ${over.scores[0]}-${over.scores[1]}`);
      broadcast(room, { t: 'match_end', winnerTeam: champ, scores: over.scores });
      room.phase = 'lobby'; // room can be reused; creator starts again
      broadcast(room, { t: 'seats', seats: publicSeats(room) });
    } else {
      startHand(room);
    }
  }, NEXT_HAND_DELAY_MS);
}

function onDisconnect(ws) {
  const room = ws._room;
  if (!room || ws._seat === undefined) return;
  const seatIdx = ws._seat;
  const seat = room.seats[seatIdx];
  if (!seat || !seat.human || seat.ws !== ws) return;
  seat.connected = false;
  seat.ws = null;
  log(`room ${room.code} — "${seat.name}" disconnected from seat ${seatIdx} (held ${REJOIN_HOLD_MS / 1000}s)`);
  broadcast(room, { t: 'seats', seats: publicSeats(room) });
  // An AI drives the seat meanwhile so the game never stalls.
  if (room.phase === 'playing' && room.st && !room.st.over && room.st.turn === seatIdx) promptTurn(room);
  clearTimeout(room.rejoinTimers.get(seatIdx));
  room.rejoinTimers.set(seatIdx, setTimeout(() => {
    const s = room.seats[seatIdx];
    if (s && s.human && !s.connected) {
      s.rejoinExpired = true;
      s.ai = true; // seat becomes a permanent computer player
      log(`room ${room.code} — seat ${seatIdx} rejoin window expired, now CPU`);
      broadcast(room, { t: 'seats', seats: publicSeats(room) });
    }
    room.rejoinTimers.delete(seatIdx);
  }, REJOIN_HOLD_MS));
}

/* ---------------- HTTP: serve the static client ---------------- */
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon' };
function serveStatic(req, res) {
  if (req.url === '/health') { res.writeHead(200); res.end('ok'); return; }
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.join(__dirname, 'client', path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

function createServer(port = PORT) {
  const httpServer = http.createServer(serveStatic);
  const wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return send(ws, { t: 'error', msg: 'Mensaje inválido.' }); }
      try {
        switch (msg.t) {
          case 'create': handleCreate(ws, msg.name); break;
          case 'join': handleJoin(ws, msg.code, msg.name, msg.seat); break;
          case 'rejoin': handleRejoin(ws, msg.code, msg.token); break;
          case 'move': handleMove(ws, msg.from, msg.to); break;
          case 'start': handleStart(ws); break;
          case 'play': onHumanPlay(ws, msg.tile, msg.end); break;
          case 'pass': onHumanPass(ws); break;
          default: send(ws, { t: 'error', msg: 'Mensaje desconocido.' });
        }
      } catch (err) {
        log('handler error:', err.message);
        send(ws, { t: 'error', msg: 'Error interno.' });
      }
    });
    ws.on('close', () => onDisconnect(ws));
    ws.on('error', () => {});
  });

  httpServer.listen(port, () => log(`listening on port ${port}`));
  return { httpServer, wss, rooms };
}

if (require.main === module) createServer();

module.exports = { createServer, rooms };
