#!/bin/sh
# Read-only operational checks, to run AFTER a service session has entered the world.
set -eu
systemctl is-active --quiet mcskill-afk
systemctl show mcskill-afk -p MainPID -p MemoryCurrent -p MemoryPeak -p CPUUsageNSec -p TasksCurrent
pid=$(systemctl show mcskill-afk --property MainPID --value)
[ "$pid" -gt 1 ]
ps -p "$pid" -o pid=,etime=,%cpu=,rss=,comm=
journalctl -u mcskill-afk -n 30 --no-pager
