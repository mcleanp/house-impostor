# ESP32-C3 Room Beacon Setup

Each ESP32-C3 board is ONE room. It advertises as `HB-<roomid>` (lowercase, no spaces), lets phones write their player id to it via BLE, measures each phone's RSSI, and POSTs the whole table to the game server every 2 s.

## Prerequisites

- ESP32-C3 SuperMini board
- 5 V USB power brick (any phone charger works — no battery, runs forever)
- WiFi network that the ESP32 and your phones both see (2.4 GHz only — 5 GHz doesn't show up on BLE)
- Computer with Arduino IDE installed (Windows/Mac/Linux)

## 1. Arduino IDE Setup (one time)

### 1.1 Install the ESP32 board package

1. Open Arduino IDE → **File → Preferences**
2. In **Additional Boards Manager URLs**, add:
   ```
   https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json
   ```
3. Click **OK**
4. Go to **Tools → Board → Boards Manager**
5. Search for **esp32** and install the latest by Espressif
6. Restart Arduino IDE

### 1.2 Install NimBLE-Arduino library

1. Go to **Sketch → Include Library → Manage Libraries**
2. Search for **NimBLE-Arduino** by h2zero
3. Install the latest version

### 1.3 Select the right board

1. **Tools → Board → ESP32 Arduino → ESP32C3 Dev Module** — you MUST pick this
   by hand. Do not trust the board name the IDE shows next to the port.
2. **Tools → Partition Scheme → Huge APP (3MB No OTA/1MB SPIFFS)** — required.
   The sketch is ~1.3 MB and does not fit the default 1.2 MB app partition.
3. **Tools → USB CDC On Boot → Enabled** — recommended. With this on, the
   Serial Monitor shows the board's live output (`post bed1 -> 200 ...`) over
   USB. With it off, the app's `Serial` goes to the UART pins instead and the
   USB Serial Monitor looks dead even though the board is working fine.

> **The "This chip is ESP32-C3, not ESP32-S3" upload error.**
> The ESP32-C3 SuperMini's USB port reports itself with the *generic* Espressif
> USB ID `0x303A:0x1001`. In the ESP32 board package, the one board definition
> that claims that exact ID is **Ozobot DRVKit** — which is an **ESP32-S3**
> board. So the IDE auto-detects your C3 as an "Ozobot DRVKit", compiles for the
> S3, and then esptool refuses to flash the S3 image onto the C3 chip. The
> `sketch.yaml` file next to the sketch does **not** override this in IDE 2.3.10.
> Fix: **Tools → Board → ESP32C3 Dev Module** (then Partition + CDC as above).
> You can tell it is wrong by the size: an S3 build prints
> `Sketch uses 1184378 bytes (37%)`; the correct C3 build prints
> `Sketch uses 1335121 bytes (42%)`.

## 2. Configure the sketch for your room

Open the file at `esp32/room_beacon/room_beacon.ino` (you can copy it to your computer if you like).

The WiFi name/password, server URL and beacon key are **already filled in** — do NOT change them. The ONLY line you edit per board is `ROOM`:

```cpp
const char* WIFI_SSID  = "mclean-2.4";      // already set - leave it
const char* WIFI_PASS  = "9177476979";      // already set - leave it
const char* SERVER_URL = "http://amongus.cubamclean.com/api/beacon";  // already set - leave it
const char* BEACON_KEY = "house";           // already set - leave it
const char* ROOM       = "bed1";            // ← CHANGE THIS per board (lowercase, no spaces)
```

Valid `ROOM` ids are listed in the comment block at the top of the sketch (bed1, bed2, bath, land2, down, land1, room, room2, base1, base2, land0, lobby).

What each means:

| constant | purpose |
|---|---|
| `WIFI_SSID` / `WIFI_PASS` | Your home WiFi (2.4 GHz). ESP32 cannot use 5 GHz. |
| `SERVER_URL` | The game URL (amongus.cubamclean.com). **Must be the domain, not the IP** — the box serves many sites from one IP, and the ESP32's HTTPClient always sends `Host:` = this URL's host, so only the domain reaches the game vhost. |
| `BEACON_KEY` | Must match the `BEACON_KEY` on the server (default `house`). |
| `ROOM` | The room id from your house.json (e.g., `bed1`, `office`, `base1`). **This is the beacon name** — the board advertises as `HB-<ROOM>`. |

The ESP32 will connect to WiFi, start advertising `HB-<ROOM>`, and POST every 2 s to `/api/beacon` with `Host: amongus.cubamclean.com` so nginx routes it correctly. The server uses the `ROOM` to reject/accept the beacon POST.

## 3. Flash the board

1. Connect the ESP32-C3 via USB:
   - **GND** → USB GND
   - **3V3** → USB 5V (do not use VIN — it's 5 V but some boards need a better source)
   - **GPIO 4** → GPIO 0 (boot mode) — press and hold this button while powering on to enter bootloader, then release
2. In Arduino IDE: **Sketch → Upload**

You should see:
```
wifi...
wifi ok, 192.168.1.XXX
advertising as HB-bed1
post bed1 -> 200 {"r":"ok"}
```

> **After uploading, the board can sit in download mode and look dead.**
> The uploader ends by resetting the board *through the USB-JTAG*, and on this
> chip that reset can leave it parked in the ROM bootloader (`waiting for
> download`) instead of running your sketch — no Serial output, no WiFi, no
> POSTs. It is not a bad flash. To get it running, either:
> - **press the board's RST button once** (or unplug and replug the USB), or
> - power-cycle it.
> Then it boots into the app (`boot:0xd SPI_FAST_FLASH_BOOT`) and starts
> posting. If you ever need to force it from a computer, esptool's
> `--after watchdog-reset` reboots it into run mode without touching the boot
> strap pin.

If you see `wifi FAIL`, check:
- Your WiFi SSID/password is correct (no spaces in SSID)
- Your phone and ESP32 are on the same network (2.4 GHz only)
- You're not using a network with captive portal/login (e.g., Starbucks) — the ESP32 cannot do that

## 4. Verify the beacon is advertising

### Option 0 — watch it with your own eyes (Serial Monitor)

With **USB CDC On Boot → Enabled** (step 1.3), open **Tools → Serial Monitor**,
set baud to **115200**, and press the board's **RST** button. You should see:

```
wifi...
wifi ok, 192.168.1.238
advertising as HB-bed1
post bed1 -> 200 {"beacon":"bed1","peers":{}}
post bed1 -> 200 {"beacon":"bed1","peers":{}}
```

`post ... -> 200` every 2 s = the board is talking to the server. `401` = wrong
key, `404` = wrong URL (see troubleshooting), nothing at all = CDC is off.

If you see `post bed1 -> 401`, your `BEACON_KEY` in the sketch doesn't match the server's (`house`). Change it and reflash.

### Option A — From the server (no board needed)

SSH into the aaPanel box and run:

```bash
curl -sk -m 6 -H "Host: amongus.cubamclean.com" -H "x-beacon-key: house" -H "content-type: application/json" -d '{"beacon":"bed1","peers":[]}' https://127.0.0.1/api/beacon
```

You should see `{"r":"ok"}`. If you see `401`, your beacon POST is being rejected (wrong key).

### Option B — From the game

Open `https://amongus.cubamclean.com`. The home screen has a live line
`beacons reporting in: ...`.

**Important:** the board's bare POST is not enough to show here — the server
only counts a beacon once a **phone is connected to it** (that is how it
measures RSSI). So:

1. On your phone, open the game and tap **Pair my beacons** (see section 7).
2. Connect to the board's `HB-bed1` entry.
3. The home screen now shows `beacons reporting in: Cuba Bedroom`, and the
   board's Serial Monitor shows your phone id and its RSSI in the POST body.

If nothing shows, the phone isn't connected — the board alone posts an empty
`peers:{}` and the server has no RSSI to report yet.

## 5. Placement

- **Power**: USB brick, plugged into a wall outlet (not a powered USB hub) — the ESP32 draws ~120 mA, some hubs can't sustain it.
- **Height**: ~1–1.5 m from the floor, near where people stand (not behind a TV or inside a closet).
- **Orientation**: any — the antenna is omnidirectional.
- **No metal**: keep it away from thick metal, microwaves, and big metal appliances — they block BLE.

If a phone sees a beacon RSSI around `-70 dBm` or worse, move it closer and reflash.

## 6. Multiple boards

Repeat steps 2–4 for each room. The only thing you change per board is the `ROOM` id:

| board | ROOM value in sketch |
|---|---|
| Cuba Bedroom (f2) | `bed1` |
| Bama Bedroom (f2) | `bed2` |
| Bathroom (f2) | `bath` |
| Top landing (f2) | `land2` |
| TV Room (f1) | `down` |
| Stair landing (f1) | `land1` |
| Livingroom/Dining Room (f1) | `room` |
| Kitchen (f1) | `room2` |
| Basement room 1 (f0) | `base1` |
| Basement room 2 (f0) | `base2` |
| Basement landing (f0) | `land0` |
| Lobby / you are out | `lobby` |

All boards advertise their own unique name (`HB-bed1`, `HB-bed2`, etc.). The server maps each beacon POST to the room it claims to be, so it's impossible for a phone to claim it's in a different room by sending the wrong beacon POST.

## 7. Pairing with phones

### Android (Chrome)

1. Open `https://amongus.cubamclean.com` in Chrome
2. Tap **Pair my beacons** (under Host setup)
3. The browser asks for Bluetooth access — allow it
4. The Setup screen lists all beacons that are advertising
5. Tap each beacon to "pair" it with your phone (this just establishes the BLE connection; no pairing PIN needed)
6. The server now measures RSSI from YOUR phone and can place you in that room

### iPhone (Safari)

1. Open `https://amongus.cubamclean.com` in Safari
2. Tap **Pair my beacons**
3. Safari shows "No Web Bluetooth in this browser" — that's expected
4. Install the free **Bluefy** browser from the App Store
5. Open the same URL in Bluefy and tap **Pair my beacons**
6. Bluefy has Web Bluetooth, so you'll see your beacons listed
7. Tap each to pair

### Important notes

- **Keep the screen on** during a round — iOS freezes BLE when the screen sleeps (Bluefy too)
- **One pairing per beacon per phone** — tap each beacon once, then they're paired for that game
- If you don't pair, the game still works — you just tap the door you walked through instead of BLE auto-detect

## 8. Troubleshooting

| symptom | check |
|---|---|
| `wifi FAIL` | WiFi SSID/password correct? 2.4 GHz only? |
| `post bed1 -> 401` | `BEACON_KEY` in sketch = `house`? |
| `post bed1 -> 502` | aaPanel box is up? `192.168.1.7` reachable? |
| No beacons appear in Setup | ESP32 advertising? Check Serial Monitor. |
| RSSI too weak (`< -85 dBm`) | Move ESP32 closer, avoid metal/obstructions. |
| Phone auto-places in wrong room | Phone moved away from beacon — tap the door you walked through. The server only flips rooms when RSSI clears `-92 dBm` and beats the runner-up by 5 dB, so ambiguous readings do NOT flip. |

## 9. Optional: calibration

Some rooms are bigger or have thick walls. If your phone consistently shows `-85 dBm` instead of the expected `-60 dBm` at 1 m, you can add a per-room `cal` offset in `house.json`:

```json
{
  "beacons": [
    { "room": "bed1", "cal": -20 },
    { "room": "office", "cal": 0 }
  ]
}
```

Higher `cal` means the server subtracts that many dBm when comparing RSSI (so a weaker reading becomes stronger). This is **optional** and only needed if you measured actual distances and want to tune the thresholds. The default (no `cal`) works for most houses.

---

That's it — one ESP32 per room, same sketch, different `ROOM` value per board. Flash, plug in, and the beacons show up in the Setup screen within seconds. Once paired, the server measures your RSSI from each beacon and decides which room you're really in — the only way to know for sure indoors.
