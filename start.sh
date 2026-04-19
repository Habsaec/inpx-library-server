#!/bin/sh
cd "$(dirname "$0")"

NODE_CMD=""
NPM_CMD=""

# --- Find Node.js ---
if [ -x "runtime/bin/node" ]; then
    NODE_CMD="$(pwd)/runtime/bin/node"
    NPM_CMD="$(pwd)/runtime/bin/npm"
elif command -v node >/dev/null 2>&1; then
    NODE_CMD="node"
    NPM_CMD="npm"
else
    echo "Node.js not found."
    echo "Run: sudo ./install.sh"
    exit 1
fi

NODE_VER=$("$NODE_CMD" -v)
echo "Node.js $NODE_VER"

# --- Check dependencies ---
if [ ! -d "node_modules" ]; then
    echo "Dependencies not installed."
    echo "Run: sudo ./install.sh"
    exit 1
fi

# --- Rebuild native modules if Node.js version changed ---
PREV_VER=""
[ -f "node_modules/.node_version" ] && PREV_VER=$(cat node_modules/.node_version)
if [ "$PREV_VER" != "$NODE_VER" ]; then
    echo "Node.js version changed ($PREV_VER -> $NODE_VER), rebuilding native modules..."
    "$NPM_CMD" rebuild || { echo "npm rebuild failed. Try running install.sh again."; exit 1; }
    echo "$NODE_VER" > node_modules/.node_version
    echo "Done."
    echo
fi

# --- Detect port ---
SERVER_PORT=$("$NODE_CMD" -e "try{require('dotenv').config()}catch{}console.log(process.env.PORT||3000)" 2>/dev/null || echo 3000)

# --- Start server ---
"$NODE_CMD" scripts/server-control.js start "$@"
if [ $? -ne 0 ]; then
    echo "ERROR: Server failed to start."
    exit 1
fi
echo
echo "  INPX Library Server is running"
echo "  http://localhost:${SERVER_PORT}"
echo
echo "  Stop:    ./stop.sh"
echo "  Restart: ./restart.sh"
