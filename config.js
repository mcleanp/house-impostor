/* Client config. Everything here is public - the server holds the truth. */
window.CFG = {
  BLE_PREFIX: 'HB-',   // advertised name of the ESP32 room beacons
  BLE_SERVICE: '0xffe0', // GATT service the beacon exposes (0xffe0 = full UUID ...-ffe0-...)
  BLE_CHAR: '0xffe1',    // write-only characteristic: we send "iam:<player id>"
  SCAN_MS: 6000,       // how long one scan window runs (ms)
  SCAN_EVERY_MS: 8000, // gap between automatic scans while the screen is awake
  SCAN_WATCHDOG_MS: 12000, // silence this long -> the scan has died, restart it
};
