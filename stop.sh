#!/bin/sh
cd "$(dirname "$0")"

NODE_CMD=""
if [ -x "runtime/bin/node" ]; then
    NODE_CMD="$(pwd)/runtime/bin/node"
elif command -v node >/dev/null 2>&1; then
    NODE_CMD="node"
else
    echo "Node.js not found."
    exit 1
fi

"$NODE_CMD" scripts/server-control.js stop "$@"
