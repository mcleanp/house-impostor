#!/usr/bin/env bash
# Run ON the aaPanel box from the extracted project folder:
#   tar xzf house-among.tgz -C /tmp && bash /tmp/house-among/deploy-on-box.sh
# Installs everything into the aaPanel site folder itself (the vhost root),
# exactly where the panel's file manager shows it. Idempotent; rolls nginx
# back if the include fails `nginx -t`.
set -uo pipefail

SITE=amongus.cubamclean.com
ROOT=/www/wwwroot/$SITE            # the vhost root - same folder as always
SRC=$(cd "$(dirname "$0")" && pwd) # where this script lives (extracted project)
PORT=8322
SVC=house-among
EXT=/www/server/panel/vhost/nginx/extension/$SITE
INC=$EXT/websocket.conf

echo "== 1. files into $ROOT =="
[ -f "$SRC/server.js" ] || { echo "   FAIL: $SRC/server.js missing"; exit 1; }
# the repo tree is flat (web client at the root); older tarballs nested it in public/
if [ -d "$SRC/public" ]; then WEB="$SRC/public"; else WEB="$SRC"; fi
[ -f "$WEB/index.html" ] || { echo "   FAIL: $WEB/index.html missing"; exit 1; }
[ -d "$ROOT" ] || mkdir -p "$ROOT"
cp -a "$WEB"/* "$ROOT"/
cp -a "$SRC"/server.js "$SRC"/house.json "$SRC"/sim.js "$SRC"/README.md \
      "$SRC"/deploy-on-box.sh "$SRC"/esp32 "$ROOT"/
# asset busting: vhost caches .js/.css 12h and Cloudflare happily caches that
V=$(cat "$ROOT"/app.js "$ROOT"/style.css "$ROOT"/config.js | md5sum | cut -c1-8)
sed -i -E "s%(app\.js|style\.css|config\.js)\?v=[A-Za-z0-9]*%\1?v=$V%g" "$ROOT"/index.html
grep -oE '(app|config)\.js\?v=[A-Za-z0-9]+|style\.css\?v=[A-Za-z0-9]+' "$ROOT"/index.html | sed 's/^/   asset version /'

echo "== 2. ownership =="
chown -R www:www "$ROOT" 2>/dev/null || true
find "$ROOT" -type d -exec chmod 755 {} +
find "$ROOT" -type f -name '.user.ini' -prune -o -type f -exec chmod 644 {} +

echo "== 3. service =="
NODE=$(command -v node || ls /www/server/nodejs/v*/bin/node 2>/dev/null | sort -V | tail -1)
[ -n "${NODE:-}" ] || { echo "   FAIL: no node"; exit 1; }
cat > /etc/systemd/system/$SVC.service <<EOF
[Unit]
Description=House Impostor game server ($SITE)
After=network-online.target

[Service]
WorkingDirectory=$ROOT
Environment=PORT=$PORT
Environment=HOUSE_FILE=$ROOT/house.json
Environment=BEACON_KEY=house
Environment=ADMIN_KEY=house
ExecStart=$NODE $ROOT/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable $SVC >/dev/null 2>&1
systemctl restart $SVC
sleep 2
echo "   service: $(systemctl is-active $SVC)"
curl -s -m 5 "http://127.0.0.1:$PORT/health" || { journalctl -u $SVC -n 5 --no-pager; exit 1; }
echo

echo "== 4. nginx proxy (extension dir, vhost untouched) =="
[ -d "$EXT" ] || { echo "   FAIL: $EXT missing"; exit 1; }
UP='$connection_upgrade'
grep -q 'connection_upgrade' /www/server/panel/vhost/nginx/0.websocket.conf 2>/dev/null || UP='"upgrade"'
cat > "$INC" <<EOF
# House Impostor - game server on 127.0.0.1:$PORT (+ ESP32 beacons POST /api/beacon)
location ~ ^/(ws|api/|health) {
    proxy_pass http://127.0.0.1:$PORT;
    proxy_http_version 1.1;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection $UP;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    proxy_buffering off;
}
EOF
if nginx -t 2>/tmp/nginxt.err; then
  nginx -s reload && echo "   nginx reloaded"
else
  rm -f "$INC"; nginx -s reload
  echo "   nginx -t FAILED, include removed:"; sed 's/^/     /' /tmp/nginxt.err; exit 1
fi

echo "== 5. verify =="
sleep 1
for p in / /app.js /health /api/rules /api/house; do
  printf '   %-12s ' "$p"
  curl -sk -m 6 -o /dev/null -w "%{http_code}\n" -H "Host: $SITE" "https://127.0.0.1$p"
done
printf '   beacon POST  '
curl -sk -m 6 -o /dev/null -w "%{http_code}\n" -H "Host: $SITE" -H "x-beacon-key: house" \
  -H "content-type: application/json" -d '{"beacon":"land1","peers":[]}' "https://127.0.0.1/api/beacon"
printf '   websocket    '
curl -sk -m 4 -o /dev/null -w "%{http_code}\n" -H "Host: $SITE" \
  -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" -H "Sec-WebSocket-Version: 13" \
  "https://127.0.0.1/ws?room=DEPLOY&name=check" || true
echo "   done. Site: https://$SITE"
