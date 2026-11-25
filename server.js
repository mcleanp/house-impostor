/*
 * House Impostor - live-action Among Us inside your house.
 * Zero npm dependencies: HTTP static hosting + minimal RFC6455 WebSocket +
 * the authoritative game engine. Deploy = upload folder, `node server.js`.
 *
 * Positioning model (no GPS indoors):
 *   - the house is a graph of rooms + floors; players may only move to an
 *     adjacent room (doors), so the hallway/stairs matter;
 *   - a phone reports its room by tapping (works on every browser), and/or
 *     BLE beacons (ESP32 boards) measure the phone's signal and POST it to
 *     /api/beacon - the server then decides the room, so tapping cannot lie;
 *   - floors come from the room table, never from the phone.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 8322;
const PUBLIC = path.join(__dirname, 'public');
const HOUSE_FILE = process.env.HOUSE_FILE || path.join(__dirname, 'house.json');
const BEACON_KEY = process.env.BEACON_KEY || 'house';
const ADMIN_KEY = process.env.ADMIN_KEY || 'house';   // for /api/rooms (admin page)

const RULES = {
  MIN_PLAYERS: 3,
  IMPOSTOR_TWO_AT: 7,       // second impostor from this many players
  TASKS_PER_PLAYER: 4,
  TASK_HOLD_S: 5,           // press-and-hold on the task button, in the right room
  TASK_HOLD_LONG_S: 12,     // the same, for a task marked "long"
  TASKS_ON_LANDINGS: false, // landings are corridors: chores belong in rooms
  MOVE_COOLDOWN_S: 3,       // per door-traversal; stops teleport-cheese
  KILL_COOLDOWN_S: 45,
  POST_MEETING_COOLDOWN_S: 20,
  MEETING_S: 60,            // default; the host can change it in Setup (house.settings)
  RSSI_FLOOR: -92,          // dBm: weaker than this proves nothing
  RSSI_MARGIN: 5,           // winner must beat 2nd-best beacon by this much
  BEACON_STALE_S: 6,        // beacon report older than this is ignored
  ROOM_CLEAR_S: 25,         // hold a beacon-set room this long after evidence stops
                            // (must exceed the client's 12 s scan watchdog + restart)
};

/* ------------------------------------------------------------------ *
 * Minimal WebSocket server (RFC6455) - same code as the outdoor build,
 * proven against real phones through Cloudflare.
 * ------------------------------------------------------------------ */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

class Conn {
  constructor(socket) {
    this.socket = socket;
    this.alive = true;
    this.buf = Buffer.alloc(0);
    this.frags = [];
    this.fragOp = 0;
    this.onmessage = null;
    this.onclose = null;
    socket.on('data', (d) => this._onData(d));
    // The browser/web client sends a FIN, not an RST. Node sockets are
    // half-open by default, so without this the close never fires: a player
    // who shut the tab looked connected forever (and the player row lingered).
    socket.on('end', () => { try { socket.end(); } catch {} });
    socket.on('close', () => this._dead());
    socket.on('error', () => this._dead());
  }
  _dead() {
    if (!this.alive) return;
    this.alive = false;
    if (this.onclose) this.onclose();
  }
  send(obj) {
    if (!this.alive) return;
    const payload = Buffer.from(JSON.stringify(obj), 'utf8');
    let header;
    if (payload.length < 126) {
      header = Buffer.from([0x81, payload.length]);
    } else if (payload.length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81; header[1] = 126; header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    try { this.socket.write(Buffer.concat([header, payload])); }
    catch { this._dead(); }
  }
  close() {
    try { this.socket.write(Buffer.from([0x88, 0x00])); } catch {}
    try { this.socket.end(); } catch {}
    this._dead();
  }
  _onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0;
      const op = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (b.length < off + 2) return;
        len = b.readUInt16BE(off); off += 2;
      } else if (len === 127) {
        if (b.length < off + 8) return;
        const big = b.readBigUInt64BE(off);
        if (big > 0x7fffffffn) { this.close(); return; }
        len = Number(big); off += 8;
      }
      let mask = null;
      if (masked) {
        if (b.length < off + 4) return;
        mask = b.subarray(off, off + 4); off += 4;
      }
      if (b.length < off + len) return;
      let payload = b.subarray(off, off + len);
      this.buf = b.subarray(off + len);
      if (mask) {
        const u = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i++) u[i] = payload[i] ^ mask[i & 3];
        payload = u;
      }
      if (op === 0x8) { this.close(); return; }
      if (op === 0x9) {
        const pl = payload;
        const h = Buffer.from([0x8a, pl.length]);
        try { this.socket.write(Buffer.concat([h, pl])); } catch {}
        continue;
      }
      if (op === 0xa) continue;
      if (op === 0x1 || op === 0x2 || op === 0x0) {
        if (op !== 0x0) { this.fragOp = op; this.frags = []; }
        this.frags.push(Buffer.from(payload));
        if (!fin) continue;
        const msg = Buffer.concat(this.frags).toString('utf8');
        this.frags = [];
        if (this.onmessage && msg.length) {
          try { this.onmessage(msg); } catch (e) { console.error('msg error', e.message); }
        }
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * House model - rooms, floors, doors, levels, task templates.
 * house.json is the single source; the setup screen can edit it and the
 * server writes it back.
 * ------------------------------------------------------------------ */
function loadHouse() {
  let h = null;
  try { h = JSON.parse(fs.readFileSync(HOUSE_FILE, 'utf8')); }
  catch (e) { console.error('house.json unreadable (' + e.message + '), using builtin'); }
  if (!h || !Array.isArray(h.rooms) || !h.rooms.length) h = BUILTIN_HOUSE;
  return normaliseHouse(h);
}

const BUILTIN_HOUSE = {
  floors: [
    { id: 'f2', name: 'Top floor' },
    { id: 'f1', name: 'First floor' },
    { id: 'f0', name: 'Basement' },
  ],
  rooms: [
    { id: 'bed1', floor: 'f2', name: 'Bedroom 1' },
    { id: 'bed2', floor: 'f2', name: 'Bedroom 2' },
    { id: 'bath', floor: 'f2', name: 'Bathroom' },
    { id: 'land2', floor: 'f2', name: 'Top landing' },
    { id: 'down', floor: 'f1', name: 'Downstairs (open plan)' },
    { id: 'land1', floor: 'f1', name: 'Stair landing' },
    { id: 'base1', floor: 'f0', name: 'Basement room 1' },
    { id: 'base2', floor: 'f0', name: 'Basement room 2' },
    { id: 'land0', floor: 'f0', name: 'Basement landing' },
  ],
  edges: [
    ['bed1', 'land2'], ['bed2', 'land2'], ['bath', 'land2'],
    ['land2', 'land1'], ['land1', 'down'], ['land1', 'land0'],
    ['base1', 'land0'], ['base2', 'land0'],
  ],
  levels: [
    { id: 'top', name: 'Top floor showdown', floors: ['f2'] },
    { id: 'downstairs', name: 'Downstairs only', floors: ['f1'] },
    { id: 'basement', name: 'Basement crawl', floors: ['f0'] },
    { id: 'house', name: 'Whole house', floors: ['f2', 'f1', 'f0'] },
  ],
  tasks: [
    { room: 'bed1', name: 'Fluff every pillow in this room' },
    { room: 'bed1', name: 'Fold one item of clothing and put it away' },
    { room: 'bed2', name: 'Make one bed properly' },
    { room: 'bed2', name: 'Line up the shoes by the door of this room' },
    { room: 'bath', name: 'Wipe one patch of the mirror' },
    { room: 'bath', name: 'Fold a towel into thirds and stack it' },
    { room: 'down', name: 'Load one dish into the dishwasher' },
    { room: 'down', name: 'Wipe one section of the table' },
    { room: 'down', name: 'Put the TV remote back on its spot' },
    { room: 'down', name: 'Turn off one lamp that is on (or switch one on)' },
    { room: 'land2', name: 'Carry one thing that does not belong back upstairs' },
    { room: 'land1', name: 'Pick up one item from the stairs and return it' },
    { room: 'land0', name: 'Bring one thing from the basement up to the landing' },
    { room: 'base1', name: 'Stack anything stackable in this room' },
    { room: 'base2', name: 'Find one labelled item and put it where it belongs' },
  ],
  beacons: [],   // filled by the setup screen: {room:'bed1', seen:bool}
};

function normaliseHouse(h) {
  h.floors = (h.floors || []).filter((f) => f && f.id);
  h.rooms = (h.rooms || []).filter((r) => r && r.id && r.floor);
  h.edges = (h.edges || []).filter((e) => Array.isArray(e) && e.length === 2);
  h.levels = (h.levels || []).filter((l) => l && l.id);
  h.tasks = (h.tasks || []).filter((t) => t && t.name && t.room);
  h.beacons = (h.beacons || []).filter((b) => b && b.room);
  // Host settings that survive a save. Bounded here so a hand-edited file
  // cannot set a silly meeting length.
  const ms = Math.round(Number((h.settings || {}).meetingS));
  const em = Math.round(Number((h.settings || {}).emergencyPerCrew));
  h.settings = {
    meetingS: Number.isFinite(ms) ? Math.min(300, Math.max(15, ms)) : RULES.MEETING_S,
    emergencyPerCrew: Number.isFinite(em) ? Math.min(5, Math.max(0, em)) : 1,
  };
  // The lobby is the "out" area: dead players walk there. Not part of the
  // movement graph, never a task room, always present.
  if (!h.rooms.find((r) => r.id === 'lobby')) {
    h.floors.unshift({ id: 'out', name: 'Out' });
    h.rooms.unshift({ id: 'lobby', floor: 'out', name: 'Lobby (you are out)', lobby: true });
  }
  // Integrity: after add/remove in the editor, nothing may reference a room
  // or floor that no longer exists, and no door may appear twice.
  const fids = new Set(h.floors.map((f) => f.id));
  const seenIds = new Set();
  h.rooms = h.rooms.filter((r) => (fids.has(r.floor) || r.floor === 'out') && !seenIds.has(r.id) && seenIds.add(r.id));
  const ids = new Set(h.rooms.map((r) => r.id));
  const seenDoors = new Set();
  h.edges = h.edges.filter(([a, b]) => {
    if (a === b || !ids.has(a) || !ids.has(b)) return false;
    const k = [a, b].sort().join('|');
    if (seenDoors.has(k)) return false;
    seenDoors.add(k); return true;
  });
  h.tasks = h.tasks.filter((t) => ids.has(t.room));
  for (const l of h.levels) l.floors = (l.floors || []).filter((f) => fids.has(f));
  h.levels = h.levels.filter((l) => l.floors.length);
  return h;
}

let HOUSE = loadHouse();
function saveHouse() {
  try { fs.writeFileSync(HOUSE_FILE, JSON.stringify(HOUSE, null, 2)); return true; }
  catch (e) { console.error('house.json save failed: ' + e.message); return false; }
}

const roomById = (id) => HOUSE.rooms.find((r) => r.id === id) || null;
const floorById = (id) => HOUSE.floors.find((f) => f.id === id) || null;
function neighbours(id) {
  const out = [];
  for (const [a, b] of HOUSE.edges) {
    if (a === id) out.push(b);
    else if (b === id) out.push(a);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Beacon RSSI pipeline. ESP32 boards POST here every couple of seconds:
 *   {beacon:"bed1", peers:[{p:"<player id>", r:-63}, ...]}
 * The server keeps the last sighting per player per beacon and decides the
 * room itself: strongest beacon wins, but only if it clears the floor and
 * beats the runner-up by RSSI_MARGIN (so a bedroom one floor up cannot steal
 * the call). Cal offsets are per room in house.json (cal: dBm at 1 m).
 * ------------------------------------------------------------------ */
const sightings = new Map();   // playerId -> Map(beaconRoom -> {r, ts})

function ingestBeacon(body) {
  const b = String(body.beacon || '').slice(0, 24);
  if (!roomById(b)) { console.log('beacon ' + b + ' -> UNKNOWN'); return 'unknown beacon room'; }
  console.log('beacon ' + b + ' peers=' + (Array.isArray(body.peers) ? body.peers.length : 0));
  const now = Date.now();
  for (const peer of (Array.isArray(body.peers) ? body.peers : []).slice(0, 40)) {
    const p = String(peer.p || '').slice(0, 24);
    const r = Math.round(Number(peer.r));
    if (!p || !Number.isFinite(r) || r > -20 || r < -120) continue;
    let m = sightings.get(p);
    if (!m) { m = new Map(); sightings.set(p, m); }
    m.set(b, { r, ts: now });
  }
  return 'ok';
}

/** Best room for a player from RSSI, or null when the evidence is weak.
 *  Pass stickTo (the room they are already in) for hysteresis: two beacons a few
 *  feet apart give near-equal RSSI, so without it the answer flips to null (or to
 *  the other room) on every jitter. With it, you stay put until another room
 *  clearly beats the one you are in by RSSI_MARGIN. */
function resolveRoom(playerId, stickTo) {
  const m = sightings.get(playerId);
  if (!m) return null;
  const now = Date.now();
  const rows = [];
  let held = null;   // the room we are already in, even if its sighting has aged out
  for (const [room, s] of m) {
    const rm = roomById(room);
    if (!rm || rm.lobby) continue;
    const age = now - s.ts;
    if (age > RULES.ROOM_CLEAR_S * 1000) continue;   // long gone: forget it
    if (room === stickTo) held = { room, r: s.r + (rm.cal || 0), age };
    if (age > RULES.BEACON_STALE_S * 1000) continue; // stale: cannot win, can still hold
    rows.push({ room, r: s.r + (rm.cal || 0) });
  }
  rows.sort((a, b) => b.r - a.r);
  // Nothing fresh at all: hold the room we are in until the clear window expires.
  if (!rows.length) return held ? held.room : null;
  if (rows[0].r < RULES.RSSI_FLOOR) return null;
  // Hysteresis works off `held`, not `rows`: when the current room's own sighting
  // has just aged out it is no longer a candidate, but it must not lose by default.
  if (held) {
    const cur = rows.find((x) => x.room === held.room);
    if (!cur) {
      // Only a stale sighting of our room: stay until someone clears the floor.
      if (rows[0].r - held.r < RULES.RSSI_MARGIN) return held.room;
    } else if (rows[0].room !== held.room && rows[0].r - cur.r < RULES.RSSI_MARGIN) {
      return held.room;   // stay put
    }
  }
  if (rows.length > 1 && rows[0].r - rows[1].r < RULES.RSSI_MARGIN) return null;
  return rows[0].room;
}

/* A phone reporting the beacons IT can see (scan mode, no pairing):
 *   {p:"<playerId>", seen:[{b:"HB-bed2", r:-60}, ...]}
 * Same sightings map as the beacons use, so resolveRoom() treats a phone's own
 * scan exactly like a board's measurement - the server still decides the room. */
function ingestPhoneScan(body) {
  const p = String(body.p || '').slice(0, 24);
  if (!p) return 'no player';
  const now = Date.now();
  let m = sightings.get(p);
  if (!m) { m = new Map(); sightings.set(p, m); }
  let n = 0;
  for (const s of (Array.isArray(body.seen) ? body.seen : []).slice(0, 40)) {
    const b = String(s.b || '').replace(/^HB-/, '').slice(0, 24);
    const r = Math.round(Number(s.r));
    if (!b || !roomById(b) || !Number.isFinite(r) || r > -20 || r < -120) continue;
    m.set(b, { r, ts: now });
    n++;
  }
  const detail = [...m.entries()].map(([k, v]) => k + '=' + v.r).join(' ');
  console.log('phone ' + p + ' scan -> ' + n + ' beacon(s)  ' + detail);
  return 'ok';
}

/* RSSI moved someone's room? Re-resolve every live player and push. Shared by
 * the beacon POST and the phone-scan POST. */
function reresolveLive() {
  for (const room of rooms.values()) {
    let dirty = false;
    for (const pl of room.players.values()) {
      if (!pl.joined || pl.director || !pl.alive) continue;
      // 'over' too: the role-reveal screen is where everyone stands around
      // reading who was the impostor, and their rooms must still track.
      if (room.state === 'meeting') continue;
      const best = resolveRoom(pl.id, pl.roomSource === 'beacon' ? pl.room : null);
      if (best) pl.lastGoodAt = Date.now();   // fresh evidence: reset the grace clock
      if (best && best !== pl.room) {
        pl.room = best; pl.roomSource = 'beacon'; pl.movedAt = Date.now();
        dirty = true;
      } else if (!best && pl.roomSource === 'beacon' && pl.room
                 && Date.now() - (pl.lastGoodAt || 0) > RULES.ROOM_CLEAR_S * 1000) {
        // Evidence went stale (walked out of range / scan went quiet): clear the
        // beacon-set room instead of freezing on the last one. A manual move
        // (roomSource 'join'/'move') is left alone. Grace period: the phone scan
        // drops out for a window or two under iOS throttling - without it the room
        // label flickers off and back on while standing still.
        pl.room = null; pl.roomSource = null; dirty = true;
      }
      if (room.state === 'playing' && pl.alive && bodyFound(room, pl)) { dirty = true; break; }
    }
    // checkWin ends the round when no impostors are alive; in the lobby it
    // would wrongly flip the game to 'over', so only run it mid-round.
    if (dirty) { broadcastState(room); if (room.state === 'playing') checkWin(room); }
  }
}

/* ------------------------------------------------------------------ *
 * Game state
 * ------------------------------------------------------------------ */
const rooms = new Map();
let lastAutoRoom = null, lastAutoRoomAt = 0;   // see /api/current

function newCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += A[Math.floor(Math.random() * A.length)];
    if (!rooms.has(c)) return c;
  }
}

function makeRoom(code) {
  const room = {
    code, players: new Map(), order: [], hostId: null,
    state: 'lobby',            // lobby | playing | meeting | over
    levelId: 'house',
    startedAt: 0, killReadyAt: 0, meetingEnds: 0,
    votes: new Map(), emergencyUsed: new Map(), bodies: [],   // bodies: [{room, victimId}]; emergencyUsed: id -> count
    events: [], overSent: false,
  };
  rooms.set(code, room);
  return room;
}

function levelRooms(room) {
  const lvl = HOUSE.levels.find((l) => l.id === room.levelId) || HOUSE.levels[0] || { floors: [] };
  return new Set(HOUSE.rooms.filter((r) => !r.lobby && lvl.floors.includes(r.floor)).map((r) => r.id));
}

function alivePlayers(room) {
  return [...room.players.values()].filter((p) => p.joined && p.alive && !p.director);
}
function crewAlive(room) { return alivePlayers(room).filter((p) => p.role === 'crew'); }
const impostors = (room) => [...room.players.values()].filter((p) => p.role === 'impostor' && p.alive);

function roomEvent(room, ev) {
  room.events.push({ ...ev, ts: Date.now() });
  if (room.events.length > 40) room.events.shift();
}

function assignRoles(room) {
  const players = alivePlayers(room);
  const n = players.length;
  const nImp = n >= RULES.IMPOSTOR_TWO_AT ? 2 : 1;
  const idx = [...players.keys()];
  // Fisher-Yates with a server-side shuffle - the browser never sees roles early.
  for (let i = idx.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  const impSet = new Set(idx.slice(0, nImp).map((i) => players[i].id));
  for (const p of players) p.role = impSet.has(p.id) ? 'impostor' : 'crew';
}

/* Task pool for a level. Landings are corridors, so by default they are
 * skipped - a chore you cannot do without blocking the stairs is not a chore.
 * Set TASKS_ON_LANDINGS to keep them. */
function taskPool(room) {
  const active = levelRooms(room);
  return HOUSE.tasks
    .filter((t) => active.has(t.room) && roomById(t.room))
    .filter((t) => RULES.TASKS_ON_LANDINGS || !roomById(t.room).landing)
    .map((t, i) => ({ ...t, tid: 'T' + i }));
}

function assignTasks(room) {
  let pool = taskPool(room);
  // A level made only of landings would otherwise have no chores at all.
  if (!pool.length) pool = HOUSE.tasks.filter((t) => levelRooms(room).has(t.room) && roomById(t.room)).map((t, i) => ({ ...t, tid: 'T' + i }));
  if (!pool.length) return false;
  // Impostors get chores too, so standing still over a "task" is not a tell.
  // They are assigned exactly like crew; their progress just does not count.
  for (const p of alivePlayers(room)) {
    const pick = [...pool];
    for (let i = pick.length - 1; i > 0; i--) {
      const j = crypto.randomInt(i + 1);
      [pick[i], pick[j]] = [pick[j], pick[i]];
    }
    p.tasks = pick.slice(0, Math.min(RULES.TASKS_PER_PLAYER, pick.length))
      .map((t) => ({
        id: t.tid, name: t.name, room: t.room, game: t.game || 'hold',
        kind: t.kind === 'long' ? 'long' : 'short', done: false,
      }));
    p.hold = null;
  }
  return true;
}

/* How long a task's button must be held. */
const holdSeconds = (task) => (task.kind === 'long' ? RULES.TASK_HOLD_LONG_S : RULES.TASK_HOLD_S);

/* Every task is a mini-game on the phone (like the real game - nothing to do
 * with the furniture). The phone runs the game and reports when it is finished;
 * the server only checks it was opened in the right room and was up long
 * enough that it cannot have been tapped through. */
const GAME_MIN_S = {
  swipe: 3, keys: 4, wires: 4, align: 4, leaves: 4, hexes: 4, keypad: 6,
  asteroids: 8, sample: 6, fuel: 5, upload: 6, scan: 10,
};
const gameMinSeconds = (task) => GAME_MIN_S[task.game] || holdSeconds(task);

function taskProgress(room) {
  const crew = crewAlive(room).concat([...room.players.values()].filter((p) => p.joined && !p.alive && p.role === 'crew'));
  let done = 0, total = 0;
  for (const p of crew) for (const t of (p.tasks || [])) { total++; if (t.done) done++; }
  return total ? done / total : 0;
}

function startGame(room, levelId) {
  // Directors watch, they do not play - count only real seats.
  if (alivePlayers(room).length < RULES.MIN_PLAYERS) return `You need at least ${RULES.MIN_PLAYERS} players (directors do not count).`;
  if (!HOUSE.levels.find((l) => l.id === levelId)) return 'Pick a level first.';
  room.levelId = levelId;
  if (!assignTasks(room)) return 'No tasks are defined for the rooms of that level - add some in Setup.';
  assignRoles(room);
  for (const p of room.players.values()) {
    if (!p.joined || p.director) continue;
    p.alive = true;
    p.room = startRoomFor(room);
    p.roomSource = 'start';
    p.movedAt = 0; p.hold = null; p.reported = false;
  }
  room.state = 'playing';
  room.startedAt = Date.now();
  room.killReadyAt = Date.now() + 15000;
  room.bodies = [];
  room.votes.clear();
  room.emergencyUsed.clear();
  room.overSent = false;
  room.heldWin = false;
  roomEvent(room, { type: 'start', text: `Round started on "${(HOUSE.levels.find((l) => l.id === levelId) || {}).name}". Doors are live.` });
  return null;
}

/** Where the living begin: the landing of the lowest active floor (floors are
 * listed top-down in house.json, so walk that list backwards), else any room. */
function startRoomFor(room) {
  const active = new Set(levelRooms(room));
  for (let i = HOUSE.floors.length - 1; i >= 0; i--) {
    const land = HOUSE.rooms.find((r) => r.floor === HOUSE.floors[i].id && active.has(r.id) && r.id.startsWith('land'));
    if (land) return land.id;
  }
  return [...active][0] || 'lobby';
}

function movePlayer(room, p, to) {
  if (room.state !== 'playing') return 'Not during setup or a meeting.';
  if (!p.alive) return 'You are in the lobby - only ghosts and the living move.';
  const from = p.room;
  if (to === from) return null;
  if (!levelRooms(room).has(to)) return 'That room is not in this level.';
  if (!neighbours(from).includes(to)) return 'There is no door from here to there.';
  const now = Date.now();
  if (now - (p.movedAt || 0) < RULES.MOVE_COOLDOWN_S * 1000) return 'Slow down - use the door like a human.';
  p.room = to; p.roomSource = 'tap'; p.movedAt = now;
  return null;
}

function killPlayer(room, killer, victimId) {
  if (room.state !== 'playing') return null;
  if (killer.role !== 'impostor' || !killer.alive) return null;
  const v = room.players.get(victimId);
  if (!v || !v.joined || !v.alive || v.director || v.role === 'impostor') return null;
  if (v.room !== killer.room) return 'They are not in your room.';
  if (Date.now() < room.killReadyAt) return 'Kill cooldown not ready.';
  v.alive = false; v.room = 'lobby'; v.roomSource = 'dead'; v.hold = null;
  room.killReadyAt = Date.now() + RULES.KILL_COOLDOWN_S * 1000;
  room.bodies.push({ room: killer.room, victimId, ts: Date.now() });
  // Public feed line: who, but NOT where - the room is half the puzzle and the
  // body is found by walking into it. The killer and the victim each get a
  // private note on top of that.
  roomEvent(room, { type: 'kill', text: `${killer.name} killed ${v.name}.` });
  v.conn.send({ t: 'died', by: killer.name, room: room.bodies[room.bodies.length - 1].room });
  killer.conn.send({ t: 'nope', text: `You killed ${v.name} in the ${roomById(killer.room).name}. Walk away.` });
  return null;
}

/* Meeting length: the host's setting if they made one, else the default.
 * Bounded so a typo cannot open a 40-minute meeting. */
/* How many emergency buttons each crew member gets per round. */
function emergencyAllowance() {
  const n = Math.round(Number((HOUSE.settings || {}).emergencyPerCrew));
  return Number.isFinite(n) && n >= 0 && n <= 5 ? n : 1;
}

function meetingSeconds() {
  const n = Math.round(Number((HOUSE.settings || {}).meetingS));
  return Number.isFinite(n) && n >= 15 && n <= 300 ? n : RULES.MEETING_S;
}

function startMeeting(room, reason) {
  room.state = 'meeting';
  room.meetingEnds = Date.now() + meetingSeconds() * 1000;
  room.votes.clear();
  room.killReadyAt = Date.now() + RULES.POST_MEETING_COOLDOWN_S * 1000;
  roomEvent(room, { type: 'meeting', text: reason });
  return true;
}

/* A living crew member is standing in a room with a body: that IS the report,
 * no button. Caller must have checked state/alive. */
function bodyFound(room, p) {
  const body = room.bodies.find((b) => b.room === p.room);
  if (!body) return false;
  const v = room.players.get(body.victimId);
  startMeeting(room, `${v ? v.name : 'A body'} was found dead by ${p.name} in the ${roomById(p.room).name}.`);
  return true;
}

function endMeeting(room) {
  const alive = alivePlayers(room);
  const tally = new Map();
  for (const [voter, target] of room.votes) {
    if (!alive.find((p) => p.id === voter)) continue;
    tally.set(target, (tally.get(target) || 0) + 1);
  }
  let top = null, topN = 0, tie = false;
  for (const [target, n] of tally) {
    if (n > topN) { top = target; topN = n; tie = false; }
    else if (n === topN) tie = true;
  }
  room.bodies = [];
  if (top && top !== 'skip' && !tie && topN * 2 > alive.length) {
    const v = room.players.get(top);
    if (v && v.alive) {
      v.alive = false; v.room = 'lobby'; v.roomSource = 'ejected'; v.hold = null;
      roomEvent(room, { type: 'eject', text: `${v.name} was ejected (${v.role}). ${topN}/${alive.length} voted them out.` });
    }
  } else {
    roomEvent(room, { type: 'eject', text: 'No consensus - nobody was ejected.' });
  }
  room.state = 'playing';
  room.meetingEnds = 0;
  checkWin(room);
}

function checkWin(room) {
  // Lobby is not a round: roles are still unassigned, so every "all impostors
  // found" test below is meaningless there. Leaving the lobby used to flip the
  // room to 'over' with a crew win before a game had ever started.
  if (room.state !== 'playing' && room.state !== 'meeting') return;
  if (room.state === 'over') return;
  if (room.heldWin) return;   // a phone dropped; wait for it to come back
  const alive = alivePlayers(room);
  const imp = alive.filter((p) => p.role === 'impostor');
  const crew = alive.filter((p) => p.role === 'crew');
  let winner = null;
  if (!imp.length) winner = 'crew';
  else if (taskProgress(room) >= 1) winner = 'crew';
  else if (crew.length <= imp.length) winner = 'impostor';
  if (!winner) return;
  room.state = 'over';
  roomEvent(room, { type: 'over', text: `${winner === 'crew' ? 'Crew' : 'Impostors'} win!` + (winner === 'crew' && !imp.length ? ' All impostors found.' : winner === 'crew' ? ' Tasks complete.' : ' Not enough crew left.') });
}

/* ------------------------------------------------------------------ *
 * Snapshots - what one client is allowed to see (fog of war by room).
 * ------------------------------------------------------------------ */
function snapshotFor(room, p) {
  const inPlay = room.state !== 'lobby';
  // Fog of war by room - EXCEPT during a meeting, where everyone is on the
  // same call and must be able to vote for anyone. Without this the ballot was
  // limited to whoever happened to share your room (often nobody).
  // Lobby has no fog either: everyone is milling about waiting, and a player
  // whose beacon has not resolved yet (room null) would otherwise be invisible
  // to the whole room - and see nobody - so the host could never count them.
  const visible = [...room.players.values()].filter((q) => q.joined && !q.director
    && (room.state === 'lobby' || room.state === 'meeting' || p.director || !p.alive || !q.alive
        ? true : q.room === p.room && q.alive));
  const me = p.director ? null : p;
  return {
    t: 'state',
    house: { floors: HOUSE.floors, rooms: HOUSE.rooms, levels: HOUSE.levels, settings: HOUSE.settings },
    level: room.levelId,
    code: room.code, hostId: room.hostId,
    state: room.state,
    now: Date.now(),
    killReadyAt: room.killReadyAt, meetingEnds: room.meetingEnds, meetingS: meetingSeconds(),
    progress: inPlay ? Math.round(taskProgress(room) * 100) : 0,
    events: room.events.slice(-12),
    // `mine` lets the phone show which name it has already voted for. `tally`
    // is only sent once a vote is in, so the count cannot hint at who is who
    // before anyone has voted.
    votes: room.state === 'meeting' ? {
      cast: room.votes.size, of: alivePlayers(room).length, mine: room.votes.get(p.id) || null,
      tally: room.votes.size ? [...room.votes.values()].reduce((m, t) => (m[t] = (m[t] || 0) + 1, m), {}) : null,
    } : null,
    you: p.director ? { director: true } : {
      id: p.id, name: p.name, room: p.room, alive: p.alive,
      role: room.state === 'lobby' ? undefined : p.role,
      tasks: me ? (p.tasks || []) : undefined,
      roomSource: p.roomSource,
      beaconRoom: resolveRoom(p.id),
      moveTo: p.alive ? neighbours(p.room).filter((id) => levelRooms(room).has(id)) : [],
      emergencyLeft: room.state === 'playing' && p.alive
        ? Math.max(0, emergencyAllowance() - (room.emergencyUsed.get(p.id) || 0)) : 0,
    },
    people: visible.map((q) => ({
      id: q.id, name: q.name, room: q.room, color: q.color,
      alive: q.alive,
      role: (p.director || !p.alive) ? q.role : undefined,   // ghosts and director see all roles
    })),
    bodies: (p.director || !p.alive) ? room.bodies
      : room.bodies.filter((b) => b.room === p.room).map((b) => ({ room: b.room, victimId: b.victimId })),
    beacons: p.id === room.hostId ? beaconStatus() : undefined,
  };
}

function beaconStatus() {
  const now = Date.now();
  const seen = new Set();
  for (const m of sightings.values()) for (const [room, s] of m) if (now - s.ts < RULES.BEACON_STALE_S * 3 * 1000) seen.add(room);
  return [...seen].sort();
}

function broadcastState(room, exceptId) {
  for (const p of room.players.values()) {
    if (p.id !== exceptId) p.conn.send(snapshotFor(room, p));
  }
}

/* ------------------------------------------------------------------ *
 * Message handling - clients send intents only; verdicts happen here.
 * ------------------------------------------------------------------ */
function handleMsg(room, p, msg) {
  switch (msg.t) {
    case 'move': {
      const err = movePlayer(room, p, String(msg.room || '').slice(0, 24));
      if (err) p.conn.send({ t: 'nope', text: err });
      else broadcastState(room);
      break;
    }
    case 'taskStart': {
      if (room.state !== 'playing' || !p.alive) return;
      const task = (p.tasks || []).find((x) => x.id === msg.id && !x.done);
      if (!task) return;
      if (task.room !== p.room) { p.conn.send({ t: 'nope', text: `That task is in the ${roomById(task.room).name} - go there first.` }); return; }
      p.hold = { id: task.id, at: Date.now() };
      break;
    }
    case 'taskDone': {
      if (room.state !== 'playing' || !p.alive || !p.hold) return;
      const task = (p.tasks || []).find((x) => x.id === msg.id && !x.done);
      if (!task || p.hold.id !== task.id) return;
      const held = (Date.now() - p.hold.at) / 1000;
      p.hold = null;
      if (task.room !== p.room) { p.conn.send({ t: 'nope', text: 'You left the room - open it again there.' }); return; }
      const need = gameMinSeconds(task);
      if (held + 0.4 < need) { p.conn.send({ t: 'nope', text: `Too quick - give it ${need}s.` }); return; }
      task.done = true;
      // No "(faked?)" tag: the feed is public, and a tag on every impostor task
      // hands their role away the moment they fake one.
      roomEvent(room, { type: 'task', text: `${p.name} completed "${task.name}".` });
      broadcastState(room);
      checkWin(room);
      break;
    }
    case 'kill': {
      const err = killPlayer(room, p, String(msg.victim || '').slice(0, 24));
      if (err) p.conn.send({ t: 'nope', text: err });
      else { broadcastState(room); checkWin(room); }
      break;
    }
    case 'emergency': {
      if (room.state !== 'playing' || !p.alive) return;
      const used = room.emergencyUsed.get(p.id) || 0;
      if (used >= emergencyAllowance()) { p.conn.send({ t: 'nope', text: 'You already used your emergency button.' }); return; }
      room.emergencyUsed.set(p.id, used + 1);
      startMeeting(room, `${p.name} called an emergency meeting.`);
      broadcastState(room);
      break;
    }
    case 'vote': {
      if (room.state !== 'meeting' || !p.alive) return;
      const target = String(msg.target || '').slice(0, 24);
      if (target !== 'skip' && !room.players.has(target)) return;
      room.votes.set(p.id, target);
      p.conn.send({ t: 'voted', target });   // immediate ack, so a tap is never silent
      broadcastState(room);
      if (room.votes.size >= alivePlayers(room).length) { endMeeting(room); broadcastState(room); }
      break;
    }
    case 'host': {
      // Take the host seat - for when the host's phone is not to hand. Lobby
      // only, so a round in progress cannot change hands mid-way.
      if (room.state !== 'lobby') { p.conn.send({ t: 'nope', text: 'You can only take over in the lobby.' }); return; }
      if (p.director) { p.conn.send({ t: 'nope', text: 'A director cannot host - join as a player.' }); return; }
      room.hostId = p.id;
      roomEvent(room, { type: 'host', text: `${p.name} is now the host.` });
      broadcastState(room);
      break;
    }
    case 'start': {
      if (p.id !== room.hostId) { p.conn.send({ t: 'nope', text: 'Only the host starts the round.' }); return; }
      if (room.state !== 'lobby') return;
      const err = startGame(room, String(msg.level || 'house'));
      p.conn.send(err ? { t: 'nope', text: err } : { t: 'ok' });
      broadcastState(room);
      break;
    }
    case 'reset': {
      if (p.id !== room.hostId) return;
      room.state = 'lobby'; room.bodies = []; room.votes.clear();
      for (const q of room.players.values()) { q.alive = true; q.role = undefined; q.tasks = []; q.room = null; }
      roomEvent(room, { type: 'reset', text: 'Back to lobby.' });
      broadcastState(room);
      break;
    }
    case 'houseSave': {
      if (p.id !== room.hostId) { p.conn.send({ t: 'nope', text: 'Only the host edits the house.' }); return; }
      if (room.state !== 'lobby') { p.conn.send({ t: 'nope', text: 'Finish the round before editing the house.' }); return; }
      const h = msg.house;
      if (!h || !Array.isArray(h.rooms) || !h.rooms.length) return;
      HOUSE = normaliseHouse(h);
      saveHouse();
      roomEvent(room, { type: 'house', text: `${p.name} updated the house map.` });
      broadcastState(room);
      break;
    }
    case 'ping': p.conn.send({ t: 'pong', now: Date.now() }); break;
    case 'color': {
      const c = String(msg.color || '');
      if (!/^#[0-9a-fA-F]{6}$/.test(c)) return;
      p.color = c.toUpperCase();
      broadcastState(room);
      break;
    }
  }
}

/* ------------------------------------------------------------------ *
 * HTTP + upgrade plumbing
 * ------------------------------------------------------------------ */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  const parsed = new URL(req.url, 'http://internal');
  const pathname = decodeURIComponent(parsed.pathname);
  res.setHeader('cache-control', 'no-cache');

  if (pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, rooms: rooms.size, players: [...rooms.values()].reduce((s, r) => s + r.players.size, 0), beacons: beaconStatus().length }));
  }
  if (pathname === '/api/rules') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(RULES));
  }
  if (pathname === '/api/house' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(HOUSE));
  }
  if (pathname === '/api/house' && req.method === 'POST') {
    // admin editor: replace the whole house map. Keyed like /api/rooms so a
    // passer-by cannot rewrite the house mid-party. Safe to use while games
    // are running: live rooms keep their own state, they just pick up the new
    // map on the next Start (levelRooms/task pools are read at that point).
    const key = parsed.searchParams.get('key') || req.headers['x-admin-key'] || '';
    if (key !== ADMIN_KEY) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"error":"bad admin key"}'); }
    let n = 0, body = '';
    req.on('data', (c) => { n += c.length; if (n > 262144) req.destroy(); body += c; });
    req.on('end', () => {
      let j = null; try { j = JSON.parse(body); } catch {}
      if (!j || !Array.isArray(j.rooms) || !j.rooms.length) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end('{"error":"need an object with a non-empty rooms array"}');
      }
      if (!j.rooms.some((r) => r && !r.lobby)) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end('{"error":"house needs at least one non-lobby room"}');
      }
      HOUSE = normaliseHouse(j);
      const saved = saveHouse();
      // tell every lobby/over room the map changed so its editor redraws
      for (const room of rooms.values()) {
        if (room.state === 'lobby' || room.state === 'over') {
          roomEvent(room, { type: 'house', text: 'The house map was updated from the admin page.' });
          broadcastState(room);
        }
      }
      res.writeHead(saved ? 200 : 500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ r: saved ? 'ok' : 'save failed', rooms: HOUSE.rooms.length, tasks: HOUSE.tasks.length, edges: HOUSE.edges.length, levels: HOUSE.levels.length }));
    });
    return;
  }
  if (pathname === '/api/current' && req.method === 'GET') {
    // The house is one game at a time, so a player should never type a code.
    // Hand out the live game; if there is none, start one (the first person in
    // becomes host) and hand that out. Cached briefly so a burst of phones
    // joining together cannot race into several rooms.
    const fresh = [...rooms.values()]
      .filter((r) => r.state !== 'over' && [...r.players.values()].some((p) => p.joined && !p.director))
      .sort((a, b) => (a.state === 'lobby' ? 0 : 1) - (b.state === 'lobby' ? 0 : 1))[0];
    let code = fresh && fresh.code;
    if (!code) {
      // Nothing live: a room left over from the last round is the house, so
      // hand that back rather than minting a new code. Otherwise every phone
      // that opens the page after a round lands in a room of its own and the
      // family is split across games that cannot see each other. Only a room
      // nobody has stayed in (no players at all) is skipped, and the 5 s cache
      // still absorbs a burst of phones arriving together.
      const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      const stale = Date.now() - lastAutoRoomAt < 5000 && lastAutoRoom && rooms.get(lastAutoRoom);
      const leftover = [...rooms.values()]
        .filter((r) => [...r.players.values()].some((p) => p.joined && !p.director))
        .sort((a, b) => (b.players.size - a.players.size) || (b.startedAt - a.startedAt))[0];
      if (stale) code = lastAutoRoom;
      else if (leftover) { code = leftover.code; lastAutoRoom = code; lastAutoRoomAt = Date.now(); }
      else {
        do { code = Array.from({ length: 4 }, () => A[crypto.randomInt(A.length)]).join(''); } while (rooms.has(code));
        makeRoom(code);
        lastAutoRoom = code; lastAutoRoomAt = Date.now();
      }
    }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ code }));
  }

  if (pathname === '/api/rooms' && req.method === 'GET') {
    // admin page: every game in progress. Keyed so random passers-by cannot
    // harvest live 4-letter codes and crash the family night.
    const key = parsed.searchParams.get('key') || req.headers['x-admin-key'] || '';
    if (key !== ADMIN_KEY) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"error":"bad admin key"}'); }
    const list = [...rooms.values()].map((r) => ({
      code: r.code,
      state: r.state,
      level: r.levelId,
      players: [...r.players.values()].filter((p) => p.joined && !p.director).length,
      directors: [...r.players.values()].filter((p) => p.joined && p.director).length,
      host: (r.players.get(r.hostId) || {}).name || null,
      startedAt: r.startedAt || 0,
    }));
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ rooms: list, houseRooms: HOUSE.rooms.filter((x) => !x.lobby).length, beacons: beaconStatus().length }));
  }
  // Diagnostic sink: the blescan.html page posts its capability report and log
  // here so we can read what a phone's browser actually supports from the server.
  if (pathname === '/api/diag' && req.method === 'POST') {
    let n = 0, body = '';
    req.on('data', (c) => { n += c.length; if (n > 32768) req.destroy(); body += c; });
    req.on('end', () => {
      console.log('DIAG ' + body.slice(0, 6000));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
    return;
  }
  if (pathname === '/api/beacon' && req.method === 'POST') {
    if ((req.headers['x-beacon-key'] || '') !== BEACON_KEY) { res.writeHead(401); return res.end('key'); }
    let n = 0, body = '';
    req.on('data', (c) => { n += c.length; if (n > 8192) req.destroy(); body += c; });
    req.on('end', () => {
      let j = null; try { j = JSON.parse(body); } catch {}
      const r = j ? ingestBeacon(j) : 'bad json';
      res.writeHead(r === 'ok' ? 200 : 400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ r }));
      reresolveLive();
    });
    return;
  }
  // A phone's own BLE scan: it sees the beacons, the server does the room
  // translation. Same sightings pipeline as /api/beacon, keyed by player id.
  if (pathname === '/api/scan' && req.method === 'POST') {
    if ((req.headers['x-beacon-key'] || '') !== BEACON_KEY) { res.writeHead(401); return res.end('key'); }
    let n = 0, body = '';
    req.on('data', (c) => { n += c.length; if (n > 8192) req.destroy(); body += c; });
    req.on('end', () => {
      let j = null; try { j = JSON.parse(body); } catch {}
      const r = j ? ingestPhoneScan(j) : 'bad json';
      res.writeHead(r === 'ok' ? 200 : 400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ r }));
      if (r === 'ok') reresolveLive();
    });
    return;
  }
  const file = path.join(PUBLIC, path.normalize(pathname === '/' ? '/index.html' : pathname).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end('no'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) return socket.destroy();
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  const head = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    'Sec-WebSocket-Accept: ' + accept,
    '\r\n',
  ].join('\r\n');

  const usp = new URL(req.url, 'http://internal').searchParams;
  const name = String(usp.get('name') || 'player').slice(0, 18).replace(/[^\w \-]/g, '').trim() || 'player';
  const code = String(usp.get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  let room = code ? rooms.get(code) : null;
  if (!room) {
    if (!code) { socket.write(head); const c = new Conn(socket); c.onclose = () => c.close(); return; }
    room = makeRoom(code);
  }
  socket.write(head);
  const conn = new Conn(socket);
  // Reuse the id the client kept (localStorage) so a page refresh rejoins as the
  // SAME player - keeps room, role, tasks, alive state - instead of a new ghost.
  const want = String(usp.get('pid') || '').replace(/[^\w]/g, '').slice(0, 24);
  const id = want || ('p' + crypto.randomBytes(5).toString('hex'));
  const director = usp.get('director') === '1';
  const color = /^#[0-9a-fA-F]{6}$/.test(String(usp.get('color') || '')) ? String(usp.get('color')).toUpperCase() : null;
  const prev = room.players.get(id);
  // Drop the stale socket for this id - but TELL it first. Without the notice
  // the old client just sees a close and reconnects with the same pid, which
  // closes the new socket, which reconnects... a ping-pong every 2 s that also
  // spams the feed with "rejoined".
  if (prev) { try { prev.conn.send({ t: 'bye', reason: 'superseded' }); } catch {} try { prev.conn.close(); } catch {} }
  const player = {
    id, name, conn, joined: true, director, color, role: undefined, alive: true,
    room: director ? (HOUSE.rooms.find((r) => !r.lobby) || {}).id : null, roomSource: 'join',
    tasks: [], hold: null, movedAt: 0, lastSeen: Date.now(),
  };
  if (prev) {   // carry the old player's live state across the refresh
    player.role = prev.role; player.alive = prev.alive;
    player.room = prev.room; player.roomSource = prev.roomSource;
    player.tasks = prev.tasks; player.hold = prev.hold;
    if (!color) player.color = prev.color;
  }
  if (!room.hostId && !director) room.hostId = id;
  room.players.set(id, player);
  if (!room.order.includes(id)) room.order.push(id);
  // Someone came back: lift the held win and re-test, so the round resumes
  // rather than staying frozen on a drop that has since healed.
  if (room.heldWin) { room.heldWin = false; checkWin(room); }
  conn.send({ t: 'welcome', id, code: room.code, hostId: room.hostId, name, director, color: player.color });
  conn.send(snapshotFor(room, player));
  roomEvent(room, { type: 'join', text: `${name}${director ? ' (director)' : ''} ${prev ? 'rejoined' : 'joined'} (${alivePlayers(room).length} playing).` });
  broadcastState(room, id);

  conn.onmessage = (raw) => {
    player.lastSeen = Date.now();
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.t !== 'string') return;
    try { handleMsg(room, player, msg); } catch (e) { console.error('handler', msg.t, e); }
  };
  // A refresh closes the old socket a moment before the new one arrives, so a
  // close does not remove the player at once: it waits out a short grace period
  // and only then cleans up. Without this, refreshing as host handed the host
  // role to somebody else and logged a leave/join every time.
  conn.onclose = () => {
    if (room.players.get(id) !== player) return;   // already replaced by a rejoin
    setTimeout(() => {
      if (room.players.get(id) !== player) return; // rejoined inside the grace period
      room.players.delete(id);
      room.votes.delete(id);
      sightings.delete(id);
      if (room.hostId === id) {
        const next = [...room.players.values()].find((x) => x.joined && !x.director);
        room.hostId = next ? next.id : null;
        if (next) roomEvent(room, { type: 'host', text: `${next.name} is now the host.` });
      }
      if (room.players.size === 0) { rooms.delete(room.code); return; }
      roomEvent(room, { type: 'leave', text: `${name} disconnected.` });
      if (room.state === 'meeting' && room.votes.size >= alivePlayers(room).length) endMeeting(room);
      // Mid-round, a drop is not a loss: the player is kept in the game and
      // only the win test is held off, so a phone that comes back rejoins the
      // same round. `checkWin` would otherwise call "not enough crew" the
      // instant one phone went to the home screen.
      if (room.state === 'playing') room.heldWin = true;
      else checkWin(room);
      broadcastState(room);
    }, 4000);
  };
});

/* Tick: meeting timers, task holds (a backgrounded tab stops sending), and
   beacon-driven room re-resolution all advance on the server clock. */
setInterval(() => {
  const now = Date.now();
  // Reaper: Cloudflare/nginx do not always propagate a closed TCP connection,
  // so a dead phone can look connected forever. Clients heartbeat every 25 s;
  // 90 s of silence means the connection is a ghost - close it for real, which
  // runs the normal disconnect cleanup (and GCs an empty game room).
  for (const room of rooms.values()) {
    for (const p of [...room.players.values()]) {
      // 3 minutes, not 90 s: a phone that sleeps or switches app can be silent
      // that long, and reaping it mid-round ended the game. The client now also
      // pings on every wake-up, so this is only the backstop for a real ghost.
      if (now - (p.lastSeen || 0) > 180000) p.conn._dead();
    }
  }
  for (const room of rooms.values()) {
    let dirty = false;
    if (room.state === 'meeting' && room.meetingEnds && now >= room.meetingEnds) { endMeeting(room); dirty = true; }
    if (room.state === 'playing' || room.state === 'lobby') {
      for (const p of room.players.values()) {
        if (!p.joined || p.director || !p.alive) continue;
        if (p.hold) {
          const task = (p.tasks || []).find((x) => x.id === p.hold.id && !x.done);
          if (!task || now - p.hold.at > gameMinSeconds(task) * 1000 + 120000) p.hold = null;
          else if (task.room === p.room && (now - p.hold.at) / 1000 >= gameMinSeconds(task)) {
            task.done = true; p.hold = null;
            // No "(faked?)" tag: the feed is public, and a tag on every impostor task
      // hands their role away the moment they fake one.
      roomEvent(room, { type: 'task', text: `${p.name} completed "${task.name}".` });
            dirty = true;
            checkWin(room);
          }
        }
        // Beacon evidence trumps a tap, always.
        const best = resolveRoom(p.id, p.roomSource === 'beacon' ? p.room : null);
        if (best && best !== p.room) { p.room = best; p.roomSource = 'beacon'; p.movedAt = now; dirty = true; }
        // Walking into a room with a body reports it for you. Checked after the
        // room update so a beacon-driven arrival counts the same as a tap.
        if (room.state === 'playing' && p.alive && bodyFound(room, p)) { dirty = true; break; }
      }
    }
    if (room.players.size && (room.state !== 'over' || !room.overSent)) {
      if (dirty) broadcastState(room);
      if (room.state === 'over') { broadcastState(room); room.overSent = true; }
    }
  }
}, 2000).unref();

server.listen(PORT, () => {
  console.log(`House Impostor on http://0.0.0.0:${PORT}  (${Object.keys(RULES).length} tunables, ${HOUSE.rooms.length} rooms, ${HOUSE.tasks.length} tasks)`);
});
