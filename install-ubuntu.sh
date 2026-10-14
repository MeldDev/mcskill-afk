#!/usr/bin/env bash
set -euo pipefail
ROOT=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
service=0
usage() {
  cat <<'HELP'
Usage: bash install-ubuntu.sh [--service]

Install on Ubuntu 22.04+ x86_64:
  - Ubuntu packages: curl, CA certificates, xz, tar, coreutils, libstdc++6, tmux.
  - Private Node.js 24 runtime in .runtime/node (official nodejs.org archive + SHA256).
  - Locked npm dependencies and all automatic tests.

Then run: ./start.sh
For an SSH-persistent interactive console: ./start.sh --tmux
--service additionally installs the systemd unit; a private session is needed to start it.
No account passwords or tokens are requested by this installer.
HELP
}
for arg in "$@"; do
  case "$arg" in
    --service) service=1 ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$arg" >&2; usage >&2; exit 1 ;;
  esac
done
fail() { printf 'Install failed: %s\n' "$*" >&2; exit 1; }
[[ $(uname -s) == Linux ]] || fail 'This installer is for Ubuntu Linux, not Windows. Use START-BOT.cmd on Windows.'
[[ $(uname -m) == x86_64 ]] || fail 'Ubuntu x86_64 is required.'
[[ -r /etc/os-release ]] || fail 'Cannot identify the operating system.'
# /etc/os-release is the distribution-owned identification file, not user configuration.
. /etc/os-release
[[ ${ID:-} == ubuntu ]] || fail 'Ubuntu 22.04 or newer is required.'
version_major=${VERSION_ID:-0}
version_major=${version_major%%.*}
[[ "$version_major" =~ ^[0-9]+$ ]] && (( version_major >= 22 )) || fail 'Ubuntu 22.04 or newer is required.'
[[ -f "$ROOT/package-lock.json" && -f "$ROOT/tools/login-and-afk.js" ]] || fail 'Incomplete checkout.'
[[ -w "$ROOT" ]] || fail 'The checkout must be writable by the user running this installer.'

privilege=()
if (( EUID != 0 )); then
  command -v sudo >/dev/null || fail 'sudo is required to install Ubuntu packages.'
  privilege=(sudo)
fi
printf '\n[1/3] Installing Ubuntu dependencies (sudo may request your Linux password).\n'
"${privilege[@]}" apt-get update
"${privilege[@]}" env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  ca-certificates curl xz-utils tar coreutils libstdc++6 tmux

mkdir -p -- "$ROOT/.runtime"
runtime_dir=$(realpath -- "$ROOT/.runtime")
[[ "$runtime_dir" == "$ROOT/.runtime" ]] || fail '.runtime must be a real directory inside this checkout.'
node_dir="$runtime_dir/node"
stage=''
cleanup() {
  [[ -n "$stage" && -d "$stage" ]] || return 0
  local resolved
  resolved=$(realpath -- "$stage") || return 0
  # Recursive cleanup is restricted to our own resolved staging directory.
  case "$resolved" in "$runtime_dir"/.install-node.*) rm -rf -- "$resolved" ;; esac
}
trap cleanup EXIT
printf '\n[2/3] Preparing the private Node.js runtime.\n'
if [[ -x "$node_dir/bin/node" && -x "$node_dir/bin/npm" ]] && "$node_dir/bin/node" -e \
  'const [a,b]=process.versions.node.split(".").map(Number);if(process.platform!=="linux"||a<22||(a===22&&b<15))process.exit(1)'; then
  printf 'Reusing compatible .runtime/node.\n'
else
  [[ ! -e "$node_dir" && ! -L "$node_dir" ]] || fail 'Existing .runtime/node is not usable. Rename that directory and rerun; it will not be deleted automatically.'
  stage=$(mktemp -d "$runtime_dir/.install-node.XXXXXXXX")
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 \
    --connect-timeout 20 --max-time 120 \
    https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt -o "$stage/SHASUMS256.txt"
  mapfile -t candidates < <(awk 'NF==2 && $2 ~ /^node-v24\.[0-9]+\.[0-9]+-linux-x64\.tar\.xz$/ { print $1 " " $2 }' "$stage/SHASUMS256.txt")
  (( ${#candidates[@]} == 1 )) || fail 'Official checksum list did not contain exactly one Node.js 24 Linux x64 archive.'
  read -r checksum filename <<< "${candidates[0]}"
  [[ "$checksum" =~ ^[0-9a-fA-F]{64}$ && "$filename" =~ ^node-v24\.[0-9]+\.[0-9]+-linux-x64\.tar\.xz$ ]] || fail 'Unexpected archive metadata.'
  printf 'Downloading %s from nodejs.org...\n' "$filename"
  curl --fail --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 \
    --connect-timeout 20 --max-time 900 "https://nodejs.org/dist/latest-v24.x/$filename" -o "$stage/$filename"
  (cd -- "$stage" && printf '%s  %s\n' "$checksum" "$filename" | sha256sum --check --status) || fail 'Node.js SHA256 verification failed.'
  mkdir -- "$stage/node"
  tar --extract --xz --file "$stage/$filename" --directory "$stage/node" --strip-components=1 --no-same-owner
  "$stage/node/bin/node" -e 'if(process.platform!=="linux"||process.arch!=="x64"||!process.versions.node.startsWith("24."))process.exit(1)' || fail 'Downloaded Node.js runtime could not run.'
  mv -- "$stage/node" "$node_dir"
fi
export PATH="$node_dir/bin:$PATH"
printf '\n[3/3] Installing locked dependencies and running tests.\n'
bash "$ROOT/deploy/install-dependencies.sh"
bash "$ROOT/test/deploy-smoke.sh"
chmod +x -- "$ROOT/start.sh" "$ROOT/install-ubuntu.sh"
if (( service )); then
  printf '\nInstalling optional systemd service...\n'
  "${privilege[@]}" bash "$ROOT/deploy/install-service.sh"
fi
printf '\nInstallation complete.\n  ./start.sh          login + password, chat and manual controls\n  ./start.sh --tmux   keep the interactive bot running after SSH disconnect\n\nInside tmux: Ctrl+B, then D detaches; ./start.sh --tmux reattaches.\n'
printf 'Optional service setup: bash install-ubuntu.sh --service\n'
