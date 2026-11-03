#!/bin/bash
# Create an LXC running this fork's weston branch as a virtual ONVIF camera
# for one Amcrest IP8M-2493E, so UniFi Protect can adopt it.
# Mirrors CT 110 (onvif-parking), built by hand 2026-10-29.
# Usage: mk-onvif-bridge.sh <ctid> <Name> <camera-ip> [ref]
# Then, for a live snapshot: deploy-snap.sh <ctid> <camera-ip>
set -euo pipefail
CTID=$1 NAME=$2 CAM=$3 REF=${4:-weston}
SLUG=$(echo "$NAME" | tr 'A-Z' 'a-z')
FORK=https://github.com/radix60/onvif-server.git

pct create "$CTID" local:vztmpl/ubuntu-24.04-standard_24.04-2_amd64.tar.zst \
  --hostname "onvif-$SLUG" \
  --description "ONVIF bridge (radix60/onvif-server weston) for Amcrest $NAME $CAM -> UniFi Protect. App in /opt/onvif-server, service onvif-server." \
  --arch amd64 --ostype ubuntu --unprivileged 1 --features nesting=1 \
  --cores 1 --memory 384 --swap 256 --rootfs local-lvm:4 \
  --net0 name=eth0,bridge=vmbr0,tag=2,firewall=1,ip=dhcp,type=veth \
  --onboot 1 --timezone host
MAC=$(pct config "$CTID" | sed -nE 's/^net0:.*hwaddr=([0-9A-Fa-f:]+).*/\1/p' | tr 'A-F' 'a-f')
pct start "$CTID"
pct exec "$CTID" -- systemctl is-system-running --wait >/dev/null || true

pct exec "$CTID" -- env NAME="$NAME" CAM="$CAM" MAC="$MAC" FORK="$FORK" REF="$REF" bash -s <<'IN'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get -y -qq full-upgrade >/dev/null 2>&1
apt-get -y -qq install --no-install-recommends nodejs npm git ca-certificates >/dev/null 2>&1
git clone -q "$FORK" /opt/onvif-server
git -C /opt/onvif-server checkout -q -B weston "origin/$REF" 2>/dev/null \
  || git -C /opt/onvif-server checkout -q -B weston "$REF"
(cd /opt/onvif-server && npm install --omit=dev --no-audit --no-fund --loglevel=error >/dev/null)
id onvif >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin onvif
mkdir -p /etc/onvif-server
UUID=$(cat /proc/sys/kernel/random/uuid)
cat > /etc/onvif-server/config.yaml <<CFG
# Virtual ONVIF device for Amcrest IP8M-2493E "$NAME" ($CAM).
# Stream settings mirror the camera's Encode config (4K/15fps/4096k, 704x480/15fps/1024k).
# No snapshot passthrough to the camera: it locks accounts after failed logins.
# deploy-snap.sh adds the local live-snapshot sidecar instead.
onvif:
  - mac: $MAC
    ports:
      server: 80
      rtsp: 8554
    name: $NAME
    uuid: $UUID
    highQuality:
      rtsp: "/cam/realmonitor?channel=1&subtype=0"
      width: 3840
      height: 2160
      framerate: 15
      bitrate: 4096
      quality: 4
    lowQuality:
      rtsp: "/cam/realmonitor?channel=1&subtype=1"
      width: 704
      height: 480
      framerate: 15
      bitrate: 1024
      quality: 1
    target:
      hostname: $CAM
      ports:
        rtsp: 554
CFG
chmod 644 /etc/onvif-server/config.yaml
cat > /etc/systemd/system/onvif-server.service <<'UNIT'
[Unit]
Description=Virtual ONVIF server (radix60/onvif-server weston)
After=network-online.target
Wants=network-online.target

[Service]
User=onvif
WorkingDirectory=/opt/onvif-server
ExecStart=/usr/bin/node main.js /etc/onvif-server/config.yaml
Restart=always
RestartSec=5
NoNewPrivileges=true
AmbientCapabilities=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now onvif-server >/dev/null 2>&1
IN
echo "CT $CTID onvif-$SLUG done, MAC $MAC, $(pct exec "$CTID" -- git -C /opt/onvif-server log --oneline -1)"
