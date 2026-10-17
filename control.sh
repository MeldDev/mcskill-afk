#!/usr/bin/env bash
set -euo pipefail
ROOT=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
if [[ -x "$ROOT/.runtime/node/bin/node" ]]; then
  NODE="$ROOT/.runtime/node/bin/node"
elif [[ -x "$ROOT/runtime/node" ]]; then
  NODE="$ROOT/runtime/node"
else
  NODE=$(command -v node || true)
fi
if [[ -z "$NODE" ]]; then printf 'Run bash install-ubuntu.sh first.\n' >&2; exit 1; fi
exec "$NODE" --max-old-space-size=64 "$ROOT/tools/control.js" "$@"
