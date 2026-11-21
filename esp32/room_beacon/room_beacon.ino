/*
 * House Impostor room beacon - ESP32-C3 SuperMini (or any ESP32 board).
 * ============================================================================
 *  READY TO FLASH. Everything is pre-filled. The ONLY line you change per
 *  board is ROOM (line ~40). One board = one room.
 * ============================================================================
 *
 * Role: each board is ONE room. It advertises as "HB-<room>" (so a phone can
 * find and connect to it), lets phones write their player id to a
 * characteristic, measures each connected phone's RSSI, and POSTs the whole
 * table to the game server every 2 s. The SERVER decides which room a phone
 * is in - the board never guesses.
 *
 * Arduino IDE setup (one time):
 *   1. Boards manager: add "esp32" by Espressif (Boards manager -> install).
 *   2. Install library "NimBLE-Arduino" by h2zero (Library manager).
 *   3. Tools -> Board: "ESP32C3 Dev Module"
 *      Tools -> Partition Scheme: "Huge APP (3MB No OTA/1MB SPIFFS)"  <-- REQUIRED
 *   4. Set ROOM below to this board's room id, plug in, Upload. Repeat per room.
 *   5. Power from any 5 V USB brick - no battery, runs forever.
 *
 * Written for NimBLE-Arduino 2.x (tested against 2.5.2). The 2.x API differs
 * from 1.x: callbacks take NimBLEConnInfo&, NimBLEDevice::init() wants a
 * std::string, and RSSI is read with ble_gap_conn_rssi() (NimBLEConnInfo has
 * no getRssi()). If you install NimBLE 1.x, use the 1.x branch of this file.
 *
 * RSSI comes from the board's own antenna, at a fixed, calibrated spot, and
 * phones cannot fake what they do not know is being measured - that is the
 * whole anti-cheat story of this game.
 *
 * ----------------------------------------------------------------------------
 *  ROOM IDs - pick ONE per board (must match house.json exactly):
 *
 *    bed1  = Cuba Bedroom (f2)        down  = TV Room (f1)
 *    bed2  = Bama Bedroom (f2)        land1 = Stair landing (f1)
 *    bath  = Bathroom (f2)            room  = Livingroom/Dining Room (f1)
 *    land2 = Top landing (f2)         room2 = Kitchen (f1)
 *    base1 = Basement room 1 (f0)     land0 = Basement landing (f0)
 *    base2 = Basement room 2 (f0)     lobby = Lobby / you are out (out)
 * ----------------------------------------------------------------------------
 */
#include <WiFi.h>
#include <HTTPClient.h>
#include <NimBLEDevice.h>
#include <map>
#include <string>
#include <mutex>

// ---- shared values: identical on every board, do not change -----------------
const char* WIFI_SSID  = "mclean-2.4";      // 2.4 GHz only - ESP32 cannot see 5 GHz
const char* WIFI_PASS  = "9177476979";
// Server URL. MUST be the domain, not the raw IP: the box serves ~40 sites
// from one IP, so nginx only routes us to the game if the HTTP Host header is
// the vhost name. ESP32's HTTPClient IGNORES addHeader("Host", ...) and always
// sends Host = the host part of this URL, so the URL itself must be the domain.
const char* SERVER_URL = "http://amongus.cubamclean.com/api/beacon";
const char* BEACON_KEY = "house";           // must match BEACON_KEY on the server
// ----------------------------------------------------------------------------

const char* ROOM       = "bed1";            // <<< CHANGE THIS PER BOARD (see table above)

const char* DEV_NAME   = "HB-";             // prefix; full name = HB-<ROOM>

// player ids that phones wrote to us: connection handle -> "p1a2b3..."
struct Peer { String id; int rssi; uint32_t seen; };
static std::map<uint16_t, Peer> peers;
static std::mutex peersMx;   // BLE callbacks run on the NimBLE task, loop() on the other

class ServerCB : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer* s, NimBLEConnInfo& info) override {
    std::lock_guard<std::mutex> g(peersMx);
    peers[info.getConnHandle()] = Peer{ "", -120, 0 };
    Serial.printf("BLE connected (handle %u)\n", info.getConnHandle());
  }
  void onDisconnect(NimBLEServer* s, NimBLEConnInfo& info, int reason) override {
    std::lock_guard<std::mutex> g(peersMx);
    peers.erase(info.getConnHandle());
    Serial.printf("BLE disconnected (handle %u)\n", info.getConnHandle());
  }
};

class WriteCB : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* c, NimBLEConnInfo& info) override {
    String v = String(c->getValue().c_str());
    std::lock_guard<std::mutex> g(peersMx);
    auto it = peers.find(info.getConnHandle());
    if (v.startsWith("iam:") && it != peers.end()) {
      it->second.id = v.substring(4);
      it->second.seen = millis();
      Serial.printf("phone -> %s\n", it->second.id.c_str());
    }
  }
};

static NimBLECharacteristic* idChar;

void setup() {
  Serial.begin(115200);
  delay(300);
  String fullName = String(DEV_NAME) + ROOM;

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.println("wifi...");
  while (WiFi.status() != WL_CONNECTED) { delay(400); Serial.print("."); }
  Serial.printf("\nwifi ok, %s\n", WiFi.localIP().toString().c_str());

  NimBLEDevice::init(std::string(fullName.c_str()));
  NimBLEServer* server = NimBLEDevice::createServer();
  server->setCallbacks(new ServerCB());
  // NimBLE defaults advertiseOnDisconnect to FALSE: after the first phone
  // disconnects the board silently stops advertising and never comes back, so
  // it becomes invisible to every later pairing. Keep advertising for the
  // lifetime of the board instead.
  server->advertiseOnDisconnect(true);
  NimBLEService* svc = server->createService("FFE0");
  idChar = svc->createCharacteristic("FFE1", NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::READ);
  idChar->setCallbacks(new WriteCB());
  svc->start();
  // advertise as a plain BLE peripheral with the room in its name.
  // IMPORTANT: NimBLEDevice::init(name) only sets the GAP name ATTRIBUTE - it
  // does NOT put the name in the advertising packet, and startAdvertising()
  // does not add it either. Without adv->setName() the board advertises with
  // NO name at all, so a chooser filtering on namePrefix "HB-" (beacio/Chrome)
  // finds nothing and the phone can never connect. Set it explicitly here.
  NimBLEAdvertising* adv = NimBLEDevice::getAdvertising();
  adv->setName(fullName.c_str());
  adv->addServiceUUID("FFE0");          // so service filters also match
  NimBLEDevice::startAdvertising();
  Serial.printf("advertising as %s\n", fullName.c_str());
}

static unsigned long lastPost = 0;

void loop() {
  delay(250);
  if (millis() - lastPost < 2000) return;
  lastPost = millis();

  // ask the BLE stack for each connection's RSSI, then build the payload.
  // peers is a JSON ARRAY (the server does Array.isArray(body.peers)); using
  // braces here produced invalid double-braced JSON and a 400.
  String peersJson = "[";
  bool first = true;
  {
    std::lock_guard<std::mutex> g(peersMx);
    for (auto& kv : peers) {
      if (kv.second.id.length() == 0) continue;
      int8_t rssi = 0;
      if (ble_gap_conn_rssi(kv.first, &rssi) == 0) kv.second.rssi = rssi;
      else if (millis() - kv.second.seen > 15000) continue;
      if (!first) peersJson += ",";
      first = false;
      peersJson += "{\"p\":\"" + kv.second.id + "\",\"r\":" + String(kv.second.rssi) + "}";
    }
  }
  peersJson += "]";
  String body = "{\"beacon\":\"" + String(ROOM) + "\",\"peers\":" + peersJson + "}";

  HTTPClient http;
  http.begin(SERVER_URL);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-beacon-key", BEACON_KEY);
  // NOTE: addHeader("Host", ...) is IGNORED by HTTPClient - it always sends
  // Host = the host part of SERVER_URL. That is why SERVER_URL must be the
  // domain (above), or nginx answers from its default site with a 404.
  int code = http.POST(body);
  Serial.printf("post %s -> %d %s\n", ROOM, code, body.c_str());
  http.end();

  if (WiFi.status() != WL_CONNECTED) WiFi.reconnect();
}
