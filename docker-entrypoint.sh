#!/bin/sh
set -e

echo "[entrypoint] ======== INPX Library Docker Entrypoint ========"
echo "[entrypoint] Node.js: $(node -v 2>/dev/null || echo 'NOT FOUND')"
echo "[entrypoint] npm:     $(npm -v 2>/dev/null || echo 'NOT FOUND')"
echo "[entrypoint] Arch:    $(uname -m)"
echo "[entrypoint] Date:    $(date -u '+%Y-%m-%d %H:%M:%S UTC')"

IMAGE_VERSION_FILE="/app-image/.image-version"
APP_VERSION_FILE="/app/.image-version"

image_ver=""
app_ver=""
[ -f "$IMAGE_VERSION_FILE" ] && image_ver=$(cat "$IMAGE_VERSION_FILE")
[ -f "$APP_VERSION_FILE" ] && app_ver=$(cat "$APP_VERSION_FILE")

echo "[entrypoint] Image version: ${image_ver:-<none>}"
echo "[entrypoint] App version:   ${app_ver:-<none>}"

# Diagnostic: show what's in /app
echo "[entrypoint] /app contents:"
ls -la /app/ 2>/dev/null | head -20 || echo "  (empty or not mounted)"

need_sync=0
if [ ! -f "/app/package.json" ]; then
  echo "[entrypoint] First run — initializing /app from image…"
  need_sync=1
elif [ -n "$image_ver" ] && [ "$image_ver" != "$app_ver" ]; then
  echo "[entrypoint] Image updated ($app_ver → $image_ver) — syncing code…"
  need_sync=1
else
  echo "[entrypoint] App is up to date, skipping sync."
fi

if [ "$need_sync" = "1" ]; then
  # Sync code from image, preserve user data (.env, data/)
  echo "[entrypoint] Syncing source files…"
  for item in /app-image/*; do
    name=$(basename "$item")
    case "$name" in
      data|node_modules|.env|.env.local) continue ;;
    esac
    rm -rf "/app/$name"
    cp -a "$item" "/app/$name"
    echo "[entrypoint]   copied: $name"
  done
  # Hidden files
  for item in /app-image/.*; do
    name=$(basename "$item")
    case "$name" in
      .|..|.env|.env.local) continue ;;
    esac
    rm -rf "/app/$name"
    cp -a "$item" "/app/$name"
    echo "[entrypoint]   copied: $name"
  done

  # Sync node_modules via tar (preserves symlinks correctly across filesystems)
  echo "[entrypoint] Syncing node_modules via tar…"
  rm -rf /app/node_modules
  if (cd /app-image && tar cf - node_modules) | (cd /app && tar xf -); then
    NM_COUNT=$(find /app/node_modules -maxdepth 1 -type d | wc -l)
    echo "[entrypoint] tar sync OK — $NM_COUNT top-level entries in node_modules"
  else
    echo "[entrypoint] tar sync FAILED (exit code: $?)"
  fi

  # Verify modules are usable
  echo "[entrypoint] Verifying node_modules…"
  if node -e "require('express'); require('better-sqlite3'); console.log('[entrypoint] Verification: express + better-sqlite3 OK')"; then
    echo "[entrypoint] node_modules verified successfully."
  else
    echo "[entrypoint] node_modules verification FAILED — falling back to npm install…"
    cd /app
    rm -rf node_modules
    npm install --omit=dev || { echo "[entrypoint] npm install FAILED" >&2; exit 1; }
    echo "[entrypoint] npm install succeeded."
  fi

  [ -n "$image_ver" ] && cp "$IMAGE_VERSION_FILE" "$APP_VERSION_FILE"
  echo "[entrypoint] Code synced."
fi

# Final diagnostics
echo "[entrypoint] /app/node_modules exists: $([ -d /app/node_modules ] && echo 'YES' || echo 'NO')"
echo "[entrypoint] /app/package.json exists: $([ -f /app/package.json ] && echo 'YES' || echo 'NO')"
echo "[entrypoint] /app/src/server-entry.js exists: $([ -f /app/src/server-entry.js ] && echo 'YES' || echo 'NO')"
echo "[entrypoint] ======== Starting: $@ ========"

cd /app
exec "$@"
