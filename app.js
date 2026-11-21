/* House Impostor client. Renders whatever the server last said; sends only
   intents (move / task / kill / vote / start). No build step, no framework. */
'use strict';

const $ = (s) => document.querySelector(s);
const CFG = window.CFG || {};
let ws = null, me = null, S = null;   // S = last server snapshot
let holdTimer = null, holdTask = null, holdAt = 0, meetingSounded = false;
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
    toast('Disconnected - retrying...', 'bad');
    setTimeout(() => connect(code), reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.6, 15000);
  };
  ws.onopen = () => { reconnectDelay = 800; };
}

// Leave on purpose: drop the stored id so we come back as a new player, and
// forget the room so a reload shows the join screen.
function leaveGame() {
  try { localStorage.removeItem('hi-pid'); localStorage.removeItem('hi-room'); } catch {}
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
      autoReconnectBeacons();   // silently re-attach to beacons this phone already paired
      if (!scanArmed) armScan();   // re-arm the room scan after a refresh
      break;
    case 'state': S = m; render(); break;
    case 'died':
      toast(`You are dead. Walk to the lobby. (${m.room})`, 'bad', 8000);
      if ('vibrate' in navigator) navigator.vibrate([200, 100, 200]);
      blip('kill');
      break;
    case 'nope': toast(m.text, 'bad'); break;
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

  $('#scr-meeting').hidden = S.state !== 'meeting';
  if (S.state === 'meeting') renderMeeting();
  const over = S.state === 'over';
  $('#scr-over').hidden = !over;
  if (over) renderOver();

  const playing = S.state === 'playing' && you.alive && !me.director;
  // Pairing must work BEFORE the round: the beacon only reports a room once a
  // phone is connected to it, so the lobby is exactly when you need this.
  const canPair = S.state === 'lobby' || S.state === 'over' || playing;
  $('#panel-actions').hidden = !canPair;
  $('#btn-report').hidden = !playing;
  $('#btn-emergency').hidden = !playing;
  $('#btn-report').disabled = !(S.bodies || []).some((b) => b.room === you.room);
  $('#btn-emergency').disabled = !you.emergencyLeft;
}

function renderFloorplan() {
  const you = S.you || {};
  const fp = $('#floorplan');
  fp.innerHTML = '';
  const here = you.room;
  for (const f of S.house.floors) {
    const rooms = S.house.rooms.filter((r) => r.floor === f.id);
    if (!rooms.length) continue;
    const div = document.createElement('div');
    div.className = 'floor';
    const row = rooms.map((r) => {
      const people = (S.people || []).filter((p) => p.room === r.id);
      const bodies = (S.bodies || []).filter((b) => b.room === r.id);
      const dots = people.map((p) =>
        `<span title="${esc(p.name)}${p.alive ? '' : ' (out)'}" style="${p.id === me.id ? 'filter:drop-shadow(0 0 4px #ffd23f)' : ''}">${crew(p.id, !p.alive)}</span>`).join('');
      const locked = you.moveTo && !you.moveTo.includes(r.id) && r.id !== here && !r.lobby && S.state === 'playing';
      return `<div class="room ${r.id === here ? 'here' : ''} ${locked ? 'locked' : ''}" data-r="${esc(r.id)}">
        <span class="nm">${esc(r.name)}</span>${bodies.length ? '<span class="body">💀</span>' : ''}
        <div class="dots">${dots}</div></div>`;
    }).join('');
    div.innerHTML = `<b>${esc(f.name)}</b><div class="floors-row">${row}</div>`;
    fp.appendChild(div);
  }
}

function renderPeople() {
  const you = S.you || {};
  const here = (S.people || []).filter((p) => p.room === you.room && p.id !== me.id);
  const el = $('#people');
  el.innerHTML = here.length
    ? here.map((p) => `<div class="person"><span class="who">${crew(p.id, !p.alive)}${esc(p.name)} ${p.alive ? '' : '(down)'}${p.role ? ` <i>${p.role}</i>` : ''}</span>
        ${you.role === 'impostor' && p.alive && you.alive ? `<button class="danger" data-kill="${p.id}">Kill</button>` : ''}</div>`).join('')
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
  $('#panel-people').hidden = me.director ? false : !(here.length || mv.children.length || you.beaconRoom);
}

function renderTasks() {
  const you = S.you || {};
  const list = you.tasks || [];
  $('#panel-tasks').hidden = !(list.length && S.state === 'playing' && you.alive);
  $('#holdhint').textContent = `hold ${(window.RULES ? RULES.TASK_HOLD_S : 5)}s, in the room`;
  $('#tasks').innerHTML = list.map((t) => `
    <div class="task ${t.done ? 'done' : ''}">
      <span class="nm">${esc(t.name)} <span class="sub">@ ${esc(roomName(t.room))}</span></span>
      ${t.done ? '<span>✔</span>' : `<button data-hold="${t.id}">Hold</button>`}
    </div>`).join('');
  $('#tasks').querySelectorAll('[data-hold]').forEach((b) => {
    const id = b.dataset.hold;
    const start = (e) => {
      e.preventDefault();
      if (holdTask) return;
      holdTask = id; holdAt = Date.now();
      b.classList.add('holding');
      send({ t: 'taskStart', id });
      holdTimer = setInterval(() => {
        const left = Math.max(0, (window.RULES ? RULES.TASK_HOLD_S : 5) - (Date.now() - holdAt) / 1000);
        b.textContent = left.toFixed(1) + 's';
      }, 100);
    };
    const stop = () => {
      if (holdTask !== id) return;
      clearInterval(holdTimer);
      b.classList.remove('holding');
      b.textContent = 'Hold';
      holdTask = null;
      send({ t: 'taskDone', id });
    };
    b.addEventListener('pointerdown', start);
    b.addEventListener('pointerup', stop);
    b.addEventListener('pointercancel', stop);
    b.addEventListener('pointerleave', stop);
  });
}

function renderMeeting() {
  const you = S.you || {};
  $('#m-timer').textContent = Math.max(0, Math.ceil((S.meetingEnds - Date.now()) / 1000));
  $('#m-votes').textContent = `votes in: ${S.votes ? S.votes.cast : 0} / ${S.votes ? S.votes.of : 0}`;
  const cands = (S.people || []).filter((p) => p.alive && p.id !== me.id && !p.__ghost);
  $('#vote').innerHTML = you.alive
    ? cands.map((p) => `<div class="person"><span class="who">${crew(p.id, !p.alive)}${esc(p.name)}</span><button data-vote="${p.id}">Vote</button></div>`).join('')
    : '<p class="sub">The dead may listen but not vote.</p>';
  $('#vote').querySelectorAll('[data-vote]').forEach((b) => b.addEventListener('click', () => send({ t: 'vote', target: b.dataset.vote })));
}

function renderOver() {
  const first = (S.events || []).slice().reverse().find((e) => e.type === 'over');
  $('#over-title').textContent = first ? first.text : 'Round over';
  $('#over-roles').innerHTML = (S.people || []).map((p) =>
    `<div class="person"><span class="who">${crew(p.id, !p.alive)}${esc(p.name)}</span><span>${p.role || ''} ${p.alive ? '' : '(out)'}</span></div>`).join('');
  $('#btn-again').hidden = me.id !== S.hostId;
}

function renderFeed() {
  $('#events').innerHTML = (S.events || []).slice().reverse().map((e) => `<div>${esc(e.text)}</div>`).join('');
}

function renderSetup() {
  const isHost = me.id === S.hostId && !me.director;
  $('#panel-setup').hidden = !(isHost && (S.state === 'lobby' || S.state === 'over'));
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
      '<h2>Tasks</h2><div id="he-tasks"></div><button id="he-add" class="ghost">+ task</button>';

    const drawAll = () => { drawFloors(); drawRooms(); drawDoors(); drawTasks(); };

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
        <button data-tdel="${i}" class="ghost">✕</button></div>`).join('');
      el.querySelectorAll('[data-task]').forEach((inp) => inp.addEventListener('change', () => { h.tasks[+inp.dataset.task].name = inp.value; }));
      el.querySelectorAll('[data-troom]').forEach((s) => s.addEventListener('change', () => { h.tasks[+s.dataset.troom].room = s.value; }));
      el.querySelectorAll('[data-tdel]').forEach((b) => b.addEventListener('click', () => { h.tasks.splice(+b.dataset.tdel, 1); drawTasks(); }));
    };
    $('#he-add').addEventListener('click', () => {
      const rooms = playRooms();
      if (!rooms.length) { toast('Add a room first.', 'bad'); return; }
      h.tasks.push({ room: rooms[0].id, name: 'New chore' }); drawTasks();
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
let lastReportAt = 0, tapTimer = null;

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
  try { fetch('/api/diag', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(o) }); } catch {}
}

// Arm once (needs a user gesture): attach the advertisement listener and start
// watching. From then on we just re-report what we hear on a timer - no more
// choosers. The phone never connects to a beacon.
async function armScan() {
  const st = $('#ble-status');
  if (!navigator.bluetooth) { st.textContent = 'No Web Bluetooth here. iPhone: turn on the free "beacio" Safari extension (steps on the join screen).'; return; }
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
      let devs = [];
      if (navigator.bluetooth.getDevices) {
        try { devs = (await navigator.bluetooth.getDevices()).filter((d) => (d.name || '').startsWith(CFG.BLE_PREFIX || 'HB-')); } catch {}
      }
      for (const d of devs) {
        if (typeof d.watchAdvertisements !== 'function') continue;
        d.addEventListener('advertisementreceived', onAdvert);
        try { await d.watchAdvertisements(); watching++; } catch (e) { watchErr = (e && e.name) + ':' + (e && e.message); }
      }
      if (navigator.bluetooth.requestDevice) {
        try {
          const tPick = Date.now();
          const d = await navigator.bluetooth.requestDevice({ filters: [{ namePrefix: CFG.BLE_PREFIX || 'HB-' }] });
          pickMs = Date.now() - tPick;
          devs.push(d); usedChooser = true;
          if (typeof d.watchAdvertisements === 'function') {
            d.addEventListener('advertisementreceived', onAdvert);
            try { await d.watchAdvertisements(); watching++; } catch (e) { watchErr = (e && e.name) + ':' + (e && e.message); }
          }
        } catch (e) { pickErr = (e && e.name) + ':' + (e && e.message); }
      }
      scanDevs = devs;
      devNames = devs.map((d) => d.name || '(noname)');
      if (!watching && navigator.bluetooth.requestLEScan) {
        navigator.bluetooth.addEventListener('advertisementreceived', onAdvert);
        lescan = await navigator.bluetooth.requestLEScan({ acceptAllAdvertisements: true });
        watching = 1;
      }
      if (!watching) { diag({ ev: 'arm-none', devs: devNames.length, watchErr }); st.textContent = 'this browser cannot scan - tap "Pair my beacons" once instead.'; return; }
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
  scanArmed = false;
  clearInterval(sampleTimer);
  try { if (lescan && lescan.stop) lescan.stop(); } catch {}
  lescan = null;
  $('#ble-status').textContent = 'scan off.';
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
  reportScan();
}

function toggleScan() { if (scanArmed) disarmScan(); else armScan(); }

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
  if (!('bluetooth' in navigator)) {
    $('#ble-warn').hidden = false;
    if (iOS) {
      $('#ble-warn').innerHTML =
        '<b>iPhone / iPad: one-time setup for automatic room detection.</b><br>' +
        '1. Install the free <b>beacio</b> extension from the App Store (<a href="https://apps.apple.com/us/app/beacio/id6761301368" target="_blank" rel="noopener">open it</a>).<br>' +
        '2. Settings &gt; Apps &gt; Safari &gt; Extensions &gt; beacio &gt; turn on <b>Allow Extension</b>, then under Permission choose <b>Other Websites &gt; Allow</b>.<br>' +
        '3. Or in Safari: tap the <b>aA</b> button in the address bar &gt; Manage Extensions &gt; beacio on &gt; Done, then tap <b>aA</b> &gt; beacio &gt; <b>Allow on Every Website</b>.<br>' +
        '4. Reload this page. iOS asks once to let beacio use Bluetooth - tap <b>Allow</b>.<br>' +
        'No extension? Tapping the doors still plays fine.';
    } else {
      $('#ble-warn').textContent = 'No Web Bluetooth here - you can still play by tapping the door you walk through.';
    }
  }

  // armScan must run inside the click gesture: the room auto-detect arms itself,
  // no extra tap, and it survives the await in joinGame.
  $('#btn-join').addEventListener('click', () => { armScan(); joinGame(false); });
  $('#btn-new').addEventListener('click', () => { armScan(); joinGame(true); });
  $('#btn-menu').addEventListener('click', () => {
    const open = $('#menu').hidden;
    $('#menu').hidden = !open;
    $('#btn-menu').setAttribute('aria-expanded', String(open));
  });
  $('#btn-menu-close').addEventListener('click', () => {
    $('#menu').hidden = true;
    $('#btn-menu').setAttribute('aria-expanded', 'false');
  });
  $('#btn-leave').addEventListener('click', leaveGame);
  $('#btn-copy').addEventListener('click', async () => {
    const url = `${location.origin}/?room=${encodeURIComponent(($('#h-code').textContent || '').trim())}`;
    try { await navigator.clipboard.writeText(url); toast('Invite link copied.'); }
    catch { toast(url, null, 9000); }
  });
  $('#btn-start').addEventListener('click', () => send({ t: 'start', level: $('#sel-level').value }));
  $('#btn-reset').addEventListener('click', () => send({ t: 'reset' }));
  $('#btn-again').addEventListener('click', () => send({ t: 'reset' }));
  $('#btn-report').addEventListener('click', () => send({ t: 'report' }));
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
  // heartbeat so the server can tell a closed tunnel from a live phone
  setInterval(() => { if (ws && ws.readyState === 1) send({ t: 'ping' }); }, 25000);
  // keep screen awake during a round (iOS freezes BLE when the screen sleeps)
  document.addEventListener('visibilitychange', () => { if (!document.hidden && ws && ws.readyState === 1) { send({ t: 'ping' }); if (scanArmed) reportScan(); } });
});
