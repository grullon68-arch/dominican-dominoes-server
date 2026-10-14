'use strict';
/*
 * ai.js — Computer player for empty/disconnected seats.
 *
 * Heuristic (simple but sane):
 *   1. Pass only when no legal tile exists (forced-play rule).
 *   2. Otherwise play the legal tile with the highest pip count (dump points),
 *      with a small penalty for spending doubles (keeps doubles in hand —
 *      they only fit one number, so holding them preserves options).
 *   3. When a tile fits both open ends, play it on the end whose value the AI
 *      holds most of in its remaining hand (keeps future options open).
 */
const { legalTiles, fitsEnds, parseTile } = require('./game');

function chooseMove(st, seat) {
  const legal = legalTiles(st, seat);
  if (legal.length === 0) return { action: 'pass' };

  let best = null;
  let bestScore = -Infinity;
  for (const id of legal) {
    const t = parseTile(id);
    const score = (t.a + t.b) - (t.a === t.b ? 1.5 : 0);
    if (score > bestScore) { bestScore = score; best = t; }
  }

  if (st.chain.length === 0) return { action: 'play', tile: best.id, end: 'C' };

  const fits = fitsEnds(best, st.ends);
  let end;
  if (fits.length === 1) {
    end = fits[0];
  } else {
    // Count pips remaining in hand (excluding the tile about to be played).
    const count = {};
    for (const t of st.hands[seat]) {
      if (t.id === best.id) continue;
      count[t.a] = (count[t.a] || 0) + 1;
      count[t.b] = (count[t.b] || 0) + 1;
    }
    end = (count[st.ends.L] || 0) >= (count[st.ends.R] || 0) ? 'L' : 'R';
    if (!fits.includes(end)) end = fits[0];
  }
  return { action: 'play', tile: best.id, end };
}

module.exports = { chooseMove };
