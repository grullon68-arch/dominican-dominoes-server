'use strict';
/*
 * game.js — Pure FichaFlow Dominican domino rules engine (no I/O).
 *
 * Table model
 *   Seats 0..3. Turn order is counter-clockwise: 0 (bottom) -> 1 (right) ->
 *   2 (top) -> 3 (left) -> 0 ...  Teams are fixed 2v2: seats {0,2} vs {1,3}
 *   (partners sit across from each other).
 *
 * Tiles are {a, b, id} with a <= b, id like "3-5". The chain is stored as an
 * ordered list of placements; each placement records which END of the chain
 * ('L' or 'R', 'C' for the opening tile) the tile was played on, so clients
 * can rebuild the serpentine layout. st.ends = {L, R} are the open values.
 */

const MAX_PIP = 6;
const BONUS_CAPICUA = 25;
const BONUS_SALIDA = 25;      // pase de salida
const BONUS_PASO_REDONDO = 25;
const TARGET_SCORE = 200;

function tileId(a, b) { return a <= b ? `${a}-${b}` : `${b}-${a}`; }
function parseTile(id) {
  const m = /^([0-6])-([0-6])$/.exec(id);
  if (!m) throw new Error(`bad tile id: ${id}`);
  const a = +m[1], b = +m[2];
  return { a: Math.min(a, b), b: Math.max(a, b), id: tileId(a, b) };
}
function pipsOf(t) { return t.a + t.b; }
function handPips(hand) { return hand.reduce((s, t) => s + pipsOf(t), 0); }
function teamOf(seat) { return seat % 2; }          // 0,2 -> team 0; 1,3 -> team 1
function nextSeat(seat) { return (seat + 1) % 4; }  // counter-clockwise
function partnerOf(seat) { return (seat + 2) % 4; }

function makeDeck() {
  const d = [];
  for (let a = 0; a <= MAX_PIP; a++)
    for (let b = a; b <= MAX_PIP; b++)
      d.push({ a, b, id: tileId(a, b) });
  return d; // 28 tiles
}

function shuffle(deck, rand = Math.random) {
  const d = deck.slice();
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

/* Deal a fresh hand. `leaderSeat` plays first. `scores` is the match score. */
function newHand(scores, handNumber, leaderSeat, rand) {
  const deck = shuffle(makeDeck(), rand);
  const hands = [[], [], [], []];
  for (let i = 0; i < 28; i++) hands[i % 4].push(deck[i]);
  for (const h of hands) h.sort((x, y) => (x.a - y.a) || (x.b - y.b));
  return {
    hands,
    chain: [],            // [{seat, tile:'a-b', end:'L'|'R'|'C', double:bool}]
    ends: null,           // {L, R} once the chain is open
    turn: leaderSeat,
    leader: leaderSeat,
    consecutivePasses: 0,
    passRoundStarter: null, // seat that started the current run of passes
    lastPlayedSeat: null,   // seat that played the most recent tile (the tranquer on a block)
    salidaTeam: null,       // team that played the opening tile of this hand
    mustOpenBurro: handNumber === 1, // hand 1 MUST open with the 6-6
    scores: scores.slice(),
    handNumber,
    over: null,             // filled by resolveDomino/resolveTranque
  };
}

function findBurroHolder(hands) {
  for (let s = 0; s < 4; s++) if (hands[s].some(t => t.id === '6-6')) return s;
  return 0; // cannot happen with a full 28-tile deal
}

/* Which chain ends ('L' and/or 'R') can this tile be played on? */
function fitsEnds(tile, ends) {
  const fits = [];
  if (tile.a === ends.L || tile.b === ends.L) fits.push('L');
  if (tile.a === ends.R || tile.b === ends.R) fits.push('R');
  return fits;
}

/* Legal tile ids for `seat`. On an empty chain the leader may play anything
 * (hand 1: only the 6-6 burro). */
function legalTiles(st, seat) {
  const hand = st.hands[seat];
  if (st.chain.length === 0) {
    if (st.mustOpenBurro) return hand.filter(t => t.id === '6-6').map(t => t.id);
    return hand.map(t => t.id);
  }
  return hand.filter(t => fitsEnds(t, st.ends).length > 0).map(t => t.id);
}

/*
 * Capicúa: the winning tile is a NON-double whose two values are exactly the
 * two open end values (in any order) — i.e. it could have been played on
 * either end. Checked against the ends as they were BEFORE the winning play.
 */
function isCapicua(tile, endsBefore) {
  if (!endsBefore || tile.a === tile.b) return false;
  const vals = [tile.a, tile.b].sort((x, y) => x - y);
  const ends = [endsBefore.L, endsBefore.R].sort((x, y) => x - y);
  return vals[0] === ends[0] && vals[1] === ends[1];
}

/* Play a tile. Throws on any illegal move. Returns a result object; when the
 * hand ends, result.handOver is the scoring summary. */
function applyPlay(st, seat, tileId, end) {
  if (st.over) throw new Error('hand is already over');
  if (st.turn !== seat) throw new Error(`not seat ${seat}'s turn`);
  const idx = st.hands[seat].findIndex(t => t.id === tileId);
  if (idx < 0) throw new Error(`seat ${seat} does not hold tile ${tileId}`);
  const tile = st.hands[seat][idx];

  let placement;
  let capicua = false;
  if (st.chain.length === 0) {
    // Opening play: goes in the middle, crossed. No end choice exists.
    if (st.mustOpenBurro && tile.id !== '6-6')
      throw new Error('hand 1 must open with the 6-6 burro');
    st.ends = { L: tile.a, R: tile.b };
    placement = { seat, tile: tile.id, end: 'C', double: tile.a === tile.b };
  } else {
    const fits = fitsEnds(tile, st.ends);
    if (fits.length === 0) throw new Error(`tile ${tileId} does not fit either end`);
    const chosen = end || (fits.length === 1 ? fits[0] : null);
    if (!chosen) throw new Error('tile fits both ends: choose_end');
    if (!fits.includes(chosen)) throw new Error(`tile ${tileId} does not fit end ${chosen}`);
    const endVal = st.ends[chosen];
    capicua = isCapicua(tile, st.ends);
    // The matching half touches the chain; the other half becomes the new end.
    const newVal = (tile.a === endVal) ? tile.b : tile.a;
    st.ends = chosen === 'L' ? { L: newVal, R: st.ends.R } : { L: st.ends.L, R: newVal };
    placement = { seat, tile: tile.id, end: chosen, double: tile.a === tile.b };
  }

  st.hands[seat].splice(idx, 1);
  st.chain.push(placement);
  st.lastPlayedSeat = seat;
  if (st.salidaTeam === null) st.salidaTeam = teamOf(seat);
  st.consecutivePasses = 0;
  st.passRoundStarter = null;

  if (st.hands[seat].length === 0) {
    return { ok: true, placement, handOver: resolveDomino(st, seat, capicua) };
  }
  st.turn = nextSeat(seat);
  return { ok: true, placement, handOver: null };
}

/* Pass. Only legal when the player truly has no playable tile. */
function applyPass(st, seat) {
  if (st.over) throw new Error('hand is already over');
  if (st.turn !== seat) throw new Error(`not seat ${seat}'s turn`);
  if (legalTiles(st, seat).length > 0) throw new Error('must play: a legal tile exists');
  if (st.consecutivePasses === 0) st.passRoundStarter = seat;
  st.consecutivePasses += 1;
  if (st.consecutivePasses >= 4) {
    return { ok: true, passed: true, handOver: resolveTranque(st) };
  }
  st.turn = nextSeat(seat);
  return { ok: true, passed: true, handOver: null };
}

/*
 * DOMINÓ scoring: the team of the player who went out scores the pips left
 * in the OPPONENTS' hands only.
 * Bonuses: capicúa +25 (last tile non-double matching both ends);
 *          pase de salida +25 (the team that played the salida wins the hand).
 */
function resolveDomino(st, seat, capicua) {
  const team = teamOf(seat);
  const oppPips = [0, 1, 2, 3]
    .filter(s => teamOf(s) !== team)
    .reduce((sum, s) => sum + handPips(st.hands[s]), 0);
  let points = oppPips;
  const bonuses = [];
  if (capicua) { points += BONUS_CAPICUA; bonuses.push({ type: 'capicua', team, points: BONUS_CAPICUA }); }
  if (st.salidaTeam === team) { points += BONUS_SALIDA; bonuses.push({ type: 'pase_de_salida', team, points: BONUS_SALIDA }); }
  st.scores[team] += points;
  st.over = {
    reason: 'domino', winnerSeat: seat, winnerTeam: team,
    points, bonuses, scores: st.scores.slice(),
    detail: { oppPips, capicua, salidaTeam: st.salidaTeam },
  };
  return st.over;
}

/*
 * TRANQUE (FichaFlow) scoring: 4 consecutive passes = blocked.
 * The TRANQUER is the last player who played a tile before the passes.
 * Compare the tranquer's remaining pips vs the NEXT player's remaining pips:
 * fewest pips wins; a tie goes to the tranquer. The winning SIDE scores the
 * pips in ALL FOUR hands. Bonus: paso redondo +25 to the team of the player
 * who started that 4-pass round.
 */
function resolveTranque(st) {
  const tranquer = st.lastPlayedSeat;
  const nxt = nextSeat(tranquer);
  const pipsTranquer = handPips(st.hands[tranquer]);
  const pipsNext = handPips(st.hands[nxt]);
  const winnerSeat = pipsTranquer <= pipsNext ? tranquer : nxt; // tie -> tranquer
  const team = teamOf(winnerSeat);
  const allPips = [0, 1, 2, 3].reduce((sum, s) => sum + handPips(st.hands[s]), 0);
  let points = allPips;
  const bonuses = [];
  const redondoTeam = teamOf(st.passRoundStarter);
  points += BONUS_PASO_REDONDO;
  bonuses.push({ type: 'paso_redondo', team: redondoTeam, points: BONUS_PASO_REDONDO, bySeat: st.passRoundStarter });
  st.scores[team] += points;
  st.over = {
    reason: 'tranque', winnerSeat, winnerTeam: team,
    points, bonuses, scores: st.scores.slice(),
    detail: { tranquer, nextSeat: nxt, pipsTranquer, pipsNext, allPips, passRoundStarter: st.passRoundStarter },
  };
  return st.over;
}

module.exports = {
  MAX_PIP, BONUS_CAPICUA, BONUS_SALIDA, BONUS_PASO_REDONDO, TARGET_SCORE,
  tileId, parseTile, pipsOf, handPips, teamOf, nextSeat, partnerOf,
  makeDeck, shuffle, newHand, findBurroHolder,
  legalTiles, fitsEnds, isCapicua,
  applyPlay, applyPass, resolveDomino, resolveTranque,
};
