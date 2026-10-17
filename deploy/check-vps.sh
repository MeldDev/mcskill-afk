#!/bin/sh
# Read-only checks; useful both for a live connection and a failed service.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
systemctl show mcskill-afk -p ActiveState -p SubState -p Result -p MainPID -p ExecMainStatus -p NRestarts -p MemoryCurrent -p MemoryPeak -p CPUUsageNSec -p TasksCurrent
pid=$(systemctl show mcskill-afk --property MainPID --value)
if [ "${pid:-0}" -gt 1 ]; then ps -p "$pid" -o pid=,etime=,%cpu=,rss=,comm= || true; fi
for name in connection.js codec.js game.js inventory.js logger.js; do
  if [ -f "$ROOT/src/$name" ] && [ -f "/opt/mcskill-afk/src/$name" ]; then
    if cmp -s -- "$ROOT/src/$name" "/opt/mcskill-afk/src/$name"; then
      printf 'Installed source matches checkout: %s\n' "$name"
    else
      printf 'Installed source DIFFERS from checkout: %s\n' "$name"
    fi
  fi
done
if command -v ss >/dev/null 2>&1; then ss -tinp '( dport = :25565 )' || true; fi
journalctl -u mcskill-afk -n 50 --no-pager -l
