#!/usr/bin/env bash
set -euo pipefail
ROOT=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
mode=${1:-login}
if (( $# > 1 )); then printf 'Use: ./start.sh [--tmux|--session|--probe|--help]\n' >&2; exit 1; fi
case "$mode" in
  -h|--help)
    printf 'Usage: ./start.sh [--tmux|--session|--probe]\n\nDefault: interactive login and hidden password input.\n--tmux: create/attach persistent console, session name mcskill-afk.\n--session: use MC_SESSION_FILE or session.json instead of a password prompt.\n--probe: check Minecraft Encryption Request without credentials.\n'
    exit 0 ;;
  login|--tmux|--session|--probe) ;;
  *) printf 'Unknown option. Use ./start.sh --help.\n' >&2; exit 1 ;;
esac
cd -- "$ROOT"
if [[ -x "$ROOT/.runtime/node/bin/node" ]]; then
  NODE="$ROOT/.runtime/node/bin/node"
else
  NODE=$(command -v node || true)
fi
if [[ -z "$NODE" ]] || ! "$NODE" -e 'const [a,b]=process.versions.node.split(".").map(Number);if(a<22||(a===22&&b<15))process.exit(1)'; then
  printf 'Run bash install-ubuntu.sh first (Node.js 22.15+ is required).\n' >&2; exit 1
fi
if [[ "$mode" == --tmux ]]; then
  command -v tmux >/dev/null || { printf 'tmux is missing. Run bash install-ubuntu.sh.\n' >&2; exit 1; }
  [[ -t 0 && -t 1 ]] || { printf 'Run --tmux from an interactive SSH terminal.\n' >&2; exit 1; }
  if [[ -n ${TMUX:-} ]]; then
    printf 'Already inside tmux; use ./start.sh here, or detach with Ctrl+B then D.\n' >&2; exit 1
  fi
  # Multiple arguments are passed directly to tmux; no passwords or shell-built commands.
  exec tmux -u new-session -A -s mcskill-afk -c "$ROOT" "$NODE" --max-old-space-size=192 "$ROOT/tools/login-and-afk.js"
elif [[ "$mode" == --session ]]; then
  exec "$NODE" --max-old-space-size=192 "$ROOT/src/cli.js" afk
elif [[ "$mode" == --probe ]]; then
  exec "$NODE" --max-old-space-size=192 "$ROOT/src/cli.js" probe
else
  exec "$NODE" --max-old-space-size=192 "$ROOT/tools/login-and-afk.js"
fi
