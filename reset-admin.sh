#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

NODE_CMD=""
if [ -x "runtime/bin/node" ]; then
    NODE_CMD="$(pwd)/runtime/bin/node"
elif command -v node &>/dev/null; then
    NODE_CMD="node"
else
    echo "  Node.js not found. Run install.sh first, or install Node.js manually."
    exit 1
fi

if [ ! -d "node_modules" ]; then
  echo "  Dependencies not installed. Run install.sh first."
  exit 1
fi

"$NODE_CMD" scripts/reset-admin.js "$@"
