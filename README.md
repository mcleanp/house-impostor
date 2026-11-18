# House Impostor

Live-action Among Us **inside your house**. No GPS indoors (it cannot tell a
bedroom from a bathroom, let alone a floor). Instead the house is a **graph of
rooms joined by doors**, and the server — never the phone — decides who is
where:

- **Rooms & floors** are a table (`house.json`). A room *knows* its floor, so
  elevation is a lookup, not a measurement. Your layout is pre-loaded: 3
  floors, 9 playable rooms + a lobby, stairs as landing-to-landing edges.
- **Movement**: you may only move to a room with a door to your current one,
  3 s per door. No teleporting from basement to attic. This is why the
  hallways/stairs exist in the map.
- **Locating players**: two ways, and they combine.
  1. *Tap the door you walked through* — works in **every** browser, iPhone
     Safari included, zero hardware.
  2. *BLE beacons* — one ESP32 board per room (~$4, USB-powered). The board
     measures **your phone's** signal and posts it to the server; the server
     picks the room. Phones cannot lie about a measurement they cannot see.
     RSSI must clear −92 dBm **and** beat the runner-up by 5 dB or the room
     does not flip — that is the "which floor am I really on" referee.
- **Levels**: whole house, top floor only, downstairs only, basement only.
- **Open-plan note**: radio waves ignore furniture, so one big
  kitchen/dining/living space is **one room** in the map. Tasks (chores at
  exact spots) give it texture; zones decide kills.

## Play

- Host opens the site → "New house" → everyone else joins with the 4-letter
  code. Pick a level → Start. Roles dealt server-side.
- Crew: do 4 chores (press-and-hold 5 s **while the server believes you are in
  that room**). Impostor: kills need the same room, 45 s cooldown; fakes tasks.
- Dead walk to the lobby. Bodies get reported; meetings are 45 s, majority
  ejects. `?director=1` spectates everything.
- **Host setup → "Edit house"**: add/rename/delete floors, rooms and doors,
  add/delete chores. Each room row has **two** text boxes: the **id** (lowercase,
  editable anytime — renaming it moves its doors, chores and beacon cal with it;
  it's also the BLE name `HB-<id>`, so re-flash that room's ESP32 after a rename)
  and the display name. Deleting a room takes its doors and chores with it; the
  server rejects duplicate ids/doors, self-doors and anything pointing at a room
  that no longer exists. Save writes `house.json` and everyone's floorplan
  updates live.
- **Multiple games at once**: every "New house" is its own game room (4-letter
  code); they all share the one house map. `/admin.html` (asks for the admin
  key, default `house`, same as the beacon key) lists every live game — code,
  state, players, host — with join/watch links, refreshing every 5 s.
- Fog of war: you only see people in your room.

## iPhone caveat, stated plainly

Web Bluetooth is **not** in any iOS browser (Apple has not shipped it as of
2026). iPhone players either tap doors (fully playable) or open the same URL
in the free **Bluefy** browser, which has Web Bluetooth, to get beacon
tracking. Android: Chrome works as-is. iOS freezes BLE when the screen sleeps
— keep the screen on during a round.

## Files

```
server.js       authoritative engine: rooms, graph, RSSI, roles, tasks, votes
house.json      the house: rooms/floors/doors/levels/tasks (host can edit in-game)
public/         index.html app.js style.css config.js (no build step)
esp32/room_beacon/room_beacon.ino   beacon firmware (Arduino IDE, NimBLE-Arduino)
sim.js          28 headless checks: fake phones + fake beacons vs a real server
deploy-on-box.sh  idempotent deploy for the aaPanel box
```

## Run

```
PORT=8322 node server.js
node sim.js          # spawns its own server on :8399
```

## Deploy (aaPanel box, done this way already)

```
tar czf house-among.tgz -C /srv/slchat/ws/u3/c167 house-among
# scp via jumpbox to root@192.168.1.7, then:
tar xzf house-among.tgz -C /tmp && bash /tmp/house-among/deploy-on-box.sh
```

The script installs everything **into the aaPanel site folder itself**
(`/www/wwwroot/amongus.cubamclean.com`, the vhost root — same folder as the
old project, visible in the panel's file manager): `public/*` at the root plus
`server.js`, `house.json`, `sim.js`, `esp32/` alongside. It bumps asset `?v=`
hashes (the vhost caches `.js` 12 h and Cloudflare happily caches that),
installs systemd unit `house-among` (port 8322, paths inside the site folder),
drops the WebSocket/beacon proxy into aaPanel's **extension dir** (never edits
the vhost), verifies `/`, `/api/rules`, `/health` and a real `101` upgrade.

## Beacon setup (later, optional)

1. Arduino IDE + esp32 board package + NimBLE-Arduino library.
2. In `room_beacon.ino`: WiFi creds, `SERVER_URL = http://192.168.1.7/api/beacon`,
   `ROOM = "bed1"` (one per board). Flash, plug into a USB brick, place in the room.
3. The Setup screen lists beacons reporting in within seconds.
4. Players running Chrome/Bluefy tap "Pair my beacons" once per nearby beacon.
