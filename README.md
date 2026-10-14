# Dominó Dominicano — Online Multiplayer

Real online multiplayer for Eddy's FichaFlow Dominican dominoes game:
**4 people on 4 phones**, room codes to join, empty seats filled by
computer players. One Node.js process serves the game page **and** runs the
authoritative game server (WebSocket).

## The rules (FichaFlow, as specified)

- 4 players, fixed 2v2: seats 0+2 vs 1+3 (partners across). Counter-clockwise turns.
- 28 tiles dealt complete, 7 each, no boneyard.
- Hand 1 opens with the 6-6 (burro); later hands are led by the previous hand's winner.
- Forced play — passing is only legal with no playable tile.
- **Dominó**: winner's team scores the pips left in the *opponents'* hands.
- **Tranque** (4 straight passes): the *tranquer* (last to play a tile) vs the
  *next* player — fewest pips wins, tie goes to the tranquer; the winning side
  scores *all four* hands.
- Bonuses: **capicúa** +25 (last tile is a non-double matching both ends),
  **pase de salida** +25 (the team that played the salida wins the hand),
  **paso redondo** +25 (to the team of the player who started the 4-pass round).
- First team to **200** wins the match.

## Run it locally

Requirements: **Node.js 18+** (https://nodejs.org).

```bash
cd dominican-dominoes-online
npm install
node server.js
```

Then open **http://localhost:3000** in a browser.

### Play a test game (2 minutes)

1. Open http://localhost:3000 in **4 browser tabs** (or on 2 phones on the
   same Wi-Fi — see below).
2. Tab 1: type a name → **Crear mesa** → you get a 6-letter room code.
3. Tabs 2–4: type a name, enter the code → **Unirse**.
4. Tab 1 (the creator): **Empezar partida**. Empty seats become computer players.
5. Play: tap a tile, then tap the glowing end of the chain to choose the side.

### Test with phones on the same Wi-Fi (no internet needed)

1. On the computer running the server, find its local IP
   (Windows: `ipconfig` · Mac/Linux: `ifconfig` or `ip addr` — look for
   `192.168.x.x`).
2. On each phone's browser open `http://192.168.x.x:3000`
   (same Wi-Fi network, server still running on the computer).
3. Create/join with the room code as above.

## Put it on the internet (for real online play)

The server must run on a computer that's on the public internet 24/7.
Three concrete options, easiest first:

### Option A — Railway (easiest, ~$5/month free credit)

1. Create an account at https://railway.app (GitHub login works).
2. New Project → **Deploy from GitHub repo** — push this folder to a GitHub
   repo first (`git init`, commit, push), or use Railway's empty-service +
   upload.
3. Railway auto-detects Node (`npm start`). Add nothing else.
4. In **Settings → Networking**, generate a public domain.
   You get `https://xxx.up.railway.app` — open it on any phone, anywhere.
5. Cost: Railway gives ~$5 of usage credit monthly; this tiny app fits in it.
   Beyond that, roughly $5–10/month.

### Option B — Render (free tier exists)

1. Account at https://render.com, New → **Web Service**, point it at your
   GitHub repo with this folder.
2. Build command: `npm install` · Start command: `npm start`.
   Render sets `PORT` automatically — the server already respects it.
3. You get `https://xxx.onrender.com`. Free tier sleeps after inactivity
   (first load takes ~30s to wake); paid (~$7/month) stays awake.

### Option C — Fly.io (cheap, stays awake)

1. Install `flyctl`, account at https://fly.io.
2. In this folder: `fly launch` (say yes to Dockerfile generation — or add a
   one-line Dockerfile: `FROM node:20`, copy files, `CMD ["node","server.js"]`),
   then `fly deploy`.
3. Roughly $2–5/month for an app this small.

### What Eddy needs for any option

- An account with the host (email + password).
- This project folder uploaded to a GitHub repo (all three hosts deploy
  straight from GitHub — that's the normal path).
- A phone to test: open the public URL, create a table, share the code.

The client files (`client/`) are served by the same Node process, so **one
deploy covers everything** — no separate website hosting needed. (You *can*
also host `client/` on any static host, but then `app.js` must point at the
game server: change `wsURL()` to your server's `wss://` address.)

## WebSocket protocol (JSON)

Client → server:

| message | meaning |
|---|---|
| `{t:"create", name}` | create a room, take seat 0, get `room` reply with code + token |
| `{t:"join", code, name}` | join a lobby room |
| `{t:"rejoin", code, token}` | rejoin a dropped seat within 2 min (AI holds it meanwhile) |
| `{t:"start"}` | creator (seat 0) starts; empty seats become AI |
| `{t:"play", tile:"a-b", end:"L"\|"R"}` | play a tile on an end (`end` ignored for the opening tile; required when a tile fits both ends) |
| `{t:"pass"}` | pass (server rejects it if you have a legal tile) |

Server → client:

| message | meaning |
|---|---|
| `{t:"room", code, seat, token, seats}` | your seat assignment (save the token for rejoin) |
| `{t:"seats", seats}` | seat roster changed |
| `{t:"hand_start", handNumber, leader, yourHand, scores}` | new hand dealt (your tiles only — opponents' are hidden) |
| `{t:"turn", seat, ends, consecutivePasses}` | whose turn (broadcast) |
| `{t:"your_move", legal:[…], ends}` | it's your turn — only you get your legal tiles |
| `{t:"played", seat, tile, end, chain, ends, turn, remaining}` | a tile was placed (+ table snapshot) |
| `{t:"passed", seat, …}` | someone passed (+ table snapshot) |
| `{t:"table", chain, ends, turn, remaining}` | full table snapshot |
| `{t:"hand_end", reason, winnerSeat, winnerTeam, points, bonuses, detail, scores, hands}` | hand over (`reason`: `domino`/`tranque`; all hands revealed) |
| `{t:"match_end", winnerTeam, scores}` | a team reached 200 |
| `{t:"state", …}` | full snapshot after a rejoin |
| `{t:"error", msg}` | illegal move / bad code, etc. (never trusted client input) |

## Project layout

```
dominican-dominoes-online/
├── server.js        # HTTP + WebSocket server, rooms, authoritative game flow
├── game.js          # pure FichaFlow rules engine (deck, moves, scoring)
├── ai.js            # computer-player heuristic
├── package.json
├── client/
│   ├── index.html   # lobby + table screens
│   ├── styles.css   # table look (DR-flag surface via CSS)
│   └── app.js       # rendering, taps, reconnect
├── test/
│   ├── rules.test.js  # 14 unit tests: engine, bonuses, tranque, AI legality
│   └── e2e.js         # boots the real server, 4 WS clients play a full hand
└── README.md
```

Run the tests: `npm test` (unit tests + live end-to-end game).

## Swapping in Eddy's art

- **Front logo**: the client currently opens straight into the lobby. To add
  Eddy's logo screen, add an `<img src="logo.jpg">` block at the top of the
  lobby card in `client/index.html` (drop the file into `client/`).
- **Avatars**: `client/app.js` → `renderSeats()` draws initial circles. Replace
  the `.avatar` div with `<img src="avatars/rosa.png">` per seat (see the
  `AVATAR` comment in the code and the note in `styles.css`).

## Honest limits

- **One Node process holds all rooms in memory.** Perfect for friends and
  family (dozens of tables). If the process restarts, active games are lost.
  Scaling beyond that would need Redis/a database for room state and multiple
  processes — a later step, not needed now.
- **No accounts or passwords**: anyone with a room code can join. Codes are
  6 characters from an unambiguous alphabet — fine for private games, not for
  secrets.
- **No anti-cheat beyond validation**: the server validates every move, so a
  modified client can't play illegal tiles — but it *could* reveal hidden info
  to its user (opponents' hands are never sent, so there's little to steal).
- **AI is decent, not brilliant**: it dumps high pips, keeps doubles, and
  plays toward the end it holds most of. It will not bluff or count tiles.
- The client needs a modern phone browser with WebSocket support (all of them
  have it). Sound/vibration effects from the single-player game were not
  ported — easy to add in `app.js` if wanted.
