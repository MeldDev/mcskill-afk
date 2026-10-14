#!/usr/bin/env bash
# Exercise the real start.sh with a stub runtime; never connect to MCSkill or install packages.
set -euo pipefail
ROOT=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
mkdir -p -- "$ROOT/.runtime"
runtime_dir=$(realpath -- "$ROOT/.runtime")
[[ "$runtime_dir" == "$ROOT/.runtime" ]] || { echo 'Unsafe test runtime path' >&2; exit 1; }
scratch=$(mktemp -d "$runtime_dir/.shell-test.XXXXXXXX")
cleanup() {
  local resolved
  resolved=$(realpath -- "$scratch") || return 0
  case "$resolved" in "$runtime_dir"/.shell-test.*) rm -rf -- "$resolved" ;; esac
}
trap cleanup EXIT
project="$scratch/project with spaces"
mkdir -p -- "$project/.runtime/node/bin" "$project/tools" "$project/src"
cp -- "$ROOT/start.sh" "$project/start.sh"
cat > "$project/.runtime/node/bin/node" <<'STUB'
#!/usr/bin/env bash
set -eu
if [[ ${1:-} == -e ]]; then exit "${MCSKILL_TEST_VERSION_EXIT:-0}"; fi
printf '%s\n' "$PWD" "$@" > "$MCSKILL_TEST_RECORD"
STUB
chmod +x -- "$project/.runtime/node/bin/node"
export MCSKILL_TEST_RECORD="$scratch/record"
bash -n "$ROOT/install-ubuntu.sh"
bash -n "$ROOT/start.sh"
bash -n "$ROOT/deploy/install-service.sh"
bash "$ROOT/install-ubuntu.sh" --help >/dev/null
bash "$project/start.sh" --help >/dev/null
for mode in login --session --probe; do
  (cd -- "$scratch" && bash "$project/start.sh" "$mode")
  mapfile -t args < "$MCSKILL_TEST_RECORD"
  [[ ${args[0]} == "$project" && ${args[1]} == --max-old-space-size=192 ]]
  if [[ "$mode" == login ]]; then
    [[ ${#args[@]} == 3 && ${args[2]} == "$project/tools/login-and-afk.js" ]]
  else
    [[ ${#args[@]} == 4 && ${args[2]} == "$project/src/cli.js" ]]
    if [[ "$mode" == --session ]]; then [[ ${args[3]} == afk ]]; else [[ ${args[3]} == probe ]]; fi
  fi
done
if bash "$project/start.sh" --invalid >/dev/null 2>&1; then echo 'Invalid option accepted' >&2; exit 1; fi
if MCSKILL_TEST_VERSION_EXIT=1 bash "$project/start.sh" >/dev/null 2>&1; then echo 'Unsupported Node accepted' >&2; exit 1; fi
if bash "$ROOT/install-ubuntu.sh" --invalid >/dev/null 2>&1; then echo 'Invalid install option accepted' >&2; exit 1; fi
printf 'Deployment smoke checks passed: syntax, help, runtime selection, cwd with spaces, login/session/probe modes, invalid options/version.\n'
