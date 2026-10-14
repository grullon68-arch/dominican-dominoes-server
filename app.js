'use strict';
/* Dominó Dominicano — Online client (plain JS, no build step).
 * Talks to server.js over WebSocket. The server is authoritative; this file
 * only renders and forwards the player's taps.
 */

const $ = (id) => document.getElementById(id);

// ---------- connection ----------
let ws = null;
let myCode = null, myToken = null, mySeat = null, myName = 'Jugador';
let connectedOnce = false;

function wsURL() {
  if (location.protocol === 'file:') return null;
  return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
}
function connect(onOpen) {
  const url = wsURL();
  if (!url) { $('lobbyError').textContent = 'Abre esta página desde el servidor (no como archivo).'; return; }
  ws = new WebSocket(url);
  ws.onopen = () => { $('reconnect').classList.add('hidden'); if (onOpen) onOpen(); };
  ws.onmessage = (ev) => handleMsg(JSON.parse(ev.data));
  ws.onclose = () => { $('reconnect').classList.remove('hidden'); scheduleReconnect(); };
  ws.onerror = () => { try { ws.close(); } catch (e) {} };
}
let reconnectTimer = null;
function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    if (!myCode || !myToken) { showScreen('screen-lobby'); $('reconnect').classList.add('hidden'); return; }
    connect(() => send({ t: 'rejoin', code: myCode, token: myToken }));
  }, 2000);
}
function send(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }

// ---------- screens ----------
function showScreen(id) {
  for (const s of ['screen-lobby', 'screen-room', 'screen-table'])
    $(s).classList.toggle('hidden', s !== id);
}

// ---------- game state ----------
let seats = [];            // [{seat,name,human,connected,ai}]
let hand = [];             // my tile ids
let chain = [];            // placements [{seat,tile,end,double}]
let ends = null, turnSeat = null, scores = [0, 0], handNumber = 0;
let legal = [], selected = null, choosingEnd = false;
let remaining = [7, 7, 7, 7];

const AVATAR_COLORS = ['#3f7fbf', '#c05a3f', '#4fae62', '#9a6fc0'];

// relative position of a seat around MY table: bottom=me, top=partner, left/right=opponents
function relPos(s) {
  const d = (s - mySeat + 4) % 4;
  return ['bottom', 'right', 'top', 'left'][d];
}
function teamOf(s) { return s % 2; }

// ---------- message handling ----------
function handleMsg(m) {
  switch (m.t) {
    case 'room':
      myCode = m.code; mySeat = m.seat; myToken = m.token; seats = m.seats;
      try { localStorage.setItem('ddo', JSON.stringify({ code: myCode, token: myToken, name: myName })); } catch (e) {}
      $('roomCode').textContent = m.code;
      renderRoom(); showScreen('screen-room');
      break;
    case 'seats':
      seats = m.seats; renderRoom();
      if (!$('screen-table').classList.contains('hidden')) renderSeats();
      break;
    case 'hand_start':
      handNumber = m.handNumber; hand = m.yourHand.slice(); scores = m.scores;
      chain = []; ends = null; selected = null; choosingEnd = false;
      remaining = [7, 7, 7, 7];
      hideModal(); renderScores(); renderHand(); renderChain(); renderSeats();
      setPrompt(`Mano ${m.handNumber} — sale ${seatName(m.leader)}`);
      break;
    case 'table':
      chain = m.chain; ends = m.ends; turnSeat = m.turn; remaining = m.remaining;
      renderChain(); renderSeats(); updateTurnUI();
      break;
    case 'turn':
      turnSeat = m.seat; ends = m.ends; renderSeats(); updateTurnUI();
      break;
    case 'your_move':
      legal = m.legal; ends = m.ends;
      selected = null; choosingEnd = false;
      renderHand(); renderChain();
      if (legal.length === 0) { setPrompt('No tienes juego — te toca pasar.'); $('btnPass').classList.remove('hidden'); }
      else { setPrompt(chain.length === 0 ? 'Toca tu ficha para salir.' : 'Tu turno — toca una ficha.'); $('btnPass').classList.add('hidden'); }
      break;
    case 'played':
      chain = m.chain; ends = m.ends; turnSeat = m.turn; remaining = m.remaining;
      if (m.seat === mySeat) hand = hand.filter(id => id !== m.tile);
      selected = null; choosingEnd = false;
      renderChain(); renderHand(); renderSeats(); updateTurnUI();
      setPrompt(`${seatName(m.seat)} juega ${m.tile}.`);
      break;
    case 'passed':
      chain = m.chain; ends = m.ends; turnSeat = m.turn; remaining = m.remaining;
      renderChain(); renderSeats(); updateTurnUI();
      setPrompt(`${seatName(m.seat)} pasa.`);
      break;
    case 'hand_end': onHandEnd(m); break;
    case 'match_end': onMatchEnd(m); break;
    case 'state':
      // rejoin snapshot
      seats = m.seats; scores = m.scores; handNumber = m.handNumber;
      hand = m.yourHand || []; chain = m.chain || []; ends = m.ends;
      turnSeat = m.turn; remaining = m.remaining || [7, 7, 7, 7];
      showScreen('screen-table');
      renderScores(); renderHand(); renderChain(); renderSeats(); updateTurnUI();
      setPrompt('Reconectado.');
      break;
    case 'error':
      if (m.msg === 'choose_end') setPrompt('Esa ficha cabe en las dos puntas — toca una punta.');
      else if ($('screen-lobby').classList.contains('hidden') === false) $('lobbyError').textContent = m.msg;
      else if ($('screen-room').classList.contains('hidden') === false) $('roomError').textContent = m.msg;
      else setPrompt(m.msg);
      break;
  }
}

// ---------- lobby / room ----------
function renderRoom() {
  const ul = $('seatList'); ul.innerHTML = '';
  const names = ['Tú'];
  seats.forEach(s => {
    const li = document.createElement('li');
    let tag = '';
    if (!s.name) tag = '<span class="empty">vacío</span>';
    else if (s.ai) tag = `<span>${esc(s.name)}</span><span class="cpu">computadora</span>`;
    else tag = `<span>${esc(s.name)}${s.seat === mySeat ? ' (tú)' : ''}</span><span>${s.connected ? '🟢' : '🔴'}</span>`;
    li.innerHTML = `<span>Asiento ${s.seat + 1}</span>${tag}`;
    ul.appendChild(li);
  });
  const isCreator = mySeat === 0;
  $('btnStart').classList.toggle('hidden', !isCreator);
  $('roomHint').textContent = isCreator
    ? 'Cuando estén listos, empieza. Los asientos vacíos los juega la computadora.'
    : 'Esperando al creador…';
}
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function seatName(s) { const st = seats[s]; return st && st.name ? st.name : `Asiento ${s + 1}`; }

// ---------- table rendering ----------
function renderScores() {
  $('scoreUs').textContent = scores[teamOf(mySeat)];
  $('scoreThem').textContent = scores[1 - teamOf(mySeat)];
  const mate = seats[(mySeat + 2) % 4];
  $('teamUsName').textContent = `Tú${mate && mate.name ? ' y ' + mate.name : ''}`;
}
function renderSeats() {
  const table = $('table');
  table.querySelectorAll('.tseat').forEach(e => e.remove());
  if (mySeat === null) return;
  seats.forEach(s => {
    if (!s.name) return;
    const d = document.createElement('div');
    d.className = 'tseat ' + relPos(s.seat);
    if (s.seat === turnSeat) d.classList.add('active');
    const initials = s.name.trim().slice(0, 2).toUpperCase();
    // AVATAR: replace the initials div with <img src="avatars/x.png"> to use Eddy's art
    d.innerHTML = `<div class="avatar" style="background:${AVATAR_COLORS[s.seat]}">${esc(initials)}</div>` +
      `<div class="who">${esc(s.name)}${s.ai ? ' 🤖' : ''}</div>`;
    const rack = document.createElement('div');
    rack.className = 'rack';
    if (s.seat !== mySeat) {
      const n = remaining[s.seat] ?? 0;
      for (let i = 0; i < n; i++) { const m = document.createElement('div'); m.className = 'mini'; rack.appendChild(m); }
    }
    d.appendChild(rack);
    table.appendChild(d);
  });
}

const PIPS = { 0: [], 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
function pipHalf(val) {
  const d = document.createElement('div');
  d.className = 'half';
  for (let i = 0; i < 9; i++) {
    const p = document.createElement('div');
    p.className = 'pip' + (PIPS[val].includes(i) ? '' : ' off');
    d.appendChild(p);
  }
  return d;
}
function parseId(id) { const [a, b] = id.split('-').map(Number); return { a, b }; }

/* Chain layout: two independent serpentine arms (L and R) growing from the
 * crossed opening tile at the center. Each arm runs horizontally until it
 * would leave the table, then a turn tile drops perpendicular and the arm
 * continues on the next row in the opposite direction. */
function layoutChain(placements, halfPx) {
  let L = 64, T = 32;
  if (placements.length > 16) { L = 52; T = 26; }
  if (placements.length > 22) { L = 44; T = 22; }
  const GAP = 6, pitch = L + T + GAP, limit = halfPx - L * 0.55;
  const slots = [];
  if (!placements.length) return { slots, L, T, tipL: -1, tipR: -1 };
  slots.push({ p: placements[0], x: 0, y: 0, rot: 90, inward: 'top' });
  const arms = { L: { edge: -T / 2, y: 0, dx: -1 }, R: { edge: T / 2, y: 0, dx: 1 } };
  const tips = { L: 0, R: 0 };
  for (let i = 1; i < placements.length; i++) {
    const p = placements[i];
    const arm = arms[p.end] || arms.R;
    const along = p.double ? T : L;      // crossed doubles are narrow along travel
    const cx = arm.edge + arm.dx * (along / 2);
    let slot;
    if (Math.abs(cx) + along / 2 <= limit) {
      slot = { p, x: cx, y: arm.y, rot: p.double ? 90 : 0, inward: arm.dx > 0 ? 'left' : 'right' };
      arm.edge += arm.dx * along;
    } else {
      const tx = arm.edge + arm.dx * (T / 2);
      const ny = arm.y + pitch, cy = (arm.y + ny) / 2;
      slot = { p, x: tx, y: cy, rot: 90, turn: true, inward: 'top' };
      arm.y = ny; arm.dx = -arm.dx;      // edge stays: next tile meets the turn tile's inner face
    }
    slots.push(slot);
    tips[p.end] = slots.length - 1;
  }
  // recenter the whole chain on the table
  let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
  for (const s of slots) {
    const w = s.rot === 90 ? T : L, h = s.rot === 90 ? L : T;
    x0 = Math.min(x0, s.x - w / 2); x1 = Math.max(x1, s.x + w / 2);
    y0 = Math.min(y0, s.y - h / 2); y1 = Math.max(y1, s.y + h / 2);
  }
  const ox = -(x0 + x1) / 2, oy = -(y0 + y1) / 2;
  for (const s of slots) { s.x += ox; s.y += oy; }
  return { slots, L, T, tipL: tips.L, tipR: tips.R };
}

function tileDiv(a, b, w, h, horizontal) {
  const d = document.createElement('div');
  d.className = 'tile ' + (horizontal ? 'h' : 'v');
  d.style.width = w + 'px'; d.style.height = h + 'px';
  d.appendChild(pipHalf(a)); d.appendChild(pipHalf(b));
  return d;
}

function renderChain() {
  const el = $('chain'); el.innerHTML = '';
  const table = $('table');
  const halfPx = table.clientWidth / 2 || 260;
  const { slots, L, T, tipL, tipR } = layoutChain(chain, halfPx);
  // replay ends to know which half of each tile faces the chain interior
  let e = null;
  slots.forEach((s, idx) => {
    const p = s.p, t = parseId(p.tile);
    let first, second; // first = left (h) or top (v)
    if (idx === 0) { e = { L: t.a, R: t.b }; first = t.a; second = t.b; }
    else {
      const endVal = p.end === 'L' ? e.L : e.R;
      const innerIsA = (t.a === endVal);
      const inner = innerIsA ? t.a : t.b, outer = innerIsA ? t.b : t.a;
      if (s.inward === 'left' || s.inward === 'top') { first = inner; second = outer; }
      else { first = outer; second = inner; }
      const nv = innerIsA ? t.b : t.a;
      e = p.end === 'L' ? { L: nv, R: e.R } : { L: e.L, R: nv };
    }
    const w = s.rot === 90 ? T : L, h = s.rot === 90 ? L : T;
    const d = tileDiv(first, second, w, h, s.rot !== 90);
    d.style.left = `calc(50% + ${s.x - w / 2}px)`;
    d.style.top = `calc(50% + ${s.y - h / 2}px)`;
    d.dataset.slot = idx;
    if (choosingEnd && (idx === tipL || idx === tipR) && chain.length > 0) {
      d.classList.add('endchoice');
      d.onclick = () => playSelected(idx === tipL ? 'L' : 'R');
    }
    el.appendChild(d);
  });
}

// ---------- hand & interaction ----------
function fitsEndsClient(id, e) {
  if (!e) return [];
  const t = parseId(id), fits = [];
  if (t.a === e.L || t.b === e.L) fits.push('L');
  if (t.a === e.R || t.b === e.R) fits.push('R');
  return fits;
}
function renderHand() {
  const el = $('hand'); el.innerHTML = '';
  if (!hand.length) return;
  const wrapW = el.clientWidth || 360;
  const w = Math.min(56, (wrapW - 6 * 6) / 7);
  hand.forEach(id => {
    const t = parseId(id);
    const d = tileDiv(t.a, t.b, w, w * 2, false);
    d.classList.add('hand-tile');
    if (legal.includes(id)) d.classList.add('legal');
    if (selected === id) d.classList.add('selected');
    d.onclick = () => onTileTap(id);
    el.appendChild(d);
  });
}
function onTileTap(id) {
  if (!legal.includes(id)) return;
  if (chain.length === 0) { send({ t: 'play', tile: id, end: 'C' }); return; } // opening: auto
  const fits = fitsEndsClient(id, ends);
  if (fits.length <= 1) { send({ t: 'play', tile: id, end: fits[0] || 'L' }); return; }
  if (selected === id) { selected = null; choosingEnd = false; } // tap again to deselect
  else { selected = id; choosingEnd = true; }
  renderHand(); renderChain();
  setPrompt(choosingEnd ? 'Toca la punta de la cadena donde la pones.' : 'Tu turno — toca una ficha.');
}
function playSelected(end) {
  if (!selected) return;
  send({ t: 'play', tile: selected, end });
  selected = null; choosingEnd = false;
}
function updateTurnUI() {
  renderSeats();
  if (turnSeat === mySeat) { /* your_move will arrive with the legal list */ }
  else { $('btnPass').classList.add('hidden'); }
}
function setPrompt(t) { $('prompt').textContent = t || ''; }

// ---------- modals ----------
function showModal(html) { $('modalCard').innerHTML = html; $('modal').classList.remove('hidden'); }
function hideModal() { $('modal').classList.add('hidden'); }

function onHandEnd(m) {
  const won = m.winnerTeam === teamOf(mySeat);
  const rows = m.bonuses.map(b =>
    `<tr><td>Bono: ${bonusName(b.type)}</td><td>+${b.points}</td></tr>`).join('');
  showModal(`<h2>${m.reason === 'domino' ? '🁢 Dominó' : '🔒 Tranque'}</h2>
    <p class="${won ? 'winner' : ''}">${won ? '¡Ganaron la mano!' : 'La ganaron ellos.'} — ${esc(seatName(m.winnerSeat))}</p>
    <table><tr><td>Puntos de la mano</td><td>+${m.points}</td></tr>${rows}
    <tr><td><b>Nosotros</b></td><td><b>${m.scores[teamOf(mySeat)]}</b></td></tr>
    <tr><td>Ellos</td><td>${m.scores[1 - teamOf(mySeat)]}</td></tr></table>
    <p class="hint">Siguiente mano en camino…</p>`);
}
function bonusName(t) {
  return { capicua: 'Capicúa', pase_de_salida: 'Pase de salida', paso_redondo: 'Paso redondo' }[t] || t;
}
function onMatchEnd(m) {
  const won = m.winnerTeam === teamOf(mySeat);
  showModal(`<h2>🏆 ${won ? '¡Ganaron la partida!' : 'La ganaron ellos.'}</h2>
    <p class="winner">${m.scores[teamOf(mySeat)]} — ${m.scores[1 - teamOf(mySeat)]}</p>
    <button class="btn gold" onclick="backToLobby()">Volver</button>`);
}
window.backToLobby = () => { hideModal(); showScreen('screen-lobby'); };

// ---------- wire up ----------
$('btnCreate').onclick = () => {
  myName = $('nameInput').value.trim() || 'Jugador';
  $('lobbyError').textContent = '';
  connect(() => send({ t: 'create', name: myName }));
};
$('btnJoin').onclick = () => {
  myName = $('nameInput').value.trim() || 'Jugador';
  const code = $('codeInput').value.trim().toUpperCase();
  if (!code) { $('lobbyError').textContent = 'Escribe el código de la mesa.'; return; }
  $('lobbyError').textContent = '';
  connect(() => send({ t: 'join', code, name: myName }));
};
$('btnStart').onclick = () => send({ t: 'start' });
$('btnPass').onclick = () => send({ t: 'pass' });

// auto-rejoin if we have a saved session
try {
  const saved = JSON.parse(localStorage.getItem('ddo') || 'null');
  if (saved && saved.code && saved.token) {
    myCode = saved.code; myToken = saved.token; myName = saved.name || 'Jugador';
    $('nameInput').value = myName;
  }
} catch (e) {}
