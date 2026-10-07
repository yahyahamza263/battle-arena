// BATTLE ARENA multiplayer server — free-tier friendly (Render / any Node host)
// Rooms with codes, 15Hz state relay, server-authoritative HP, server bots, server zone.
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
app.get('/health', (req, res) => res.send('ok'));
app.get('/', (req, res) => res.send('Battle Arena MP server'));
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const PORT = process.env.PORT || 3000;

const TICK = 1000 / 15;
const MAP_HALF = 50;
const BOT_COUNT = 3;
const BOT_NAMES = ['Rafi', 'Sakib', 'Nabil', 'Fahim', 'Tanvir', 'Arif'];
const ZONE_PHASES = [
  { wait: 20, shrink: 25, r: 38 },
  { wait: 15, shrink: 20, r: 26 },
  { wait: 12, shrink: 18, r: 15 },
  { wait: 10, shrink: 15, r: 6 },
];
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const rooms = new Map(); // code -> room
const playerRoom = new Map(); // socketId -> code

function makeCode() {
  let c;
  do { c = Array.from({ length: 6 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join(''); }
  while (rooms.has(c));
  return c;
}
function rand(a, b) { return a + Math.random() * (b - a); }
function dist2(ax, az, bx, bz) { const dx = ax - bx, dz = az - bz; return Math.sqrt(dx * dx + dz * dz); }
function spawnSpots(n) {
  const pts = [], R = 34;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rand(-0.2, 0.2);
    const r = R * rand(0.55, 1);
    pts.push({ x: Math.cos(a) * r, z: Math.sin(a) * r });
  }
  return pts;
}

function newRoom(code, hostSocket, hostName) {
  return {
    code,
    hostId: hostSocket.id,
    state: 'lobby', // lobby | dropping | playing | over
    players: new Map(), // socketId -> p
    bots: [],
    zone: { phase: 0, r: MAP_HALF, t: 0, shrinking: false, active: false },
    dropStart: 0,
    winner: null,
  };
}
function addPlayer(room, socket, name) {
  room.players.set(socket.id, {
    id: socket.id, name: String(name || 'Player').slice(0, 14),
    x: 0, y: 0, z: 0, yaw: 0, pitch: 0, hp: 100, alive: true,
    moving: false, dropping: true, landed: false, kills: 0,
  });
}
function roomPublic(room) {
  return {
    code: room.code, state: room.state, hostId: room.hostId,
    players: [...room.players.values()].map(p => ({ id: p.id, name: p.name, alive: p.alive })),
  };
}
function broadcastRoom(room) {
  io.to(room.code).emit('room-update', roomPublic(room));
}
function aliveHumans(room) { return [...room.players.values()].filter(p => p.alive); }
function aliveBots(room) { return room.bots.filter(b => b.alive); }

function startDrop(room) {
  room.state = 'dropping';
  room.dropStart = Date.now();
  const humans = [...room.players.values()];
  const spots = spawnSpots(humans.length + BOT_COUNT);
  humans.forEach((p, i) => {
    p.x = spots[i].x; p.z = spots[i].z; p.y = 26;
    p.hp = 100; p.alive = true; p.dropping = true; p.landed = false; p.kills = 0;
  });
  room.bots = [];
  for (let i = 0; i < BOT_COUNT; i++) {
    const s = spots[humans.length + i];
    room.bots.push({
      id: 'bot:' + i, name: BOT_NAMES[i % BOT_NAMES.length],
      x: s.x, z: s.z, y: 26, yaw: rand(0, 6.28), hp: 100, alive: true,
      moving: true, dropping: true, shootCd: rand(1, 2.5), tx: s.x, tz: s.z,
    });
  }
  room.zone = { phase: 0, r: MAP_HALF, t: 0, shrinking: false, active: false };
  room.winner = null;
  io.to(room.code).emit('game-start', {
    spawns: humans.map(p => ({ id: p.id, x: p.x, z: p.z })),
    bots: room.bots.map(b => ({ id: b.id, name: b.name, x: b.x, z: b.z })),
  });
  broadcastRoom(room);
}

function endGame(room, winnerName) {
  if (room.state === 'over') return;
  room.state = 'over';
  room.winner = winnerName;
  const standings = [...room.players.values()]
    .map(p => ({ name: p.name, kills: p.kills, alive: p.alive }))
    .sort((a, b) => (b.alive - a.alive) || (b.kills - a.kills));
  io.to(room.code).emit('game-over', { winner: winnerName, standings });
}

function checkWin(room) {
  if (room.state !== 'playing') return;
  const h = aliveHumans(room);
  const b = aliveBots(room);
  if (h.length === 0) endGame(room, 'Nobody'); // everyone died (zone/bots)
  else if (h.length === 1 && b.length === 0) endGame(room, h[0].name); // last human standing
}

// ---- per-tick: bots + zone ----
function tickRoom(room) {
  if (room.state === 'dropping') {
    // bots fall fast (no parachute steering on server)
    for (const b of room.bots) {
      if (!b.alive || !b.dropping) continue;
      b.y -= 14 * (TICK / 1000);
      if (b.y <= 0) { b.y = 0; b.dropping = false; }
    }
    const allLanded = [...room.players.values()].every(p => !p.alive || p.landed);
    if (allLanded || Date.now() - room.dropStart > 30000) {
      room.state = 'playing';
      room.zone.active = true;
      room.zone.t = ZONE_PHASES[0].wait;
      io.to(room.code).emit('zone-start', {});
    }
    return;
  }
  if (room.state !== 'playing') return;

  // zone
  const z = room.zone;
  if (z.active && z.phase < ZONE_PHASES.length) {
    const ph = ZONE_PHASES[z.phase];
    z.t -= TICK / 1000;
    if (z.t <= 0) {
      if (!z.shrinking) { z.shrinking = true; z.t = ph.shrink; z.fromR = z.r; }
      else {
        z.phase++; z.shrinking = false;
        if (z.phase < ZONE_PHASES.length) z.t = ZONE_PHASES[z.phase].wait;
        else { z.active = false; z.r = 0; }
      }
    }
    if (z.shrinking) {
      const ph2 = ZONE_PHASES[z.phase];
      const k = Math.max(0, z.t / ph2.shrink);
      z.r = ph2.r + (z.fromR - ph2.r) * k;
    }
    // zone damage to humans (2%/1s tick-ish at 15Hz: 8dps)
    for (const p of room.players.values()) {
      if (!p.alive) continue;
      if (dist2(p.x, p.z, 0, 0) > z.r) {
        p.hp -= 8 * (TICK / 1000);
        if (p.hp <= 0) { p.hp = 0; p.alive = false; killFeed(room, p.name, '⚡ Zone'); checkWin(room); }
      }
    }
    // zone damage to bots
    for (const b of room.bots) {
      if (!b.alive) continue;
      if (dist2(b.x, b.z, 0, 0) > z.r) { b.hp -= 8 * (TICK / 1000); if (b.hp <= 0) { b.hp = 0; b.alive = false; } }
    }
  }

  // bots
  for (const b of room.bots) {
    if (!b.alive || b.dropping) continue;
    const humans = aliveHumans(room);
    if (!humans.length) continue;
    let tgt = humans[0], bd = 1e9;
    for (const h of humans) { const d = dist2(b.x, b.z, h.x, h.z); if (d < bd) { bd = d; tgt = h; } }
    const inZone = dist2(b.x, b.z, 0, 0) <= z.r;
    let mx = 0, mz = 0;
    if (!inZone) { mx = -b.x; mz = -b.z; }
    else if (bd > 20) { mx = tgt.x - b.x; mz = tgt.z - b.z; }
    else if (bd < 8) { mx = b.x - tgt.x; mz = b.z - tgt.z; }
    else { // strafe
      const a = Math.atan2(tgt.x - b.x, tgt.z - b.z) + Math.PI / 2;
      mx = Math.sin(a) * (b.strafeDir || 1); mz = Math.cos(a) * (b.strafeDir || 1);
      if (Math.random() < 0.01) b.strafeDir = -(b.strafeDir || 1);
    }
    const ml = Math.hypot(mx, mz);
    if (ml > 0.01) {
      const sp = 5 * (TICK / 1000);
      b.x += mx / ml * sp; b.z += mz / ml * sp;
      b.x = Math.max(-MAP_HALF, Math.min(MAP_HALF, b.x));
      b.z = Math.max(-MAP_HALF, Math.min(MAP_HALF, b.z));
      b.yaw = Math.atan2(tgt.x - b.x, tgt.z - b.z);
      b.moving = true;
    } else b.moving = false;
    // shoot
    b.shootCd -= TICK / 1000;
    if (b.shootCd <= 0 && bd < 38 && inZone) {
      b.shootCd = rand(1.4, 2.6);
      const hit = Math.random() < 0.42;
      const from = { x: b.x, y: 1.5, z: b.z };
      const to = hit
        ? { x: tgt.x, y: 1.2, z: tgt.z }
        : { x: tgt.x + rand(-2.5, 2.5), y: rand(0.5, 2.5), z: tgt.z + rand(-2.5, 2.5) };
      io.to(room.code).emit('tracer', { id: b.id, from, to, bot: true });
      if (hit) {
        const dmg = Math.round(rand(7, 13));
        tgt.hp -= dmg;
        io.to(room.code).emit('hit', { targetId: tgt.id, hp: Math.max(0, Math.round(tgt.hp)), attacker: b.name, damage: dmg, bot: true });
        if (tgt.hp <= 0) { tgt.hp = 0; tgt.alive = false; killFeed(room, tgt.name, b.name); checkWin(room); }
      }
    }
  }
}

function killFeed(room, victim, killer) {
  io.to(room.code).emit('kill', { victim, killer, alive: aliveHumans(room).length + aliveBots(room).length });
}

function snapshot(room) {
  return {
    players: [...room.players.values()].map(p => ({
      id: p.id, x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2),
      yaw: +p.yaw.toFixed(2), pitch: +p.pitch.toFixed(2),
      hp: Math.max(0, Math.round(p.hp)), alive: p.alive, moving: p.moving, dropping: p.dropping,
    })),
    bots: room.bots.map(b => ({
      id: b.id, x: +b.x.toFixed(2), y: +b.y.toFixed(2), z: +b.z.toFixed(2),
      yaw: +b.yaw.toFixed(2), hp: Math.max(0, Math.round(b.hp)), alive: b.alive,
      moving: b.moving, dropping: b.dropping,
    })),
    zone: { phase: room.zone.phase, r: +room.zone.r.toFixed(1), t: Math.max(0, Math.ceil(room.zone.t)), shrinking: room.zone.shrinking, active: room.zone.active },
    state: room.state,
  };
}

// ---- socket handlers ----
io.on('connection', (socket) => {
  socket.on('create-room', ({ name }) => {
    const code = makeCode();
    const room = newRoom(code, socket, name);
    rooms.set(code, room);
    addPlayer(room, socket, name);
    socket.join(code);
    playerRoom.set(socket.id, code);
    socket.emit('room-created', { code, ...(roomPublic(room)) });
    broadcastRoom(room);
  });

  socket.on('join-room', ({ code, name }) => {
    code = String(code || '').toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) return socket.emit('room-error', { msg: 'Room not found!' });
    if (room.state !== 'lobby') return socket.emit('room-error', { msg: 'Match already started!' });
    if (room.players.size >= 6) return socket.emit('room-error', { msg: 'Room is full!' });
    addPlayer(room, socket, name);
    socket.join(code);
    playerRoom.set(socket.id, code);
    socket.emit('room-joined', { code, ...(roomPublic(room)) });
    broadcastRoom(room);
  });

  socket.on('start-game', () => {
    const room = rooms.get(playerRoom.get(socket.id));
    if (!room || (room.state !== 'lobby' && room.state !== 'over')) return;
    if (socket.id !== room.hostId) return socket.emit('room-error', { msg: 'Only host can start!' });
    if (room.players.size < 1) return;
    startDrop(room);
  });

  socket.on('leave-room', () => leaveRoom(socket));

  socket.on('player-state', (s) => {
    const room = rooms.get(playerRoom.get(socket.id));
    if (!room) return;
    const p = room.players.get(socket.id);
    if (!p || !p.alive) return;
    p.x = +s.x || 0; p.y = +s.y || 0; p.z = +s.z || 0;
    p.yaw = +s.yaw || 0; p.pitch = +s.pitch || 0;
    p.moving = !!s.moving; p.dropping = !!s.dropping;
    if (s.landed) p.landed = true;
  });

  socket.on('fire', (f) => {
    const room = rooms.get(playerRoom.get(socket.id));
    if (!room || room.state !== 'playing') return;
    const p = room.players.get(socket.id);
    if (!p || !p.alive) return;
    // broadcast tracer to everyone else; shooter renders their own locally
    socket.to(room.code).emit('tracer', { id: p.id, from: f.from, to: f.to });
  });

  socket.on('hit-claim', ({ targetId, damage }) => {
    const room = rooms.get(playerRoom.get(socket.id));
    if (!room || room.state !== 'playing') return;
    const attacker = room.players.get(socket.id);
    if (!attacker || !attacker.alive) return;
    const dmg = Math.min(40, Math.max(1, +damage || 20));
    let target = null, isBot = String(targetId).startsWith('bot:');
    if (isBot) target = room.bots.find(b => b.id === targetId);
    else target = room.players.get(targetId);
    if (!target || !target.alive) return;
    if (dist2(attacker.x, attacker.z, target.x, target.z) > 65) return; // sanity
    target.hp -= dmg;
    io.to(room.code).emit('hit', {
      targetId, hp: Math.max(0, Math.round(target.hp)),
      attacker: attacker.name, damage: dmg,
    });
    if (target.hp <= 0) {
      target.hp = 0; target.alive = false;
      attacker.kills++;
      killFeed(room, target.name, attacker.name);
      checkWin(room);
    }
  });

  socket.on('disconnect', () => leaveRoom(socket));
});

function leaveRoom(socket) {
  const code = playerRoom.get(socket.id);
  playerRoom.delete(socket.id);
  if (!code) return;
  const room = rooms.get(code);
  if (!room) return;
  const wasHost = socket.id === room.hostId;
  room.players.delete(socket.id);
  socket.leave(code);
  if (room.players.size === 0) { rooms.delete(code); return; }
  if (wasHost) {
    // migrate host to oldest remaining player
    room.hostId = [...room.players.keys()][0];
    if (room.state === 'lobby') broadcastRoom(room);
    else {
      // mark leaver dead if mid-match
      io.to(code).emit('room-update', roomPublic(room));
    }
  } else broadcastRoom(room);
}

// ---- main loops ----
setInterval(() => {
  for (const room of rooms.values()) {
    try {
      tickRoom(room);
      if (room.state === 'dropping' || room.state === 'playing') {
        io.to(room.code).emit('snapshot', snapshot(room));
      }
    } catch (e) { console.error('tick err', e.message); }
  }
}, TICK);

server.listen(PORT, () => console.log('Battle Arena MP on :' + PORT));
