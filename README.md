# Buildup.io

A browser-based world-cities property trading board game with a glass UI, procedural boards, auctions, trades, and 3D dice.

## Stack

Vite + Express + WebSocket. DOM/CSS board, SVG flags, 3D dice.

## Multiplayer sync & anti-cheat

- Dice are rolled on the server (`roll_request` → `dice_roll` broadcast to everyone at once).
- Every client state update is checked by `server/stateGuard.js` before it is relayed:
  only seated players, no forged money / eliminations / kicks / turn steals, dice must match the server roll.
- Optimistic concurrency (`baseSeq`): a write based on an outdated state is rejected and the
  sender is resynced, so games can no longer roll back.
- No artificial delays: state is relayed immediately (was ~200ms of batching).
- WebSocket auth token is sent in the first frame, not the URL. Auto-reconnect with backoff + heartbeat.
- Set `DATA_DIR` (e.g. a Fly volume, see `fly.toml`) to persist rooms and profiles across restarts.
