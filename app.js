/* House Impostor client. Renders whatever the server last said; sends only
   intents (move / task / kill / vote / start). No build step, no framework. */
'use strict';

const $ = (s) => document.querySelector(s);
const CFG = window.CFG || {};
let ws = null, me = null, S = null;   // S = last server snapshot
let resumeRoom = '';
let scanTried = false;   // per connection: arm the scan once, never in a loop   // set at boot; cleared by Leave so a reload stays on the join screen
let holdTimer = null, holdTask = null, holdAt = 0, meetingSounded = false, lastAutoRoom = null, autoTaskId = null;
let reconnectDelay = 800;

/* ------------------------------------------------------------------ toast */
function toast(text, cls, ms) {
  const el = document.createElement('div');
  el.className = cls || '';
  el.textContent = text;
  $('#toast').appendChild(el);
  setTimeout(() => el.remove(), ms || 4200);
}

/* -------------------------------------------------------------------- join */
function newCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 4; i++) c += A[Math.floor(Math.random() * A.length)];
  return c;
}

// Colour is cosmetic and only ever sent as a hex string the server re-validates.
const COLORS = ['#ff4d5e', '#38bdf8', '#4ade80', '#ffd23f', '#c084fc', '#fb923c', '#f472b6', '#22d3ee', '#a3e635', '#94a3b8', '#e879f9', '#f8fafc'];
let myColor = '#7dd3fc';
function loadColor() {
  const c = (localStorage.getItem('hi-color') || '').toUpperCase();
  myColor = COLORS.includes(c) ? c : COLORS[Math.floor(Math.random() * COLORS.length)];
}
function drawSwatches() {
  const el = $('#swatches');
  el.innerHTML = COLORS.map((c) => `<button type="button" role="radio" data-c="${c}" aria-checked="${c === myColor}" class="${c === myColor ? 'on' : ''}"><span class="crew" style="--c:${c}"></span></button>`).join('');
  el.querySelectorAll('[data-c]').forEach((b) => b.addEventListener('click', () => {
    myColor = b.dataset.c;
    try { localStorage.setItem('hi-color', myColor); } catch {}
    drawSwatches();
    if (me) send({ t: 'color', color: myColor });   // live change, no rejoin
    if (S) render();
  }));
}

// The house is one game at a time: the server hands out the live room, so a
// player only types a name and picks a colour. `fresh` starts a separate game
// instead of joining the one already running.
async function joinGame(fresh) {
  const name = ($('#in-name').value || '').trim() || 'player';
  const director = $('#in-director').checked ? '1' : '0';
  const btn = $('#btn-join');
  btn.disabled = true;
  resumeRoom = 'pending';   // re-enables the reconnect path after a Leave
  try {
    let code = '';
    if (!fresh) {
      const r = await fetch('/api/current', { cache: 'no-store' });
      code = ((await r.json()).code || '').toUpperCase();
    }
    if (!code) code = newCode();
    $('#in-code').value = code;
    localStorage.setItem('hi-name', name);
    localStorage.setItem('hi-director', director);
    connect(code);
  } catch (e) {
    toast(`Could not reach the house: ${e.message}`, 'bad');
  } finally { btn.disabled = false; }
}

function connect(code) {
  code = (code || $('#in-code').value || '').trim().toUpperCase();
  if (!code) return;
  const name = ($('#in-name').value || '').trim() || 'player';
  const director = $('#in-director').checked ? '1' : '0';
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  // Keep our player id so a refresh re-joins as the SAME player (server reuses it).
  const pid = localStorage.getItem('hi-pid') || '';
  // Remember the room, so a refresh lands straight back in it instead of the join form.
  try { localStorage.setItem('hi-room', code); } catch {}
  ws = new WebSocket(`${proto}//${location.host}/ws?room=${code}&name=${encodeURIComponent(name)}&director=${director}&color=${encodeURIComponent(myColor)}&pid=${encodeURIComponent(pid)}`);
  ws.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    onMsg(m);
  };
  ws.onclose = () => {
    // Leave sets resumeRoom = ''; a socket closing after that must not
    // reconnect and drag the player back into the game.
    if (!resumeRoom) return;
    toast('Disconnected - retrying...', 'bad');
    setTimeout(() => { if (resumeRoom) connect(code); }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.6, 15000);
  };
  ws.onopen = () => { reconnectDelay = 800; };
}

// Leave on purpose: drop the stored id so we come back as a new player, and
// forget the room so a reload shows the join screen.
function leaveGame() {
  try { localStorage.removeItem('hi-pid'); localStorage.removeItem('hi-room'); } catch {}
  // Stop the resume path from firing: without this the next load sees the old
  // room in storage and walks straight back into the game you just left.
  resumeRoom = '';
  // Clear every overlay, or a game-over / meeting card stays on top of the
  // join screen and swallows the taps - that is what "Leave game does nothing"
  // looked like.
  for (const id of ['#scr-over', '#scr-meeting', '#reveal', '#taskgame', '#menu']) {
    const el = $(id); if (el) { el.hidden = true; }
  }
  closeTask();
  me = null; S = null;
  if (ws) { ws.onclose = null; try { ws.close(); } catch {} ws = null; }
  $('#menu').hidden = true;
  $('#btn-menu').setAttribute('aria-expanded', 'false');
  $('#scr-game').hidden = true;
  $('#scr-join').hidden = false;
  $('#in-code').value = '';
  window.scrollTo(0, 0);
}

function onMsg(m) {
  switch (m.t) {
    case 'welcome':
      me = { id: m.id, name: m.name, hostId: m.hostId, director: !!m.director };
      if (m.color) myColor = m.color;
      try { localStorage.setItem('hi-pid', m.id); } catch {}   // survive a refresh
      $('#scr-join').hidden = true;
      $('#scr-game').hidden = false;
      // A director only watches: no beacons, no BLE permission, no scanning.
      // A director only watches: no beacons, no BLE permission, no scanning.
      // armScan() is deliberately NOT called here even for players - Chrome
      // wants it inside a tap, and the Join click already did that.
      scanTried = false;
      if (!me.director) {
        autoReconnectBeacons();
        // The join click normally arms this; if it did not (resume, director
        // switched off mid-flight) arm now, once.
        if (!armAtJoin && !scanArmed && !scanTried) { scanTried = true; armScan(); }
      }
      break;
    case 'state': S = m; render(); break;
    case 'bye':
      // The server has a newer socket for this player (another tab, a resume).
      // Reconnecting now would just close that one - stand down instead.
      if (ws) { ws.onclose = null; try { ws.close(); } catch {} ws = null; }
      break;
    case 'pong': break;
    case 'voted': {
      const who = (S.people || []).find((p) => p.id === m.target);
      toast(`✔ Your vote is in: ${who ? who.name : 'skip'}`, 'good', 4000);
      break;
    }
    case 'died':
      toast(`You are dead. Walk to the lobby. (${m.room})`, 'bad', 8000);
      if ('vibrate' in navigator) navigator.vibrate([200, 100, 200]);
      blip('kill');
      break;
    case 'nope':
      toast(m.text, 'bad');
      // a refused task (left the room, too quick) closes the pop-up
      if (taskOpen && /room|quick/i.test(m.text)) closeTask();
      break;
    case 'ok': break;
  }
}

function send(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }

/* ------------------------------------------------------------- game feel */
// Crewmate colour per player, stable across renders so you can learn who is who.
const CREW_COLORS = ['#ff4d5e', '#38bdf8', '#4ade80', '#ffd23f', '#c084fc', '#fb923c', '#f472b6', '#22d3ee', '#a3e635', '#facc15', '#94a3b8', '#e879f9'];
function crewColor(id) {
  // Your own chosen colour wins; everyone else is derived from their id.
  if (me && id === me.id && myColor) return myColor;
  const p = S && (S.people || []).find((q) => q.id === id);
  if (p && p.color) return p.color;
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return CREW_COLORS[Math.abs(h) % CREW_COLORS.length];
}
function crew(id, dead) {
  return `<span class="crew${dead ? ' dead' : ''}" style="--c:${crewColor(id)}"></span>`;
}

// Tiny WebAudio blips - no files, works offline, silently no-ops if blocked.
let actx = null;
function blip(kind) {
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    const t = actx.currentTime;
    const beep = (f, at, dur, type) => {
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = type || 'square'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + at);
      g.gain.exponentialRampToValueAtTime(0.16, t + at + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + at + dur);
      o.connect(g).connect(actx.destination); o.start(t + at); o.stop(t + at + dur + 0.02);
    };
    if (kind === 'kill') { beep(220, 0, .12); beep(110, .1, .22); }
    else if (kind === 'report') { beep(880, 0, .09); beep(660, .1, .09); beep(880, .2, .14); }
    else if (kind === 'reveal') { beep(520, 0, .1); beep(780, .11, .18, 'triangle'); }
    else { beep(660, 0, .07); }
  } catch {}
}

// Role reveal: shown once per round, tap to dismiss.
let revealFor = null, revealShown = false;
function maybeReveal() {
  const you = (S && S.you) || {};
  if (S.state !== 'playing' || !you.role || me.director) { if (S.state !== 'playing') revealShown = false; return; }
  if (revealShown && revealFor === you.role) return;
  revealShown = true; revealFor = you.role;
  const r = $('#reveal');
  r.className = you.role;
  r.style.zIndex = 45;   // above the game-over card, so it can never sit over its button
  $('#reveal-crew').style.setProperty('--c', you.role === 'impostor' ? '#ff4d5e' : crewColor(me.id));
  $('#reveal-role').textContent = you.role === 'impostor' ? 'The Impostor' : 'Crewmate';
  $('#reveal-hint').textContent = you.role === 'impostor'
    ? 'Blend in. Kill when nobody is looking. Use the vents... well, the doors.'
    : 'Do your chores. Watch who is where. Report what you find.';
  r.hidden = false;
  blip('reveal');
  if ('vibrate' in navigator) navigator.vibrate(you.role === 'impostor' ? [120, 60, 120] : 60);
}
$('#reveal').addEventListener('click', () => { $('#reveal').hidden = true; });

/* ----------------------------------------------------------------- render */
function roomName(id) { const r = S && S.house.rooms.find((x) => x.id === id); return r ? r.name : id; }
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function render() {
  if (!S || !me) return;
  me.hostId = S.hostId;
  $('#h-code').textContent = S.code;
  $('#btn-menu').textContent = S.state + ' ▾';
  $('#h-prog').textContent = (S.progress || 0) + '%';
  $('#h-crew').style.setProperty('--c', myColor);

  const you = S.you || {};
  const roleEl = $('#h-role');
  roleEl.className = 'pill';
  if (me.director) { roleEl.textContent = 'DIRECTOR'; }
  else if (!you.alive && S.state !== 'lobby') { roleEl.textContent = 'OUT'; roleEl.classList.add('dead'); }
  else if (you.role) { roleEl.textContent = you.role.toUpperCase(); roleEl.classList.add(you.role); }
  else roleEl.textContent = '';

  // Lobby dressing: a row of crewmates waiting in the airlock, in everyone's colours.
  const lob = $('#lobby-crew');
  if (lob) {
    if (S.state === 'lobby') {
      const ids = [me.id, ...(S.people || []).map((p) => p.id)];
      lob.innerHTML = ids.slice(0, 12).map((id) => crew(id, false)).join('');
      lob.hidden = false;
    } else lob.hidden = true;
  }

  renderFloorplan();
  renderPeople();
  renderTasks();
  renderSetup();
  renderFeed();

  // Meeting siren, once per meeting (not on every 2 s snapshot).
  if (S.state === 'meeting' && !meetingSounded) { meetingSounded = true; blip('report'); }
  if (S.state !== 'meeting') meetingSounded = false;

  maybeReveal();
  // Walking into a room with an unfinished task pops it up by itself.
  if (S.state === 'playing' && you.alive && !me.director
      && !taskOpen && !autoTaskId && you.room && you.room !== lastAutoRoom) {
    lastAutoRoom = you.room;
    const t = (you.tasks || []).find((x) => !x.done && x.room === you.room);
    if (t) {
      autoTaskId = t.id;
      setTimeout(() => {
        if (!taskOpen && S && S.you && S.you.room === t.room) openTask(t.id);
        autoTaskId = null;
      }, 400);
    }
  }

  $('#scr-meeting').hidden = S.state !== 'meeting';
  if (S.state !== 'meeting') voteBuilt = false;
  if (S.state === 'meeting') renderMeeting();
  const over = S.state === 'over';
  $('#scr-over').hidden = !over;
  if (over) renderOver();

  const playing = S.state === 'playing' && you.alive && !me.director;
  // Pairing must work BEFORE the round: the beacon only reports a room once a
  // phone is connected to it, so the lobby is exactly when you need this.
  const canPair = S.state === 'lobby' || S.state === 'over' || playing;
  // Directors never use beacons, so the whole BLE panel is noise for them.
  $('#panel-actions').hidden = me.director ? true : !canPair;
  // Only an impostor, only mid-round, and only while alive.
  const canKill = playing && you.role === 'impostor';
  $('#btn-kill').hidden = !canKill;
  if (!canKill) $('#panel-kill').hidden = true;
  if (canKill && !$('#panel-kill').hidden) renderKill();
  $('#btn-emergency').hidden = !playing;
  $('#btn-emergency').disabled = !you.emergencyLeft;
  $('#btn-emergency').textContent = you.emergencyLeft > 1 ? `Emergency (${you.emergencyLeft})` : 'Emergency';
}

function renderFloorplan() {
  const you = S.you || {};
  const fp = $('#floorplan');
  fp.innerHTML = '';
  const here = you.room;
  const dir = !!me.director;
  // Directors have no player position, but they still want to see the room
  // they are standing in, so fall back to the room their beacon resolves to.
  const hereMark = dir ? (you.beaconRoom || '') : (here || '');
  const showHere = !!hereMark;
  for (const f of S.house.floors) {
    const rooms = S.house.rooms.filter((r) => r.floor === f.id);
    if (!rooms.length) continue;
    const div = document.createElement('div');
    div.className = 'floor';
    const row = rooms.map((r) => {
      const people = (S.people || []).filter((p) => p.room === r.id);
      const bodies = (S.bodies || []).filter((b) => b.room === r.id);
      const dots = people.map((p) =>
        `<span title="${esc(p.name)}${p.alive ? '' : ' (out)'}" style="${p.id === me.id ? 'filter:drop-shadow(0 0 4px #ffd23f)' : ''}">${crew(p.id, !p.alive)}</span>`).join('')
        + (dir ? people.filter((p) => p.role === 'impostor').map(() => '<span class="imp-mark">★</span>').join('') : '');
      const locked = !dir && you.moveTo && !you.moveTo.includes(r.id) && r.id !== here && !r.lobby && S.state === 'playing';
      // `here` is written from the live snapshot, never from a stale flag, so a
      // room you just left cannot keep the ring.
      const isHere = showHere && r.id === hereMark;
      return `<div class="room ${isHere ? 'here' : ''} ${locked ? 'locked' : ''}" data-r="${esc(r.id)}"${isHere ? ' aria-current="true"' : ''}>
        <span class="nm">${esc(r.name)}</span>${bodies.length ? '<span class="body">💀</span>' : ''}
        <div class="dots">${dots}</div></div>`;
    }).join('');
    div.innerHTML = `<b>${esc(f.name)}</b><div class="floors-row">${row}</div>`;
    fp.appendChild(div);
  }
}

function renderPeople() {
  const you = S.you || {};
  const el = $('#people');
  if (me.director) {
    // The director is watching the whole house: roster with roles, every room.
    const all = (S.people || []).slice().sort((a, b) =>
      (a.alive === b.alive ? 0 : a.alive ? -1 : 1) || String(a.room).localeCompare(String(b.room)));
    el.innerHTML = all.length
      ? all.map((p) => `<div class="person"><span class="who">${crew(p.id, !p.alive)}${esc(p.name)}
          <span class="sub">${p.room ? esc(roomName(p.room)) : 'not placed'}</span>
          ${p.role ? `<i class="pill ${p.role}">${p.role}</i>` : ''}</span>
          ${p.alive ? '' : '<span class="pill dead">out</span>'}</div>`).join('')
      : '<p class="sub">Nobody has joined yet.</p>';
    $('#panel-people').hidden = false;
    $('#move').innerHTML = '';
    return;
  }
  const here = (S.people || []).filter((p) => p.room === you.room && p.id !== me.id);
  el.innerHTML = here.length
    ? here.map((p) => `<div class="person"><span class="who">${crew(p.id, !p.alive)}${esc(p.name)} ${p.alive ? '' : '(down)'}${p.role ? ` <i>${p.role}</i>` : ''}</span>
        ${you.role === 'impostor' && p.alive && you.alive ? (() => {
          const wait = Math.ceil(((S.killReadyAt || 0) - Date.now()) / 1000);
          return wait > 0 ? `<button class="danger" disabled>Kill ${wait}s</button>` : `<button class="danger" data-kill="${p.id}">Kill</button>`;
        })() : ''}</div>`).join('')
    : '<p class="sub">Nobody. Spooky.</p>';
  el.querySelectorAll('[data-kill]').forEach((b) => b.addEventListener('click', () => send({ t: 'kill', victim: b.dataset.kill })));

  const mv = $('#move');
  mv.innerHTML = '';
  if (S.state === 'playing' && you.alive && !me.director) {
    for (const id of you.moveTo || []) {
      const b = document.createElement('button');
      b.className = 'ghost';
      b.textContent = `→ ${roomName(id)}`;
      b.addEventListener('click', () => send({ t: 'move', room: id }));
      mv.appendChild(b);
    }
    if (you.roomSource === 'beacon') mv.insertAdjacentHTML('beforeend', '<span class="sub">position from beacon RSSI</span>');
  } else if (S.state === 'lobby' && you.beaconRoom) {
    // Pre-game: the board sees your phone in this room - check it before start.
    mv.insertAdjacentHTML('beforeend', `<span class="sub">beacon sees you in: <b>${esc(roomName(you.beaconRoom))}</b></span>`);
  }
  // Show the room panel when the beacon has something to say, even in the
  // lobby (no people/move buttons there, but the beacon line matters).
  $('#panel-people').hidden = !(here.length || mv.children.length || you.beaconRoom);
}

function renderKill() {
  const you = S.you || {};
  const box = $('#kill-list');
  if (S.state !== 'playing' || you.role !== 'impostor' || !you.alive) {
    box.innerHTML = '<p class="sub">No kill while the round is not running.</p>';
    return;
  }
  const wait = Math.ceil(((S.killReadyAt || 0) - Date.now()) / 1000);
  const others = (S.people || []).filter((p) => p.alive && p.id !== me.id);
  if (!others.length) { box.innerHTML = '<p class="sub">Nobody else is alive.</p>'; return; }
  box.innerHTML = others.map((p) => {
    const inRoom = p.room === you.room;
    const label = wait > 0 ? `Kill ${wait}s` : inRoom ? 'Kill' : 'Go there';
    return `<div class="person"><span class="who">${crew(p.id, true)}${esc(p.name)}
      <span class="sub">${p.room ? esc(roomName(p.room)) : 'not placed'}${inRoom ? ' - with you' : ''}</span></span>
      <button class="danger" data-kill2="${p.id}" ${inRoom && wait <= 0 ? '' : 'disabled'}>${label}</button></div>`;
  }).join('');
  box.querySelectorAll('[data-kill2]').forEach((b) => b.addEventListener('click', () => send({ t: 'kill', victim: b.dataset.kill2 })));
}

function renderTasks() {
  const you = S.you || {};
  const list = you.tasks || [];
  $('#panel-tasks').hidden = !(list.length && S.state === 'playing' && you.alive);
  $('#holdhint').textContent = 'tap a task in its room';
  $('#tasks').innerHTML = list.map((t) => {
    const inRoom = t.room === you.room;
    return `<div class="task ${t.done ? 'done' : ''}">
      <span class="nm">${esc(t.name)} <span class="sub">@ ${esc(roomName(t.room))}</span>
        <span class="pill ${t.kind === 'long' ? 'long' : ''}">${t.kind === 'long' ? 'long' : 'short'}</span></span>
      ${t.done ? '<span>✔</span>' : `<button data-open="${t.id}" ${inRoom ? '' : 'disabled'}>${inRoom ? 'Open' : 'Go there'}</button>`}
    </div>`;
  }).join('');
  $('#tasks').querySelectorAll('[data-open]').forEach((b) =>
    b.addEventListener('click', () => openTask(b.dataset.open)));
}

/* ------------------------------------------------------------------ tasks
 * Every task is a mini-game in a pop-up, like the real game: the room's
 * furniture is irrelevant, the screen is the task. The server checks the room
 * and a minimum time; the phone only reports "finished". */
let taskOpen = null;   // { task, at, done }

function openTask(id) {
  const t = (S.you.tasks || []).find((x) => x.id === id);
  if (!t || t.done) return;
  if (t.room !== (S.you.room || '')) { toast(`That task is in the ${roomName(t.room)} - go there first.`, 'bad'); return; }
  if (taskOpen) return;
  taskOpen = { task: t, at: Date.now(), done: false };
  send({ t: 'taskStart', id });
  $('#tg-title').textContent = t.name;
  $('#tg-room').textContent = roomName(t.room);
  $('#tg-body').innerHTML = '';
  $('#tg-msg').textContent = '';
  $('#taskgame').hidden = false;
  const min = (t.kind === 'long' ? 8 : 4);
  $('#tg-time').textContent = min + 's';
  buildGame(t.game || 'hold', $('#tg-body'), () => finishTask());
}

function closeTask() {
  taskOpen = null;
  $('#taskgame').hidden = true;
}

function finishTask() {
  if (!taskOpen || taskOpen.done) return;
  const elapsed = (Date.now() - taskOpen.at) / 1000;
  const need = taskOpen.task.kind === 'long' ? 8 : 4;
  if (elapsed + 0.4 < need) {
    $('#tg-msg').textContent = `Too quick - keep it open ${Math.ceil(need - elapsed)}s more.`;
    setTimeout(() => { if (taskOpen) finishTask(); }, Math.ceil((need - elapsed) * 1000) + 100);
    return;
  }
  taskOpen.done = true;
  send({ t: 'taskDone', id: taskOpen.task.id });
  $('#tg-msg').textContent = 'Done.';
  setTimeout(closeTask, 700);
}

const rnd = (n) => Math.floor(Math.random() * n);
const shuffle = (a) => { const b = a.slice(); for (let i = b.length - 1; i > 0; i--) { const j = rnd(i + 1); [b[i], b[j]] = [b[j], b[i]]; } return b; };

/* One builder per mini-game. `done()` is the only way out. */
function buildGame(game, el, done) {
  if (game === 'swipe') {
    el.innerHTML = '<div class="card-slot"></div><p class="sub">drag the card across the reader</p>'
      + '<div class="swipe-track"><div class="swipe-card">ID</div></div>';
    const card = el.querySelector('.swipe-card'), track = el.querySelector('.swipe-track');
    let drag = false, x0 = 0;
    const move = (e) => {
      if (!drag) return;
      const x = Math.max(0, Math.min(track.clientWidth - card.clientWidth, (e.touches ? e.touches[0].clientX : e.clientX) - x0));
      card.style.transform = `translateX(${x}px)`;
      if (x > track.clientWidth - card.clientWidth - 8) { drag = false; done(); }
    };
    card.addEventListener('pointerdown', (e) => { drag = true; x0 = e.clientX - (card._x || 0); });
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', () => { drag = false; });
    return;
  }
  if (game === 'keys') {
    const nums = shuffle([1,2,3,4,5,6,7,8,9]).slice(0, 9);
    el.innerHTML = '<p class="sub">tap 1 to 9 in order</p><div class="keygrid"></div>';
    const grid = el.querySelector('.keygrid'); let next = 1;
    nums.forEach((n) => {
      const b = document.createElement('button'); b.textContent = n;
      b.addEventListener('click', () => {
        if (n !== next) { next = 1; el.querySelectorAll('.keygrid button').forEach((x) => x.classList.remove('ok')); return; }
        b.classList.add('ok'); b.disabled = true; next++;
        if (next > 9) done();
      });
      grid.appendChild(b);
    });
    return;
  }
  if (game === 'wires') {
    const cols = shuffle(['#ff4d5e','#38bdf8','#ffd23f','#4ade80']);
    el.innerHTML = '<p class="sub">drag each wire to its colour</p><div class="wires"><div class="wcol">'
      + cols.map((c) => `<div class="wnode" style="--c:${c}"></div>`).join('')
      + '</div><div class="wcol">' + shuffle(cols).map((c) => `<div class="wnode" data-c="${c}" style="--c:${c}"></div>`).join('') + '</div></div>';
    const nodes = [...el.querySelectorAll('.wcol')[1].children];
    let picked = null;
    el.querySelectorAll('.wcol')[0].children.forEach((n, i) => n.addEventListener('click', () => { picked = n; el.querySelectorAll('.wnode').forEach((x) => x.classList.remove('sel')); n.classList.add('sel'); }));
    nodes.forEach((n) => n.addEventListener('click', () => {
      if (!picked) return;
      if (picked.style.getPropertyValue('--c') === n.dataset.c) { picked.classList.add('ok'); n.classList.add('ok'); picked = null; if (el.querySelectorAll('.wnode.ok').length >= 8) done(); }
      else { picked.classList.remove('sel'); picked = null; }
    }));
    return;
  }
  if (game === 'align') {
    el.innerHTML = '<p class="sub">line the bar up with the notch, then lock it</p><div class="align-track"><div class="align-notch"></div><div class="align-bar"></div></div><button class="big">Lock</button>';
    const bar = el.querySelector('.align-bar'), notch = el.querySelector('.align-notch');
    let pos = 0, dir = 1;
    const target = 30 + rnd(40);
    notch.style.left = target + '%';
    const iv = setInterval(() => {
      if (!taskOpen) return clearInterval(iv);
      pos += dir * 1.6; if (pos > 94 || pos < 0) dir *= -1;
      bar.style.left = pos + '%';
      if (Math.abs(pos - target) < 3) bar.classList.add('near'); else bar.classList.remove('near');
    }, 16);
    el.querySelector('button').addEventListener('click', () => {
      if (Math.abs(pos - target) < 6) { clearInterval(iv); done(); }
      else { el.querySelector('button').textContent = 'Missed - try again'; }
    });
    return;
  }
  if (game === 'leaves') {
    el.innerHTML = '<p class="sub">drag every leaf into the chute</p><div class="leafpad"></div><div class="chute">chute</div>';
    const pad = el.querySelector('.leafpad'), chute = el.querySelector('.chute');
    let left = 6;
    for (let i = 0; i < 6; i++) {
      const l = document.createElement('span'); l.className = 'leaf'; l.textContent = '🍃';
      l.style.left = (5 + rnd(80)) + '%'; l.style.top = (5 + rnd(70)) + '%';
      l.addEventListener('click', () => { l.remove(); if (--left === 0) done(); });
      pad.appendChild(l);
    }
    return;
  }
  if (game === 'hexes') {
    el.innerHTML = '<p class="sub">press every red hexagon</p><div class="hexgrid"></div>';
    const g = el.querySelector('.hexgrid'); let left = 7;
    for (let i = 0; i < 12; i++) {
      const h = document.createElement('span'); h.className = 'hex' + (i < 7 ? ' red' : '');
      if (i < 7) h.addEventListener('click', () => { h.classList.add('ok'); if (--left === 0) done(); });
      g.appendChild(h);
    }
    return;
  }
  if (game === 'keypad') {
    el.innerHTML = '<p class="sub">watch the sequence, then repeat it</p><div class="seq"></div><div class="keygrid pad"></div>';
    const seq = Array.from({ length: 5 }, () => rnd(4));
    const shown = el.querySelector('.seq'); let step = 0, live = false;
    const btns = ['▲','▼','◀','▶'].map((c, i) => { const b = document.createElement('button'); b.textContent = c; b.addEventListener('click', () => {
      if (!live) return;
      if (i === seq[step]) { step++; if (step === seq.length) { live = false; done(); } }
      else { step = 0; shown.textContent = 'wrong - watch again'; live = false; setTimeout(play, 900); }
    }); el.querySelector('.keygrid').appendChild(b); return b; });
    function play() {
      step = 0; let i = 0;
      const t = setInterval(() => {
        if (i >= seq.length) { clearInterval(t); live = true; shown.textContent = 'your turn'; return; }
        btns[seq[i]].classList.add('lit'); shown.textContent = 'watch...';
        setTimeout(() => btns[seq[i]].classList.remove('lit'), 320); i++;
      }, 520);
    }
    setTimeout(play, 400);
    return;
  }
  if (game === 'asteroids') {
    el.innerHTML = '<p class="sub">tap 10 asteroids</p><div class="sky"></div>';
    const sky = el.querySelector('.sky'); let left = 10;
    const iv = setInterval(() => {
      if (!taskOpen) return clearInterval(iv);
      if (sky.children.length > 14) return;
      const a = document.createElement('span'); a.className = 'rock'; a.textContent = '☄';
      a.style.left = (2 + rnd(84)) + '%'; a.style.top = (2 + rnd(80)) + '%';
      a.addEventListener('click', () => { a.remove(); if (--left === 0) { clearInterval(iv); done(); } });
      sky.appendChild(a);
    }, 260);
    return;
  }
  if (game === 'sample') {
    el.innerHTML = '<p class="sub">fill the tubes, then press the green button</p><div class="tubes"></div><button class="big" disabled>Green</button>';
    const tubes = el.querySelector('.tubes'), btn = el.querySelector('button');
    for (let i = 0; i < 5; i++) { const t = document.createElement('span'); t.className = 'tube'; tubes.appendChild(t); }
    let n = 0;
    const iv = setInterval(() => {
      if (!taskOpen) return clearInterval(iv);
      if (n >= 5) { clearInterval(iv); btn.disabled = false; return; }
      tubes.children[n].classList.add('full'); n++;
    }, 700);
    btn.addEventListener('click', () => { if (!btn.disabled) done(); });
    return;
  }
  if (game === 'fuel') {
    el.innerHTML = '<p class="sub">hold the lever until the tank is full</p><div class="tank"><div class="fill"></div></div><button class="big">Hold</button>';
    const fill = el.querySelector('.fill'), b = el.querySelector('button');
    let pct = 0, iv = null;
    const stop = () => { clearInterval(iv); iv = null; };
    b.addEventListener('pointerdown', () => {
      if (iv) return;
      iv = setInterval(() => { pct = Math.min(100, pct + 3); fill.style.height = pct + '%'; if (pct >= 100) { stop(); done(); } }, 60);
    });
    b.addEventListener('pointerup', stop); b.addEventListener('pointerleave', stop);
    return;
  }
  if (game === 'upload') {
    el.innerHTML = '<p class="sub">stand still while the data uploads</p><div class="bar"><div class="prog"></div></div>';
    const prog = el.querySelector('.prog'); let pct = 0;
    const iv = setInterval(() => { if (!taskOpen) return clearInterval(iv); pct += 2; prog.style.width = pct + '%'; if (pct >= 100) { clearInterval(iv); done(); } }, 80);
    return;
  }
  if (game === 'scan') {
    el.innerHTML = '<p class="sub">stand still in the scanner</p><div class="scanner"><div class="beam"></div><span class="crew big" id="scancrew"></span></div>';
    $('#scancrew').style.setProperty('--c', myColor);
    setTimeout(() => { if (taskOpen) done(); }, 9000);
    return;
  }
  // fallback: the old hold button
  el.innerHTML = '<p class="sub">hold to finish</p><button class="big">Hold</button>';
  const b = el.querySelector('button'); let iv = null;
  b.addEventListener('pointerdown', () => { iv = setTimeout(done, 3000); });
  b.addEventListener('pointerup', () => { if (iv) clearTimeout(iv); });
}

let voteBuilt = false;   // list is built once per meeting, not on every tick
function renderMeeting() {
  const you = S.you || {};
  const secs = Math.max(0, Math.ceil((S.meetingEnds - Date.now()) / 1000));
  $('#m-timer').textContent = secs;
  const bar = $('#m-bar');
  if (bar) bar.style.setProperty('--p', String(S.meetingS ? Math.min(1, secs / S.meetingS) : 1));
  const v = S.votes || {};
  $('#m-votes').textContent = `votes in: ${v.cast || 0} / ${v.of || 0}`;
  const cands = (S.people || []).filter((p) => p.alive && p.id !== me.id);
  const mine = v.mine || null;

  // Rebuilding this list every 500 ms replaced the button under the finger
  // mid-tap, which is why votes on the iPhones silently did nothing. Build the
  // rows once, then only update the labels.
  if (!voteBuilt) {
    voteBuilt = true;
    $('#vote').innerHTML = you.alive
      ? cands.map((p) => `<div class="person"><span class="who">${crew(p.id, !p.alive)}${esc(p.name)}</span><button data-vote="${p.id}">Vote</button></div>`).join('')
        + '<div class="person"><span class="who">Skip</span><button data-vote="skip" class="ghost">Skip</button></div>'
      : '<p class="sub">The dead may listen but not vote.</p>';
    $('#vote').querySelectorAll('[data-vote]').forEach((b) => b.addEventListener('click', () => send({ t: 'vote', target: b.dataset.vote })));
  }
  // Mark what you picked and how many votes each name has.
  $('#vote').querySelectorAll('[data-vote]').forEach((b) => {
    const id = b.dataset.vote;
    const n = (v.tally || {})[id] || 0;
    b.classList.toggle('mine', id === mine);
    b.textContent = id === mine ? 'Your vote' : (n ? `Vote (${n})` : 'Vote');
    b.disabled = !you.alive;
  });

  // A standalone line saying what this phone has chosen. The row styling alone
  // was too quiet - it did not read as "you made a choice".
  const mineEl = $('#m-mine');
  if (mine) {
    const who = mine === 'skip' ? null : (S.people || []).find((p) => p.id === mine);
    mineEl.textContent = `✔ You voted ${mine === 'skip' ? 'to skip' : `for ${who ? who.name : 'someone'}`} - tap another name to change it`;
    mineEl.hidden = false;
  } else if (you.alive) {
    mineEl.textContent = 'Tap a name to cast your vote';
    mineEl.hidden = false;
  } else {
    mineEl.hidden = true;
  }
}

function renderOver() {
  const first = (S.events || []).slice().reverse().find((e) => e.type === 'over');
  $('#over-title').textContent = first ? first.text : 'Round over';
  $('#over-roles').innerHTML = (S.people || []).map((p) =>
    `<div class="person"><span class="who">${crew(p.id, !p.alive)}${esc(p.name)}</span><span>${p.role || ''} ${p.alive ? '' : '(out)'}</span></div>`).join('');
  // Everyone gets a way out of this screen. Only the host can start the next
  // round, so for anyone else the button leaves the game instead of doing
  // nothing and stranding them here.
  const isHost = me.id === S.hostId;
  $('#btn-again').hidden = false;
  $('#btn-again').textContent = isHost ? 'Back to lobby' : 'Leave game';
}

function renderFeed() {
  $('#events').innerHTML = (S.events || []).slice().reverse().map((e) => `<div>${esc(e.text)}</div>`).join('');
}

function renderSetup() {
  const isHost = me.id === S.hostId && !me.director;
  const setupOpen = S.state === 'lobby' || S.state === 'over';
  // Non-hosts get the panel too, with one button: "Make me host". Without it a
  // phone can never start a round unless the host's phone is in the room.
  $('#panel-setup').hidden = !setupOpen;
  $('#setup-host-only').hidden = isHost;
  $('#btn-takeover').hidden = isHost || S.state !== 'lobby';
  $('#setup-host-only-2').hidden = !isHost;
  $('#start-hint').hidden = !isHost;
  const hn = (S.people || []).find((p) => p.id === S.hostId);
  $('#setup-hostname').textContent = hn ? hn.name : 'another device';
  $('#btn-start').hidden = !isHost;
  $('#btn-reset').hidden = !isHost;
  // Say WHY start is refused rather than letting the tap do nothing.
  if (isHost && S.state === 'lobby') {
    const n = (S.people || []).filter((p) => p.alive).length;
    const short = Math.max(0, 3 - n);
    $('#btn-start').disabled = short > 0;
    $('#start-hint').textContent = short
      ? `Need ${short} more player${short === 1 ? '' : 's'} (${n}/3).`
      : `${n} players ready.`;
    $('#start-hint').hidden = false;
  } else {
    $('#btn-start').disabled = false;
    $('#start-hint').hidden = true;
  }
  if (!isHost) return;
  const sel = $('#sel-level');
  if (sel.options.length !== S.house.levels.length) {
    sel.innerHTML = S.house.levels.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join('');
  }
  sel.value = S.level;
  $('#beacons').textContent = S.beacons
    ? `beacons reporting in: ${S.beacons.length ? S.beacons.map(roomName).join(', ') : 'none yet - flash an ESP32 and it appears here within seconds'}`
    : '';
  if (!$('#house-edit').dataset.built) buildHouseEditor();
}

/* ------------------------------------------------------------ house editor */
const slug = (s) => ((s || '').toLowerCase().replace(/[^a-z0-9]+/g, '') || 'room').slice(0, 16);
function uniqueId(base, taken) {
  const b = slug(base); let id = b, i = 2;
  while (taken.includes(id)) id = b + i++;
  return id;
}
function buildHouseEditor() {
  fetch('/api/house').then((r) => r.json()).then((h) => {
    const el = $('#house-edit');
    el.dataset.built = '1';
    el._house = h;
    h.floors = h.floors || []; h.rooms = h.rooms || []; h.edges = h.edges || [];
    h.levels = h.levels || []; h.tasks = h.tasks || [];
    const playRooms = () => h.rooms.filter((r) => !r.lobby);
    const playFloors = () => h.floors.filter((f) => f.id !== 'out');
    const doorCount = (id) => h.edges.filter(([a, b]) => a === id || b === id).length;
    const roomNameOf = (id) => { const r = h.rooms.find((x) => x.id === id); return r ? r.name : id; };

    el.innerHTML =
      '<h2>Floors</h2><div id="he-floors"></div><button id="he-addfloor" class="ghost">+ floor</button>' +
      '<h2>Rooms <span class="sub">first box = id (editable, lowercase; it is the beacon name), second = display name</span></h2><div id="he-rooms"></div><button id="he-addroom" class="ghost">+ room</button>' +
      '<h2>Doors</h2><div id="he-doors"></div>' +
      '<div class="he-task"><select id="he-da"></select><span class="sub">↔</span><select id="he-db"></select><button id="he-adddoor" class="ghost">+ door</button></div>' +
      '<h2>Settings</h2><label>Meeting / voting time (seconds, 15-300)</label><input id="he-meeting" type="number" min="15" max="300" step="5">' +
      '<label>Emergency calls per crew member, per round (0-5)</label><input id="he-emergency" type="number" min="0" max="5" step="1">' +
      '<h2>Tasks</h2><div id="he-tasks"></div><button id="he-add" class="ghost">+ task</button>';

    const drawAll = () => { drawFloors(); drawRooms(); drawDoors(); drawTasks(); drawSettings(); };

    const drawSettings = () => {
      h.settings = h.settings || {};
      const inp = $('#he-meeting');
      inp.value = h.settings.meetingS || (window.RULES ? RULES.MEETING_S : 60);
      inp.addEventListener('change', () => {
        const n = Math.round(Number(inp.value));
        h.settings.meetingS = Number.isFinite(n) ? Math.min(300, Math.max(15, n)) : 60;
        inp.value = h.settings.meetingS;
      });
      const em = $('#he-emergency');
      em.value = h.settings.emergencyPerCrew ?? 1;
      em.addEventListener('change', () => {
        const n = Math.round(Number(em.value));
        h.settings.emergencyPerCrew = Number.isFinite(n) ? Math.min(5, Math.max(0, n)) : 1;
        em.value = h.settings.emergencyPerCrew;
      });
    };

    const drawFloors = () => {
      $('#he-floors').innerHTML = playFloors().map((f) => `
        <div class="he-room"><input data-fname="${f.id}" value="${esc(f.name)}"><span class="sub">${f.id}</span>
        <button data-fdel="${f.id}" class="ghost">✕</button></div>`).join('');
      el.querySelectorAll('[data-fname]').forEach((inp) => inp.addEventListener('change', () => {
        const f = h.floors.find((x) => x.id === inp.dataset.fname); if (f) f.name = inp.value.trim() || f.name;
      }));
      el.querySelectorAll('[data-fdel]').forEach((b) => b.addEventListener('click', () => {
        const id = b.dataset.fdel;
        if (h.rooms.some((r) => r.floor === id)) { toast('Move or delete its rooms first.', 'bad'); return; }
        h.floors.splice(h.floors.findIndex((x) => x.id === id), 1);
        for (const l of h.levels) l.floors = (l.floors || []).filter((x) => x !== id);
        drawAll();
      }));
    };

    const drawRooms = () => {
      const fl = playFloors();
      $('#he-rooms').innerHTML = playRooms().map((r) => {
        const n = doorCount(r.id);
        return `<div class="he-room"><input data-rid="${r.id}" value="${esc(r.id)}" maxlength="16" spellcheck="false" title="room id = beacon name">
        <input data-rname="${r.id}" value="${esc(r.name)}">
        <select data-rfloor="${r.id}">${fl.map((f) => `<option value="${f.id}" ${f.id === r.floor ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}</select>
        <span class="sub">${n ? n + '🚪' : '<b style="color:var(--red)">no doors!</b>'}</span>
        <button data-rdel="${r.id}" class="ghost">✕</button></div>`;
      }).join('');
      el.querySelectorAll('[data-rid]').forEach((inp) => inp.addEventListener('change', () => {
        const old = inp.dataset.rid;
        const r = h.rooms.find((x) => x.id === old); if (!r) { drawAll(); return; }
        const nid = slug(inp.value);
        if (!nid || nid === old) { drawAll(); return; }
        if (h.rooms.some((x) => x.id === nid)) { toast(`id "${nid}" is taken - pick another.`, 'bad'); drawAll(); return; }
        r.id = nid;
        for (const e of h.edges) { if (e[0] === old) e[0] = nid; if (e[1] === old) e[1] = nid; }
        for (const t of h.tasks) if (t.room === old) t.room = nid;
        h.beacons = (h.beacons || []).map((b) => (b.room === old ? { ...b, room: nid } : b));
        toast(`id ${old} → ${nid}: its ${doorCount(nid)} door(s) and chores moved with it. Re-flash any ESP32 for this room as HB-${nid}.`);
        drawAll();
      }));
      el.querySelectorAll('[data-rname]').forEach((inp) => inp.addEventListener('change', () => {
        const r = h.rooms.find((x) => x.id === inp.dataset.rname); if (r) r.name = inp.value.trim() || r.name;
      }));
      el.querySelectorAll('[data-rfloor]').forEach((s) => s.addEventListener('change', () => {
        const r = h.rooms.find((x) => x.id === s.dataset.rfloor); if (r) r.floor = s.value;
      }));
      el.querySelectorAll('[data-rdel]').forEach((b) => b.addEventListener('click', () => {
        const id = b.dataset.rdel;
        const r = h.rooms.find((x) => x.id === id);
        if (!r || !confirm(`Delete "${r.name}"? Its doors and chores go with it.`)) return;
        h.rooms.splice(h.rooms.indexOf(r), 1);
        h.edges = h.edges.filter(([a, c]) => a !== id && c !== id);
        h.tasks = h.tasks.filter((t) => t.room !== id);
        drawAll();
      }));
    };
    $('#he-addroom').addEventListener('click', () => {
      const fl = playFloors();
      if (!fl.length) { toast('Add a floor first.', 'bad'); return; }
      const id = uniqueId('room', h.rooms.map((r) => r.id));
      h.rooms.push({ id, floor: fl[0].id, name: 'New room' });
      drawAll();
    });

    const drawDoors = () => {
      $('#he-doors').innerHTML =
        (h.edges.map((e, i) => `
          <div class="he-task"><span class="sub">${esc(roomNameOf(e[0]))} ↔ ${esc(roomNameOf(e[1]))}</span>
          <button data-edel="${i}" class="ghost">✕</button></div>`).join('')
         || '<p class="sub">no doors yet — a room you cannot walk into does not exist.</p>');
      el.querySelectorAll('[data-edel]').forEach((b) => b.addEventListener('click', () => {
        h.edges.splice(+b.dataset.edel, 1); drawAll();
      }));
      const opts = playRooms().map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join('');
      $('#he-da').innerHTML = opts; $('#he-db').innerHTML = opts;
    };
    $('#he-adddoor').addEventListener('click', () => {
      const a = $('#he-da').value, b = $('#he-db').value;
      if (!a || !b) { toast('Pick two rooms.', 'bad'); return; }
      if (a === b) { toast('A door to itself is a closet.', 'bad'); return; }
      if (h.edges.some(([x, y]) => (x === a && y === b) || (x === b && y === a))) { toast('That door already exists.', 'bad'); return; }
      h.edges.push([a, b]); drawAll();
    });

    $('#he-addfloor').addEventListener('click', () => {
      const name = (prompt('Floor name? (e.g. Attic)') || '').trim();
      if (!name) return;
      const id = uniqueId(name, h.floors.map((f) => f.id));
      h.floors.push({ id, name });
      const biggest = h.levels.slice().sort((x, y) => (y.floors || []).length - (x.floors || []).length)[0];
      if (biggest) biggest.floors = (biggest.floors || []).concat(id);   // the "all floors" level grows too
      h.levels.push({ id: uniqueId(id + 'only', h.levels.map((l) => l.id)), name: name + ' only', floors: [id] });
      drawAll();
    });

    const drawTasks = () => {
      const rooms = playRooms();
      $('#he-tasks').innerHTML = h.tasks.map((t, i) => `
        <div class="he-task"><input data-task="${i}" value="${esc(t.name)}">
        <select data-troom="${i}">${rooms.map((r) => `<option value="${r.id}" ${r.id === t.room ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select>
        <select data-tkind="${i}"><option value="short" ${t.kind === 'long' ? '' : 'selected'}>short</option><option value="long" ${t.kind === 'long' ? 'selected' : ''}>long</option></select>
        <button data-tdel="${i}" class="ghost">✕</button></div>`).join('');
      el.querySelectorAll('[data-task]').forEach((inp) => inp.addEventListener('change', () => { h.tasks[+inp.dataset.task].name = inp.value; }));
      el.querySelectorAll('[data-troom]').forEach((s) => s.addEventListener('change', () => { h.tasks[+s.dataset.troom].room = s.value; }));
      el.querySelectorAll('[data-tkind]').forEach((s) => s.addEventListener('change', () => { h.tasks[+s.dataset.tkind].kind = s.value === 'long' ? 'long' : 'short'; }));
      el.querySelectorAll('[data-tdel]').forEach((b) => b.addEventListener('click', () => { h.tasks.splice(+b.dataset.tdel, 1); drawTasks(); }));
    };
    $('#he-add').addEventListener('click', () => {
      const rooms = playRooms();
      if (!rooms.length) { toast('Add a room first.', 'bad'); return; }
      h.tasks.push({ room: rooms[0].id, name: 'New chore', kind: 'short' }); drawTasks();
    });

    drawAll();
  }).catch(() => {});
}

/* ------------------------------------------------------------------- BLE */
// Silent re-pair: getDevices() returns devices this origin was already granted
// (beacio/Chrome support it). On join we re-attach to every approved beacon with
// NO chooser, so players pair once and later games are automatic.
async function autoReconnectBeacons() {
  if (!navigator.bluetooth || !navigator.bluetooth.getDevices) return;
  let devs = [];
  try { devs = await navigator.bluetooth.getDevices(); } catch { return; }
  for (const dev of devs) {
    if (!dev.name || !dev.name.startsWith(CFG.BLE_PREFIX || 'HB-')) continue;
    if (dev.gatt && dev.gatt.connected) { await sendIam(dev); continue; }
    try {
      const server = await dev.gatt.connect();
      const svc = await server.getPrimaryService(CFG.BLE_SERVICE || 'ffe0');
      const ch = await svc.getCharacteristic(CFG.BLE_CHAR || 'ffe1');
      await ch.writeValue(new TextEncoder().encode('iam:' + me.id));
      attachReconnect(dev);
      const st = $('#ble-status'); if (st) st.textContent = `re-paired ${dev.name} (no chooser).`;
    } catch {}
  }
}
function attachReconnect(dev) {
  if (dev.gatt._hiHooked) return; dev.gatt._hiHooked = true;
  dev.gatt.addEventListener('gattserverdisconnected', () => {
    setTimeout(() => dev.gatt.connect().then(() => sendIam(dev)).catch(() => {}), 4000);
  });
}
async function sendIam(dev) {
  try {
    const svc = await dev.gatt.getPrimaryService(CFG.BLE_SERVICE || 'ffe0');
    const ch = await svc.getCharacteristic(CFG.BLE_CHAR || 'ffe1');
    await ch.writeValue(new TextEncoder().encode('iam:' + me.id));
  } catch {}
}

async function pairBeacon() {
  const st = $('#ble-status');
  if (!navigator.bluetooth) {
    st.textContent = 'No Web Bluetooth in this browser. iPhone: install the free "beacio" Safari extension and turn it on (see the warning on the join screen). Until then, tap your doors - the game works.';
    return;
  }
  try {
    const dev = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: CFG.BLE_PREFIX || 'HB-' }],
      optionalServices: [CFG.BLE_SERVICE || 'ffe0'],
    });
    st.textContent = `connecting ${dev.name}...`;
    const server = await dev.gatt.connect();
    const svc = await server.getPrimaryService(CFG.BLE_SERVICE || 'ffe0');
    const ch = await svc.getCharacteristic(CFG.BLE_CHAR || 'ffe1');
    await ch.writeValue(new TextEncoder().encode('iam:' + me.id));
    attachReconnect(dev);
    st.textContent = `paired ${dev.name}. Re-pairs automatically next time - no chooser.`;
  } catch (e) {
    st.textContent = e && e.name === 'NotFoundError' ? 'pairing chooser closed' : `BLE: ${e.message}`;
  }
}

/* ---------------------------------------------------- scan mode (no pairing) */
// The phone listens for HB-* advertisements and posts what it hears to the
// server; the SERVER works out the room (same RSSI pipeline as the boards).
// No connecting, no chooser, no per-beacon pairing. Needs an API that reports
// advertisements: bluetooth.watchAdvertisements (beacio / Chromium) or
// navigator.bluetooth.requestLEScan. Both need a user gesture to start.
let scanArmed = false, seen = {}, lescan = null, sampleTimer = null, scanDevs = [];
let lastAdvertAt = 0, lastRestartAt = 0, restarting = false, newBeaconTimer = null;
let lastReportAt = 0, tapTimer = null, manualMode = false, manualRoomId = '';

function onAdvert(e) {
  const d = e.device || {};
  const name = d.name || d.localName || e.name || '';   // global events may carry the name on the event
  if (!name.startsWith(CFG.BLE_PREFIX || 'HB-')) return;
  const room = name.replace(CFG.BLE_PREFIX || 'HB-', '');
  const prev = seen[room];
  // Keep the STRONGEST reading of the window: RSSI jitters several dB per packet,
  // and the last one is as likely to be a bad sample as a good one.
  if (prev === undefined || e.rssi > prev) seen[room] = e.rssi;
  lastAdvertAt = Date.now();
  // A beacon we were not hearing a moment ago -> report NOW instead of waiting for
  // the window to close. That is what makes walking into a room feel instant.
  if (prev === undefined) {
    clearTimeout(newBeaconTimer);
    newBeaconTimer = setTimeout(reportScan, 400);
  }
}

// beacio's requestLEScan goes silent after a few minutes (iOS throttling) and never
// recovers on its own - that is what made the room label flicker off. If nothing
// has been heard for a while, stop and restart the scan. Restarting needs no user
// gesture (unlike requestDevice), so it is fully automatic.
async function restartLescan() {
  if (restarting || !scanArmed || !navigator.bluetooth.requestLEScan) return;
  restarting = true;
  try {
    try { if (lescan && lescan.stop) lescan.stop(); } catch {}
    lescan = await navigator.bluetooth.requestLEScan({ acceptAllAdvertisements: true, keepRepeatedDevices: true });
    lastRestartAt = Date.now();
    diag({ ev: 'lescan-restart' });
  } catch (e) { diag({ ev: 'lescan-restart-fail', name: e && e.name, msg: e && e.message }); }
  restarting = false;
}

// Fire-and-forget note to the server so we can read what the phone did.
function diag(o) {
  // The user agent travels with every report: without it an "arm-none" line
  // cannot be told apart between iPhone, Android Chrome and desktop.
  const body = { ...o, ua: (navigator.userAgent || '').slice(0, 160) };
  try { fetch('/api/diag', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); } catch {}
}

// Arm once (needs a user gesture): attach the advertisement listener and start
// watching. From then on we just re-report what we hear on a timer - no more
// choosers. The phone never connects to a beacon.
/* Chrome on Android only: the board picker MUST be opened inside the tap.
 * joinGame() awaits /api/current before the socket even exists, so by the time
 * the welcome frame arms the scan the gesture is gone (SecurityError). So the
 * click calls this synchronously; armScan() then awaits the same promise. */
let pickPromise = null;
/* True when this browser can hear advertisements at all. Android Chrome ships
 * neither requestLEScan nor watchAdvertisements without
 * chrome://flags/#enable-experimental-web-platform-features, so those phones
 * fall back to "pick your room" (see manualRoom below). */
function canHearAdverts() {
  if (!navigator.bluetooth) return false;
  if (navigator.bluetooth.requestLEScan || navigator.bluetooth.watchAdvertisements) return true;
  return typeof BluetoothDevice !== 'undefined'
    && typeof BluetoothDevice.prototype.watchAdvertisements === 'function';
}

function pickDevice() {
  if (pickPromise || !navigator.bluetooth || !navigator.bluetooth.requestDevice) return;
  try {
    pickPromise = navigator.bluetooth.requestDevice({ filters: [{ namePrefix: CFG.BLE_PREFIX || 'HB-' }] });
  } catch (e) { pickPromise = Promise.reject(e); }
  pickPromise.catch(() => {});   // consumed in armScan; do not warn twice
}

async function armScan() {
  const st = $('#ble-status');
  if (!navigator.bluetooth) { st.textContent = 'No Web Bluetooth here. iPhone: turn on the free "beacio" Safari extension. Android Chrome: allow Nearby devices + Location (steps on the join screen).'; return; }
  if (scanArmed) return;
  seen = {};
  let usedChooser = false, watching = 0, watchErr = '', pickErr = '', pickMs = 0, devNames = [], globalScan = false;
  // Three shapes exist in the wild; use whichever this browser has.
  //  - beacio / Chromium: navigator.bluetooth.requestLEScan() (GLOBAL scan, no picker)
  //  - navigator.bluetooth.watchAdvertisements()             (GLOBAL scan, no picker)
  //  - Chromium per-device: device.watchAdvertisements()     (event on the device)
  try {
    // Keep the screen awake while scanning - iOS freezes BLE when it sleeps.
    try { if (navigator.bluetooth.setScreenDimEnabled) navigator.bluetooth.setScreenDimEnabled(true); } catch {}
    if (navigator.bluetooth.requestLEScan) {
      // Global scan on the navigator: hears EVERY surrounding beacon, no chooser.
      // onAdvert filters to HB-*.
      navigator.bluetooth.addEventListener('advertisementreceived', onAdvert);
      lescan = await navigator.bluetooth.requestLEScan({ acceptAllAdvertisements: true, keepRepeatedDevices: true });
      globalScan = true; watching = 1;
    } else if (navigator.bluetooth.watchAdvertisements) {
      // Global scan on the navigator: hears EVERY surrounding beacon, no chooser,
      // nothing for the player to pick.
      navigator.bluetooth.addEventListener('advertisementreceived', onAdvert);
      try { await navigator.bluetooth.watchAdvertisements({ acceptAllAdvertisements: true }); }
      catch { await navigator.bluetooth.watchAdvertisements(); }
      globalScan = true; watching = 1;
    } else {
      // Per-device: watch EVERY beacon this phone was granted - no picker.
      // On-device evidence (bleprime T1/T2/T3): granted handles alone stay SILENT;
      // the scan only starts once requestDevice() is called, and it then primes
      // every watched handle (the adverts arrive on the granted listeners, not the
      // picked one). requestDevice() needs no fresh gesture, so we call it AFTER
      // attaching - the player just taps Join, never a chooser.
      // ORDER MATTERS. requestDevice() must be called before any other await,
      // or Chrome on Android has lost the tap gesture and throws SecurityError.
      // getDevices() is therefore only used to top up after the picker.
      let devs = [];
      if (navigator.bluetooth.requestDevice) {
        try {
          const tPick = Date.now();
          const d = await (pickPromise || navigator.bluetooth.requestDevice({ filters: [{ namePrefix: CFG.BLE_PREFIX || 'HB-' }] }));
          pickPromise = null;
          pickMs = Date.now() - tPick;
          devs.push(d); usedChooser = true;
          if (typeof d.watchAdvertisements === 'function') {
            d.addEventListener('advertisementreceived', onAdvert);
            try { await d.watchAdvertisements(); watching++; } catch (e) { watchErr = (e && e.name) + ':' + (e && e.message); }
          }
        } catch (e) { pickErr = (e && e.name) + ':' + (e && e.message); pickPromise = null; }
      }
      if (navigator.bluetooth.getDevices) {
        try {
          const known = (await navigator.bluetooth.getDevices()).filter((d) => (d.name || '').startsWith(CFG.BLE_PREFIX || 'HB-'));
          for (const d of known) {
            if (devs.includes(d) || typeof d.watchAdvertisements !== 'function') continue;
            d.addEventListener('advertisementreceived', onAdvert);
            try { await d.watchAdvertisements(); watching++; } catch (e) { watchErr = (e && e.name) + ':' + (e && e.message); }
            devs.push(d);
          }
        } catch {}
      }
      scanDevs = devs;
      devNames = devs.map((d) => d.name || '(noname)');
      // No way to hear advertisements: the picked board IS the room. Report it
      // once, then re-send on the heartbeat so the server TTL never expires.
      if (!watching && devs.length) {
        manualMode = true;
        manualRoomId = (devs[0].name || '').replace(CFG.BLE_PREFIX || 'HB-', '');
        scanArmed = true;
        clearInterval(sampleTimer);
        sampleTimer = setInterval(reportManual, CFG.SCAN_EVERY_MS || 8000);
        reportManual();
        diag({ ev: 'arm-manual', room: manualRoomId, devs: devNames.length });
        st.textContent = `room set to ${roomName(manualRoomId)} by the board you picked. Walk somewhere else, then tap "Auto-detect room" again.`;
        return;
      }
      if (!watching && navigator.bluetooth.requestLEScan) {
        navigator.bluetooth.addEventListener('advertisementreceived', onAdvert);
        lescan = await navigator.bluetooth.requestLEScan({ acceptAllAdvertisements: true });
        watching = 1;
      }
      if (!watching) {
        diag({ ev: 'arm-none', devs: devNames.length, watchErr, pickErr });
        st.textContent = /NotFound/.test(pickErr)
          ? 'you closed the board picker - tap "Auto-detect room" to try again.'
          : /Security|NotAllowed/.test(pickErr)
            ? 'Chrome dropped the tap - tap "Auto-detect room" and pick a board.'
            : 'this browser cannot scan - tap "Pair my beacons" once instead.';
        return;
      }
    }
    scanArmed = true;
    lastAdvertAt = Date.now(); lastRestartAt = Date.now();
    clearInterval(sampleTimer);
    sampleTimer = setInterval(reportScan, CFG.SCAN_EVERY_MS || 8000);
    diag({ ev: 'arm', path: globalScan ? 'global' : 'per-device', usedChooser, pickErr, pickMs, watching, devNames });
    st.textContent = globalScan
      ? 'scanning all beacons automatically - nothing to pick.'
      : watching
        ? 'scanning your beacons automatically - nothing to pick.'
        : 'scan armed - no beacons granted yet, tap "Auto-detect room" to pick one.';
  } catch (e) {
    diag({ ev: 'arm-fail', name: e && e.name, msg: e && e.message });
    st.textContent = (e && e.name === 'NotFoundError') ? 'scan: picker closed - tap "Auto-detect room" to retry'
      : (e && e.name === 'InvalidStateError') ? `scan: ${e && e.message} - tap "Auto-detect room"`
      : `scan: ${e && e.message}`;
  }
}

function disarmScan() {
  scanArmed = false; manualMode = false; manualRoomId = '';
  clearInterval(sampleTimer);
  try { if (lescan && lescan.stop) lescan.stop(); } catch {}
  lescan = null;
  $('#ble-status').textContent = 'scan off.';
}

function roomName(id) {
  const r = S && S.house && (S.house.rooms || []).find((x) => x.id === id);
  return r ? r.name : id;
}

async function reportManual() {
  if (!scanArmed || !me || !manualRoomId) return;
  lastReportAt = Date.now();
  try {
    await fetch('/api/scan', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-beacon-key': CFG.BEACON_KEY || 'house' },
      body: JSON.stringify({ p: me.id, manual: manualRoomId }),
    });
  } catch {}
}

async function reportScan() {
  if (!scanArmed || !me) return;
  clearTimeout(newBeaconTimer);
  // watchdog: scan went quiet -> restart it (see restartLescan)
  if (navigator.bluetooth.requestLEScan
      && Date.now() - lastAdvertAt > (CFG.SCAN_WATCHDOG_MS || 12000)
      && Date.now() - lastRestartAt > 8000) {
    restartLescan();
  }
  const rooms = Object.keys(seen);
  const st = $('#ble-status');
  lastReportAt = Date.now();
  // Always post, even when we heard nothing - that way the server (and the
  // status line) shows a live, silent scan instead of nothing at all.
  const payload = { p: me.id, seen: rooms.map((b) => ({ b, r: seen[b] })) };
  seen = {};   // next window starts clean, so a room we left drops out
  // A report fired mid-window can leave a beacon that keeps advertising out of
  // `seen` until its next packet; the heartbeat below re-reports it. The server
  // keeps the last value for BEACON_STALE_S, so a gap costs nothing.
  try {
    await fetch('/api/scan', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-beacon-key': CFG.BEACON_KEY || 'house' },
      body: JSON.stringify(payload),
    });
    st.textContent = rooms.length
      ? `room auto-detect: reported ${rooms.length} beacon(s): ${rooms.join(', ')}`
      : 'scanning... no beacons heard yet.';
  } catch (e) { st.textContent = `report failed: ${e.message}`; }
}

// Tapping anywhere re-reports the last thing we heard, so a touch gives an
// immediate location update instead of waiting for the heartbeat. The RSSI is
// the strongest of the last window, which is what the server resolves on.
// Rate-limited so a burst of taps does not become a burst of POSTs.
function reportNow() {
  if (!scanArmed || !me) return;
  const wait = (CFG.TAP_MIN_MS || 1200) - (Date.now() - lastReportAt);
  if (wait > 0) {
    if (!tapTimer) tapTimer = setTimeout(() => { tapTimer = null; reportNow(); }, wait);
    return;
  }
  clearTimeout(tapTimer); tapTimer = null;
  if (manualMode) reportManual(); else reportScan();
}

function toggleScan() { if (scanArmed) disarmScan(); else { pickDevice(); armScan(); } }

/* Chrome on Android has neither global scan API, so arming it means a board
 * picker. Calling that from the Join click as well as from the welcome frame
 * opened TWO pickers, and closing the second one bounced the player back to the
 * join screen - the "screen keeps flipping". Only the click arms; the welcome
 * frame arms only when the click did not (a director, or a resume). */
let armAtJoin = false;
function armForJoin() {
  if ($('#in-director').checked) return;
  pickDevice();   // synchronous, still inside the tap
  armAtJoin = true;
  armScan().finally(() => { armAtJoin = false; });
}

// Any touch anywhere on the page = "where am I, right now". Passive so it never
// delays the tap's own action; ignore taps on the join screen (no player yet)
// and on the role-reveal overlay (it has its own tap handler).
document.addEventListener('pointerdown', () => {
  if (!me || $('#scr-game').hidden) return;
  if (!$('#reveal').hidden) return;
  reportNow();
}, { passive: true });

/* ------------------------------------------------------------------ wire */
window.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(location.search);
  if (params.get('room')) $('#in-code').value = params.get('room').toUpperCase().slice(0, 4);
  if (params.get('director') === '1') $('#in-director').checked = true;
  $('#in-name').value = localStorage.getItem('hi-name') || '';
  loadColor();
  drawSwatches();
  // Decorative crewmates on the join screen.
  $('#floaters').innerHTML = COLORS.slice(0, 4).map((c) => `<span class="crew" style="--c:${c}"></span>`).join('');

  // A refresh (or coming back from another tab) rejoins the room you were in.
  const savedRoom = (localStorage.getItem('hi-room') || '').toUpperCase();
  const savedPid = localStorage.getItem('hi-pid') || '';
  if (savedRoom && savedPid) {
    resumeRoom = savedRoom;
    $('#in-code').value = savedRoom;
    $('#in-director').checked = localStorage.getItem('hi-director') === '1';
    $('#scr-join').hidden = true;
    $('#scr-game').hidden = false;
    connect(savedRoom);
  }

  fetch('/api/rules').then((r) => r.json()).then((r) => { window.RULES = r; }).catch(() => {});

  // No Web Bluetooth here. On iOS that is Safari without the beacio extension -
  // give the exact one-time steps instead of a vague "use another browser".
  const iOS = /iPhone|iPad|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  // Directors never touch Bluetooth, so the whole warning is noise for them.
  // Also shown on Android Chrome that cannot hear advertisements (no flag):
  // there the picker is the only way to set a room, so the steps matter.
  if ((!('bluetooth' in navigator) || !canHearAdverts()) && !$('#in-director').checked) {
    $('#ble-warn').hidden = false;
    if (iOS) {
      $('#ble-warn').innerHTML =
        '<b>iPhone / iPad: one-time setup for automatic room detection.</b><br>' +
        '1. Install the free <b>beacio</b> extension from the App Store (<a href="https://apps.apple.com/us/app/beacio/id6761301368" target="_blank" rel="noopener">open it</a>).<br>' +
        '2. Settings &gt; Apps &gt; Safari &gt; Extensions &gt; beacio &gt; turn on <b>Allow Extension</b>, then under Permission choose <b>Other Websites &gt; Allow</b>.<br>' +
        '3. Or in Safari: tap the <b>aA</b> button in the address bar &gt; Manage Extensions &gt; beacio on &gt; Done, then tap <b>aA</b> &gt; beacio &gt; <b>Allow on Every Website</b>.<br>' +
        '4. Reload this page. iOS asks once to let beacio use Bluetooth - tap <b>Allow</b>.<br>' +
        'No extension? Tapping the doors still plays fine.';
    } else if (/Android/.test(navigator.userAgent) && /Chrome/.test(navigator.userAgent)) {
      $('#ble-warn').innerHTML =
        '<b>Chrome on Android: turn Bluetooth on for this site.</b><br>' +
        '1. Tap the <b>padlock</b> in the address bar &gt; <b>Permissions</b> &gt; <b>Nearby devices</b> &gt; Allow.<br>' +
        '2. Android Settings &gt; Apps &gt; Chrome &gt; Permissions &gt; <b>Nearby devices</b> &gt; Allow.<br>' +
        '3. Make sure phone <b>Location</b> is on and Chrome has Location permission - Android will not scan for beacons without it.<br>' +
        '4. Reload this page and tap Join. Chrome shows a board picker - pick the board of the room you are <b>standing in</b>. That sets your room.<br>' +
        '5. Walk to another room, then tap <b>Auto-detect room</b> and pick that room\'s board. Tapping doors still works too.<br>' +
        'Want it fully automatic like the iPhones? Open <b>chrome://flags/#enable-experimental-web-platform-features</b>, set it to <b>Enabled</b>, and relaunch Chrome. Then one pick covers every room.';
    } else {
      $('#ble-warn').textContent = 'No Web Bluetooth here - you can still play by tapping the door you walk through.';
    }
  }

  // armScan must run inside the click gesture: the room auto-detect arms itself,
  // no extra tap, and it survives the await in joinGame.
  // armScan runs inside the click gesture, but only for players - a director
  // never touches Bluetooth, so the phone does not even ask for permission.
  // Ticking Director drops the Bluetooth warning; unticking brings it back.
  $('#in-director').addEventListener('change', () => {
    const warn = $('#ble-warn');
    if ($('#in-director').checked) warn.hidden = true;
    else if (!('bluetooth' in navigator)) warn.hidden = false;
  });
  $('#btn-join').addEventListener('click', () => { armForJoin(); joinGame(false); });
  $('#btn-new').addEventListener('click', () => { armForJoin(); joinGame(true); });
  $('#btn-menu').addEventListener('click', () => {
    const open = $('#menu').hidden;
    $('#menu').hidden = !open;
    $('#btn-menu').setAttribute('aria-expanded', String(open));
  });
  // A kill needs the player in the same room, so the Kill panel shows every
  // player with their room and a button that is only live for the one you are
  // standing with. An impostor does not have to work out the fog of war.
  $('#btn-kill').addEventListener('click', () => {
    const open = $('#panel-kill').hidden;
    $('#panel-kill').hidden = !open;
    if (open) renderKill();
  });
  $('#btn-menu-close').addEventListener('click', () => {
    $('#menu').hidden = true;
    $('#btn-menu').setAttribute('aria-expanded', 'false');
  });
  $('#btn-leave').addEventListener('click', leaveGame);
  $('#tg-close').addEventListener('click', closeTask);
  $('#btn-copy').addEventListener('click', async () => {
    const url = `${location.origin}/?room=${encodeURIComponent(($('#h-code').textContent || '').trim())}`;
    try { await navigator.clipboard.writeText(url); toast('Invite link copied.'); }
    catch { toast(url, null, 9000); }
  });
  $('#btn-start').addEventListener('click', () => send({ t: 'start', level: $('#sel-level').value }));
  $('#btn-reset').addEventListener('click', () => send({ t: 'reset' }));
  $('#btn-again').addEventListener('click', () => {
    // Guard against a missing snapshot: a throw here is a dead button.
    if (!S) { leaveGame(); return; }
    if (me && me.id === S.hostId) send({ t: 'reset' });
    else leaveGame();
  });
  // "Back to lobby" is the only button on the game-over card. It must ALWAYS
  // work - a host with too few players still needs to get out of the card, so
  // the shortfall is only a warning, never a block. (It used to cancel the
  // click, which stranded the host on the card.)
  $('#btn-again').addEventListener('click', () => {
    if (!S || !me || me.id !== S.hostId) return;
    const n = (S.people || []).filter((p) => p.alive).length;
    if (n < 3) toast(`Back in the lobby - you need ${3 - n} more player${3 - n === 1 ? '' : 's'} to start.`, 'bad', 6000);
  });
  $('#btn-takeover').addEventListener('click', () => send({ t: 'host' }));
  $('#btn-emergency').addEventListener('click', () => send({ t: 'emergency' }));
  $('#btn-skip').addEventListener('click', () => send({ t: 'vote', target: 'skip' }));
  $('#btn-ble').addEventListener('click', pairBeacon);
  $('#btn-scan').addEventListener('click', toggleScan);
  $('#btn-house-save').addEventListener('click', () => {
    const el = $('#house-edit');
    const h = el._house;
    if (!h) return;
    el.querySelectorAll('[data-rname]').forEach((inp) => {
      const r = h.rooms.find((x) => x.id === inp.dataset.rname);
      if (r) r.name = inp.value.trim() || r.name;
    });
    el.querySelectorAll('[data-fname]').forEach((inp) => {
      const f = h.floors.find((x) => x.id === inp.dataset.fname);
      if (f) f.name = inp.value.trim() || f.name;
    });
    if (!h.rooms.some((r) => !r.lobby)) { toast('The house needs at least one room.', 'bad'); return; }
    if (h.rooms.some((r) => !r.lobby && !h.edges.some(([a, b]) => a === r.id || b === r.id))) {
      if (!confirm('Some rooms have no doors - nobody can walk into them. Save anyway?')) return;
    }
    send({ t: 'houseSave', house: h });
    toast('House saved on the server.');
  });

  // meeting countdown + kill cooldown ticking locally
  setInterval(() => { if (S) { if (S.state === 'meeting') renderMeeting(); } }, 500);
  // kill cooldown ticks locally; the button only re-renders on a state push
  setInterval(() => { if (S && S.state === 'playing' && S.you && S.you.role === 'impostor') { renderPeople(); if (!$('#panel-kill').hidden) renderKill(); } }, 1000);
  // heartbeat so the server can tell a closed tunnel from a live phone
  // Heartbeat. Chrome and Safari both throttle timers in a backgrounded tab,
  // and the server reaps a player after 90 s of silence - which is what ended
  // a round the moment somebody switched apps. Two defences: a short timer,
  // and a ping on every wake-up (visibility, focus, pageshow, resume).
  const beat = () => { if (ws && ws.readyState === 1) send({ t: 'ping' }); };
  setInterval(beat, 15000);
  for (const ev of ['visibilitychange', 'focus', 'pageshow', 'resume', 'online']) {
    window.addEventListener(ev, () => { if (!document.hidden) beat(); });
  }
  // A phone that slept through the grace period reconnects on wake instead of
  // sitting on a dead socket.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && resumeRoom && (!ws || ws.readyState > 1)) connect(resumeRoom);
  });
  // keep screen awake during a round (iOS freezes BLE when the screen sleeps)
  document.addEventListener('visibilitychange', () => { if (!document.hidden && ws && ws.readyState === 1) { send({ t: 'ping' }); if (scanArmed) reportScan(); } });
});
