#!/bin/bash
# usage: deploy-snap.sh <ctid> <camera-ip>   (protect password on stdin)
set -e
CT=$1; CAM=$2; PASS=$(cat)
pct push $CT /root/onvif-bridge/snapshot-sidecar.js /opt/onvif-snapshot.js --perms 644
pct exec $CT -- sh -c "umask 077; printf 'SNAP_CAMERA=%s\nSNAP_USER=protect\nSNAP_PASS=%s\nSNAP_PORT=8580\n' '$CAM' \"\$0\" > /etc/onvif-server/snapshot.env; chown onvif /etc/onvif-server/snapshot.env" "$PASS"
pct exec $CT -- sh -c 'cat > /etc/systemd/system/onvif-snapshot.service <<UNIT
[Unit]
Description=Live snapshot sidecar for the onvif bridge
After=network-online.target
Wants=network-online.target

[Service]
User=onvif
EnvironmentFile=/etc/onvif-server/snapshot.env
ExecStart=/usr/bin/node /opt/onvif-snapshot.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload; systemctl enable onvif-snapshot >/dev/null 2>&1; systemctl restart onvif-snapshot'
pct exec $CT -- sh -c 'c=/etc/onvif-server/config.yaml; grep -q "snapshot: 8580" $c && exit 0; cp $c /root/config.yaml.bak-20261031
sed -i -e "s|^\(      rtsp: 8554\)$|\1\n      snapshot: 8580|" \
       -e "s|^\(      rtsp: \"/cam/realmonitor?channel=1&subtype=[01]\"\)$|\1\n      snapshot: \"/snapshot.jpg\"|" $c'
pct exec $CT -- grep -n snapshot /etc/onvif-server/config.yaml
