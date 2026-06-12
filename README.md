# Buildup.io

A browser-based world-cities property trading board game with a glass UI, procedural boards, auctions, trades, and 3D dice.

## Stack

**TypeScript/JavaScript + Vite** is the right fit for this kind of game: modular code, fast dev reload, no heavy framework overhead. The board is DOM/CSS; dice use **Three.js**. Flags are **SVG circle flags** (crisp at any size). If the game grows into heavy animation or sprites, **Phaser** or **PixiJS** are the next step — not needed yet.

## Run locally

Terminal 1 — API + WebSocket:

```bash
npm install
npm run dev:server
```

Terminal 2 — frontend (proxies `/api` and `/ws`):

```bash
npm run dev
```

Open `http://localhost:5173`.

Production (single process serves UI + API):

```bash
npm run build
JWT_SECRET=your-long-random-secret npm start
```

Open `http://localhost:3001`.

## Do you need a database?

**No, not for launch.** Rooms, lobby state, and profiles are kept **in memory** on the server. That is enough for free hosting and moderate traffic on a **single** server.

Add a database later when you need:

- Profiles, coins, and stats that survive server restarts
- Store purchases and inventory
- More than one server instance (horizontal scaling)

Good options later: **Redis** (rooms + pub/sub) or **PostgreSQL** (profiles + store).

## Deploy free (Render)

1. Push this repo to GitHub.
2. [Render](https://render.com) → **New** → **Blueprint** → connect the repo (`render.yaml` is included).
3. Render auto-sets `JWT_SECRET`. Optional: add `VITE_GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_ID` (same Google OAuth client ID).
4. After deploy, open your `*.onrender.com` URL. Add that URL under **Authorized JavaScript origins** in [Google Cloud Console](https://console.cloud.google.com/) if using Google sign-in.

**Free tier notes:** The service sleeps after ~15 minutes idle (cold start ~30s). WebSockets and multiplayer lobby work on Render’s free web service.

Docker (optional):

```bash
docker build -t buildup-io .
docker run -p 3001:3001 -e JWT_SECRET=your-secret buildup-io
```

## Project layout

```
index.html              # App shell (lobby, HUD, modals)
src/
  main.js               # Entry — loads CSS + game engine
  styles/main.css       # All styles
  game/engine.js        # Board generator, rules, turn flow, UI wiring
  data/countries.js     # Country/city pool with ISO codes for flags
  lib/flags.js          # SVG circle flag helpers
  lib/format.js         # fmt, shuffle, DOM helpers
  ui/tiles.js           # Tile card HTML builder
  ui/dice.js            # Three.js dice renderer
```

## Game notes

- **Board sizes:** 40–72 tiles (`genBoard(per)` where `per` = tiles per side, 10–18).
- **Countries:** Each city group maps to a country; flags use ISO codes (`br`, `us`, `jp`, …).
- **Tile colors:** Neutral by default; only the tile a player is standing on gets their color (`.landed`).
- **Rules toggles:** Set in the lobby — auction, trades, mortgage, vacation pot, etc.

## Ideas to build next

- TypeScript migration for safer refactors
- Sounds (dice, cash register)
- Save/load via localStorage
- Online multiplayer (WebSocket / WebRTC)

## Note on naming

The lobby title field is local only. "Monopoly" is a Hasbro trademark; this project uses its own name.
