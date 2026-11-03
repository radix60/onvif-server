# Weston bridge extras

Each Amcrest IP8M-2493E reaches UniFi Protect through its own LXC on pve
(CTs 110–115) running this repo's `weston` branch in `/opt/onvif-server`.
The scripts here run on pve as root.

## Building and updating bridges

- `mk-onvif-bridge.sh <ctid> <Name> <camera-ip> [ref]`: creates the LXC,
  clones this fork at `weston` (or `ref`), writes `config.yaml` and the
  `onvif-server` unit. Run `deploy-snap.sh` afterwards for a live snapshot.
- `update-bridge.sh <ctid> [ref]`: points the CT's checkout at this fork,
  fetches, stashes any local edits and checks out `origin/weston` (or `ref`).
  It runs `npm install` if the lockfile changed and refreshes the snapshot
  sidecar if it differs. It restarts `onvif-server` only when `main.js` or
  `src/` changed, because each restart costs Protect a few seconds of
  recording, then waits up to 120 s for Protect's 3 sessions on :8554.

Push to `weston` first; the CTs fetch from GitHub.

## RTSP relay

`src/rtsp-proxy.js` replaces the plain TCP proxy on the RTSP port. It drops
the AUD and SEI NAL units the Amcrests send before every frame, which
Protect's 7447 restream otherwise turns into undecodable packets, and
renumbers RTP sequence numbers so clients see no loss.

## Live snapshot sidecar

Protect asks for the snapshot URI once, at adoption, and caches it. onvif-server
answers with `/snapshot.png`, so `src/onvif-server.js` proxies that path to a
local sidecar and falls back to the static logo if the sidecar fails.

- `snapshot-sidecar.js`: deployed as `/opt/onvif-snapshot.js` and run by
  `onvif-snapshot.service` (User=onvif) on :8580. It fetches the camera's
  `/cgi-bin/snapshot.cgi?channel=1` with Digest auth, caches a frame for 2 s,
  shares one in-flight fetch, and stops fetching for 10 min after a single 401,
  so a wrong password cannot trigger the camera's per-IP login lockout.
- `deploy-snap.sh <ctid> <camera-ip>`: run on pve with the camera's `protect`
  password on stdin. It pushes the sidecar, writes
  `/etc/onvif-server/snapshot.env` (mode 600: `SNAP_CAMERA`, `SNAP_USER`,
  `SNAP_PASS`, `SNAP_PORT`), installs and starts the unit, and adds
  `ports.snapshot: 8580` and `snapshot: "/snapshot.jpg"` to config.yaml.
  The config deliberately has no `target.ports.snapshot`, so onvif-server does
  not open a TCP proxy to the camera's snapshot port.
