#!/bin/sh
set -eu
[ "$(id -u)" = 0 ] || { echo 'Run with sudo' >&2; exit 1; }
cd "$(dirname "$0")/.."
[ -d /run/systemd/system ] || { echo 'A running systemd installation is required' >&2; exit 1; }
if systemctl is-active --quiet mcskill-afk; then
  echo 'Stop the existing service first: sudo systemctl stop mcskill-afk' >&2
  exit 1
fi
if [ -x .runtime/node/bin/node ]; then
  node_source="$(pwd -P)/.runtime/node/bin/node"
else
  node_source=$(command -v node || true)
fi
[ -n "$node_source" ] || { echo 'Run bash install-ubuntu.sh first' >&2; exit 1; }
"$node_source" -e 'const [a,b]=process.versions.node.split(".").map(Number);if(process.platform!=="linux"||a<22||(a===22&&b<15))process.exit(1)'
getent passwd mcskill-afk >/dev/null || useradd --system --user-group --home-dir /nonexistent --shell /usr/sbin/nologin mcskill-afk
install -d -o root -g mcskill-afk -m 0750 /etc/mcskill-afk
install -d -o root -g root -m 0755 /opt/mcskill-afk/src /opt/mcskill-afk/tools /opt/mcskill-afk/profiles /opt/mcskill-afk/runtime
copy_file() {
  source_path=$1
  target_path=$2
  file_mode=$3
  if [ "$(readlink -f -- "$source_path")" != "$(readlink -m -- "$target_path")" ]; then
    install -o root -g root -m "$file_mode" "$source_path" "$target_path"
  else
    chown root:root "$target_path"
    chmod "$file_mode" "$target_path"
  fi
}
copy_file "$node_source" /opt/mcskill-afk/runtime/node 0755
for source_path in src/*.js; do copy_file "$source_path" "/opt/mcskill-afk/src/$(basename -- "$source_path")" 0644; done
for source_path in profiles/*.json; do copy_file "$source_path" "/opt/mcskill-afk/profiles/$(basename -- "$source_path")" 0644; done
copy_file tools/login-and-afk.js /opt/mcskill-afk/tools/login-and-afk.js 0644
copy_file package.json /opt/mcskill-afk/package.json 0644
copy_file package-lock.json /opt/mcskill-afk/package-lock.json 0644
install -o root -g root -m 0644 deploy/mcskill-afk.service /etc/systemd/system/mcskill-afk.service
systemctl daemon-reload
if [ "${1:-}" ]; then
  credentials_source=$1
elif [ "${MC_CREDENTIALS_FILE:-}" ]; then
  credentials_source=$MC_CREDENTIALS_FILE
else
  credentials_source=$HOME/.config/mcskill-afk/credentials.json
fi
if [ -f "$credentials_source" ] && [ ! -L "$credentials_source" ]; then
  case "$(stat -c %a -- "$credentials_source")" in
    600|400) ;;
    *) echo 'Credentials require permissions 0600; refusing to copy.' >&2; exit 1 ;;
  esac
  # Never echo contents or place passwords into command-line arguments.
  install -o mcskill-afk -g mcskill-afk -m 0600 "$credentials_source" /etc/mcskill-afk/credentials.json.new
  mv -f /etc/mcskill-afk/credentials.json.new /etc/mcskill-afk/credentials.json
fi
if [ -f /etc/mcskill-afk/credentials.json ]; then
  echo 'Installed. Start: sudo systemctl enable --now mcskill-afk'
else
  echo 'Installed. Save credentials first with ./start.sh --setup, then repeat bash install-ubuntu.sh --service.'
fi
