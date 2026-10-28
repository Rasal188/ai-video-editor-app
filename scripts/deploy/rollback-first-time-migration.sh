#!/usr/bin/env bash
# ==============================================================================
# Reversal Script for First-Time Migration
# Restores /home/rasal/ai-video-editor to its original physical directory state
# Synchronizes any state created in shared/ back to the physical directory
# ==============================================================================
set -euo pipefail

export PATH="${TEST_PATH:-/usr/local/bin:/usr/bin:/bin}"
export LC_ALL=C
export LANG=C

readonly DEPLOY_USER="rasal"
readonly HOME_DIR="${OVERRIDE_HOME:-/home/rasal}"
readonly APP_DIR="$HOME_DIR/ai-video-editor"
readonly BACKUP_DIR="$HOME_DIR/ai-video-editor.physical-backup"
readonly SHARED_DIR="$HOME_DIR/shared"

echo "================================================================="
echo "AI Video Editor: Reversing First-Time Migration"
echo "Restoring: $BACKUP_DIR -> $APP_DIR"
echo "================================================================="

if [ "${SKIP_USER_CHECK:-0}" != "1" ] && [ "$(whoami)" != "$DEPLOY_USER" ]; then
    echo "ERROR: Must be executed as user '$DEPLOY_USER' (current: $(whoami))." >&2
    exit 1
fi

if [ ! -d "$BACKUP_DIR" ]; then
    echo "ERROR: Physical backup directory '$BACKUP_DIR' not found!" >&2
    exit 1
fi

echo "[REVERSAL] Syncing runtime state from shared/ back to physical backup..."
if [ -f "$SHARED_DIR/.env" ]; then
    cp -p "$SHARED_DIR/.env" "$BACKUP_DIR/.env"
fi
if [ -d "$SHARED_DIR/storage" ]; then
    mkdir -p "$BACKUP_DIR/storage"
    cp -aT "$SHARED_DIR/storage" "$BACKUP_DIR/storage"
fi
if [ -d "$SHARED_DIR/logs" ]; then
    mkdir -p "$BACKUP_DIR/logs"
    cp -aT "$SHARED_DIR/logs" "$BACKUP_DIR/logs"
fi

echo "[REVERSAL] Removing live symlink and restoring physical directory..."
if [ -L "$APP_DIR" ] || [ -f "$APP_DIR" ]; then
    rm -f "$APP_DIR" 2>/dev/null || true
elif [ -d "$APP_DIR" ]; then
    echo "ERROR: Target '$APP_DIR' is already a physical directory! Aborting to prevent collision." >&2
    exit 1
fi
rm -f "$APP_DIR.tmp" 2>/dev/null || true
mv "$BACKUP_DIR" "$APP_DIR"

echo "[REVERSAL] Reloading PM2 backend process..."
pm2 restart ai-video-editor-backend --update-env 2>/dev/null || pm2 reload ai-video-editor-backend --update-env 2>/dev/null || true

echo "[REVERSAL] Verifying application health..."
HEALTHY=false
for attempt in 1 2 3 4 5; do
    if curl -s -f "http://127.0.0.1/health" 2>/dev/null | grep -q '"status":"ok"'; then
        HEALTHY=true
        break
    fi
    sleep 1
done

if [ "$HEALTHY" = "true" ]; then
    echo "================================================================="
    echo "[REVERSAL-SUCCESS] Physical directory layout restored and verified!"
    echo "Application directory: $APP_DIR (Physical directory, not symlink)"
    echo "================================================================="
    exit 0
else
    echo "WARNING: Application health check failed after restoring physical directory!" >&2
    exit 1
fi
