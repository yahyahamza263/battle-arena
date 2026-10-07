# BATTLE ARENA

3D battle-royale mobile game (offline bot mode + online multiplayer with friends).

## Project layout

- `game/` — web game source (three.js). Open `game/index.html` to play in a browser.
- `server/` — multiplayer server (Node.js + Socket.IO). Deploy to Render free tier.
- `app/` — Android WebView wrapper. Run `app/build.sh` to build the APK.

## Multiplayer server

```bash
cd server
npm install
npm start   # listens on PORT (default 3000)
```

Render settings: **Root Directory** `server`, build command `npm install`,
start command `npm start`, free plan.

Protocol: rooms with 6-letter codes, 15Hz state relay, server-authoritative
HP, 3 server-side bots, server-side shrinking zone, last-human-standing wins.
