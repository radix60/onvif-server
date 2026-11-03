#!/bin/bash
# Move an existing bridge CT to this fork's weston branch (or another ref).
# Usage: update-bridge.sh <ctid> [ref]      (run on pve)
# Local edits in /opt/onvif-server are stashed, not lost. onvif-server is
# restarted only if the code it runs changed, which costs Protect a few
# seconds of recording; the script then waits for Protect to reconnect.
set -euo pipefail
CT=$1 REF=${2:-origin/weston}
FORK=https://github.com/radix60/onvif-server.git
PROTECT=192.168.20.18

run() { pct exec "$CT" -- "$@"; }
code_hash() { run sh -c 'cd /opt/onvif-server && cat main.js src/*.js | sha256sum'; }
lock_hash() { run sh -c 'cd /opt/onvif-server && cat package.json package-lock.json | sha256sum'; }

code_before=$(code_hash) lock_before=$(lock_hash)
run env FORK="$FORK" REF="$REF" sh -ec '
cd /opt/onvif-server
git remote set-url origin "$FORK"
git fetch -q origin
git stash push -u -q -m "update-bridge $(date -u +%FT%TZ)" >/dev/null || true
git checkout -q -B weston "$REF"'
echo "CT $CT: $(run git -C /opt/onvif-server log --oneline -1)"

if [ "$(lock_hash)" != "$lock_before" ]; then
  echo "CT $CT: dependencies changed, running npm install"
  run sh -c 'cd /opt/onvif-server && npm install --omit=dev --no-audit --no-fund --loglevel=error >/dev/null'
  code_before=changed
fi

# The snapshot sidecar does not touch recording, so refresh it whenever it differs.
if run test -e /opt/onvif-snapshot.js \
   && ! run cmp -s /opt/onvif-server/weston/snapshot-sidecar.js /opt/onvif-snapshot.js; then
  run install -m 644 /opt/onvif-server/weston/snapshot-sidecar.js /opt/onvif-snapshot.js
  run systemctl restart onvif-snapshot
  echo "CT $CT: snapshot sidecar updated"
fi

if [ "$(code_hash)" = "$code_before" ]; then
  echo "CT $CT: running code unchanged, no restart"
  exit 0
fi

run node --check /opt/onvif-server/main.js
date -u +"CT $CT: restart at %FT%TZ"
run systemctl restart onvif-server
n=0
for i in $(seq 1 60); do
  n=$(run ss -tnH state established "( sport = :8554 )" | grep -c "$PROTECT" || true)
  [ "$n" -ge 3 ] && break; sleep 2
done
echo "CT $CT: $n Protect sessions after $((i*2))s"
