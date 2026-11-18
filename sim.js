/* Headless test rig: four fake phones + one beacon against a real server.
   Run: PORT=8399 ZONES-IGNORE=1 node server.js (in one shell), node sim.js
   Uses ZONES... no - uses HOUSE_FILE=/tmp/house-test.json to keep the real
   house.json clean. */
'use strict';
const cp = require('child_process');
const path = require('path');

const PORT = 8399;
const srv = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], {
  env: { ...process.env, PORT: String(PORT), HOUSE_FILE: '/tmp/house-test.json' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
let out = '';
srv.stdout.on('data', (d) => { out += d; });

let pass = 0, fail = 0;
const ok = (cond, label) => { if (cond) { pass++; console.log('  ok  ', label); } else { fail++; console.log('  FAIL', label); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Phone {
  constructor(name, code, director) {
    this.name = name; this.msgs = [];
    this.ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?room=${code}&name=${name}${director ? '&director=1' : ''}`);
    this.ready = new Promise((res) => { this.ws.onopen = res; });
    this.ws.onmessage = (e) => { const m = JSON.parse(e.data); this.msgs.push(m); if (this.onmsg) this.onmsg(m); };
  }
  send(o) { this.ws.send(JSON.stringify(o)); }
  last(t) { return [...this.msgs].reverse().find((m) => m.t === t); }
  state() { return this.last('state'); }
  you() { const s = this.state(); return s ? s.you : null; }
  nope() { return this.last('nope'); }
  clear() { this.msgs = []; }
}

const beacon = async (room, peers) => {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/beacon`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-beacon-key': 'house' },
    body: JSON.stringify({ beacon: room, peers }),
  });
  return r.status;
};

(async () => {
  await sleep(700);
  console.log('server:', out.trim());

  const h = await (await fetch(`http://127.0.0.1:${PORT}/api/house`)).json();
  ok(h.rooms.length === 10 && h.levels.length === 4, `house.json loaded (${h.rooms.length} rooms, ${h.levels.length} levels)`);
  const rules = await (await fetch(`http://127.0.0.1:${PORT}/api/rules`)).json();
  ok(rules.MOVE_COOLDOWN_S === 3 && rules.MIN_PLAYERS === 3, 'rules served');
  ok((await fetch(`http://127.0.0.1:${PORT}/api/beacon`, { method: 'POST', headers: { 'x-beacon-key': 'wrong' }, body: '{}' })).status === 401, 'beacon endpoint needs the key');

  const host = new Phone('alice', 'TEST');
  const b = new Phone('bob', 'TEST');
  const c = new Phone('carol', 'TEST');
  const d = new Phone('dave', 'TEST');
  const dir = new Phone('dir', 'TEST', true);
  await Promise.all([host.ready, b.ready, c.ready, d.ready, dir.ready]);
  await sleep(400);

  const w = host.last('welcome');
  ok(!!w && w.hostId === w.id, 'first joiner becomes host');
  ok(host.state().people.length === 4, 'lobby shows 4 players');
  ok(dir.state().you.director === true, 'director flagged');

  // start: non-host cannot, wrong level cannot, host can
  b.clear(); b.send({ t: 'start', level: 'house' }); await sleep(250);
  ok(/host/.test(b.nope().text), 'non-host cannot start');
  host.clear(); host.send({ t: 'start', level: 'attic' }); await sleep(250);
  ok(/level/i.test(host.nope().text), 'unknown level refused');

  host.clear(); b.clear();
  host.send({ t: 'start', level: 'house' }); await sleep(400);
  const s1 = b.state();
  ok(s1 && s1.state === 'playing', 'round started');
  const roles = [host, b, c, d].map((p) => p.you().role);
  ok(roles.filter((r) => r === 'impostor').length === 1, `exactly one impostor (${roles.join(',')})`);
  ok([host, b, c, d].every((p) => p.you().tasks.length === 4), 'every player got 4 tasks');
  ok([host, b, c, d].every((p) => p.you().room === 'land0'), 'all start on the basement landing');

  // movement graph
  const alice = [host, b, c, d].find((p) => p.you().role === 'crew') || b;
  alice.clear();
  alice.send({ t: 'move', room: 'bed1' }); await sleep(250);
  ok(!!alice.nope(), 'cannot teleport basement-landing -> bedroom');
  alice.clear();
  alice.send({ t: 'move', room: 'land1' }); await sleep(250);
  ok(alice.you().room === 'land1', 'door landing0 -> landing1 works');
  const nopeBefore = alice.msgs.filter((m) => m.t === 'nope').length;
  alice.send({ t: 'move', room: 'land2' }); await sleep(200);
  const nopees = alice.msgs.filter((m) => m.t === 'nope');
  ok(alice.you().room === 'land1' && /Slow down/.test((nopees[nopeBefore] || {}).text || ''), 'move cooldown blocks instant double-door');
  await sleep(3100);
  alice.clear(); alice.send({ t: 'move', room: 'land2' }); await sleep(250);
  ok(alice.you().room === 'land2', 'cooldown expired, second door opens');

  // beacon overrides a tap
  const vic = [host, b, c, d].find((p) => p !== alice && p.you().role === 'crew') || c;
  await beacon('bath', [{ p: vic.you().id, r: -55 }]);
  await sleep(300);
  ok(vic.you().room === 'bath' && vic.you().roomSource === 'beacon', 'beacon RSSI places the phone in the bathroom');
  await beacon('bath', [{ p: vic.you().id, r: -95 }]);   // weak: below floor
  await beacon('land2', [{ p: vic.you().id, r: -80 }]);  // runner-up within margin? -80 vs -95: clear winner land2
  await sleep(300);
  ok(vic.you().room === 'land2', 'weaker-but-clear beacon moves them out');
  await beacon('land2', [{ p: vic.you().id, r: -80 }]);
  await beacon('bed1', [{ p: vic.you().id, r: -78 }]);   // 2 dB apart, under the 5 dB margin
  await sleep(300);
  ok(vic.you().room === 'land2', 'ambiguous RSSI (2 dB apart) does NOT flip the room');

  // kill needs same room + cooldown
  const imp = [host, b, c, d].find((p) => p.you().role === 'impostor');
  const victim = [host, b, c, d].find((p) => p !== imp && p.you().role === 'crew');
  // put impostor where the victim is, via beacon
  await beacon(victim.you().room, [{ p: imp.you().id, r: -50 }, { p: victim.you().id, r: -55 }]);
  await sleep(300);
  const bootWait = imp.state().killReadyAt - Date.now();   // 15 s grace at round start
  if (bootWait > 0) await sleep(bootWait + 150);
  const here = victim.you().room;
  imp.send({ t: 'kill', victim: victim.you().id }); await sleep(300);
  ok(!victim.you().alive && victim.you().room === 'lobby', 'impostor killed the crew, victim sent to lobby');
  const v2 = [host, b, c, d].find((p) => p !== imp && p !== victim && p.you().role === 'crew');
  await beacon(here, [{ p: imp.you().id, r: -50 }, { p: v2.you().id, r: -55 }]);
  await sleep(300);
  const noopes = imp.msgs.filter((m) => m.t === 'nope').length;
  imp.send({ t: 'kill', victim: v2.you().id }); await sleep(250);
  ok(v2.you().alive && /cooldown/i.test(imp.nope().text || ''), 'kill cooldown enforced');

  // task: wrong room refused, hold too short refused, honest hold counts.
  // NB: pick a LIVE crew member - the kill section above may have eaten alice.
  const worker = [host, b, c, d].find((p) => p !== victim && p !== imp && p.you().alive && p.you().role === 'crew');
  const task = worker.you().tasks.find((t) => !t.done);
  worker.send({ t: 'taskStart', id: task.id }); worker.send({ t: 'taskDone', id: task.id }); await sleep(250);
  ok(!worker.you().tasks.find((t) => t.id === task.id).done, 'instant tap does not complete a task');
  // move them to the task room via beacon, then hold
  await beacon(task.room, [{ p: worker.you().id, r: -50 }]);
  await sleep(300);
  worker.send({ t: 'taskStart', id: task.id });
  await sleep(5400);
  worker.send({ t: 'taskDone', id: task.id }); await sleep(300);
  ok(worker.you().tasks.find((t) => t.id === task.id).done, '5.4s hold in the right room completes the task');

  // meeting: emergency, vote out the impostor by majority
  const alive = [host, b, c, d].filter((p) => p.you().alive);
  ok(alive.length >= 3, 'still enough players for a vote');
  const caller = alive.find((p) => p.you().role === 'crew');
  caller.send({ t: 'emergency' }); await sleep(400);
  ok(caller.state().state === 'meeting', 'emergency meeting starts');
  const target = imp.you().id;
  for (const p of alive) p.send({ t: 'vote', target });
  await sleep(500);
  const after = caller.state();
  await sleep(400);   // do not clear dir: the last broadcast already carries the result
  const dirPeople = dir.state().people;   // director sees everyone, players see their room
  ok(!dirPeople.find((x) => x.id === target).alive, 'impostor ejected by unanimous vote');
  ok(after.state === 'over' && /Crew win/.test((after.events || []).slice(-2).map((e) => e.text).join(' ')), 'last impostor out -> crew win announced');

  // fog of war: director sees everyone, player sees room-mates only
  host.send({ t: 'reset' }); await sleep(400);
  const ds = dir.state().people.length, hs = host.state().people.length;
  ok(ds === 4 && hs <= 4, `director sees all ${ds}, player sees ${hs}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  srv.kill();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('sim crashed:', e); srv.kill(); process.exit(2); });
