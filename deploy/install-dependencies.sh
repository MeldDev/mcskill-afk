#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
node -e 'const [a,b]=process.versions.node.split(".").map(Number);if(a<22||(a===22&&b<15))process.exit(1)' || {
  echo 'Install Node.js 22.15 or newer from the official Node.js distribution first.' >&2
  exit 1
}
npm ci --ignore-scripts --no-audit --no-fund
npm test
