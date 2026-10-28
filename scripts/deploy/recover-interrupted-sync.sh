#!/usr/bin/env bash
# ==============================================================================
# Data-Preserving Recovery Procedure for Interrupted Legacy Sync
# Restores code from verified physical backup while protecting .env, storage, and logs
# ==============================================================================
set -euo pipefail

APP_DIR="/home/rasal/ai-video-editor"
BACKUP_DIR="/home/rasal/ai-video-editor-backups/latest"
PREV_BACKUP="/home/rasal/ai-video-editor-backups/previous"
RECOVERY_STAGE="/home/rasal/recovery-safety-$(date +%s)"

echo "[RECOVERY] Starting data-preserving recovery for interrupted sync..."

# Step 1: Snapshot critical runtime state immediately
mkdir -p "$RECOVERY_STAGE"
if [ -f "$APP_DIR/.env" ]; then
    cp -p "$APP_DIR/.env" "$RECOVERY_STAGE/.env.safe"
fi
if [ -d "$APP_DIR/storage" ]; then
    cp -a "$APP_DIR/storage" "$RECOVERY_STAGE/storage.safe"
fi
if [ -d "$APP_DIR/logs" ]; then
    cp -a "$APP_DIR/logs" "$RECOVERY_STAGE/logs.safe"
fi

# Step 2: Validate code backup integrity before copying
RESTORE_SOURCE=""
if [ -f "$BACKUP_DIR/server/index.js" ] && [ -f "$BACKUP_DIR/dist/index.html" ]; then
    RESTORE_SOURCE="$BACKUP_DIR"
elif [ -f "$PREV_BACKUP/server/index.js" ] && [ -f "$PREV_BACKUP/dist/index.html" ]; then
    RESTORE_SOURCE="$PREV_BACKUP"
fi

if [ -z "$RESTORE_SOURCE" ]; then
    echo "ERROR: Neither 'latest' nor 'previous' backup contains valid application entrypoints!" >&2
    echo "Aborting code overwrite. Runtime state preserved in $RECOVERY_STAGE." >&2
    exit 1
fi

# Step 3: Restore ONLY code artifacts (leaves .env, storage/, logs/ untouched)
echo "[RECOVERY] Restoring code artifacts from $RESTORE_SOURCE..."
for item in server src public dist package.json package-lock.json; do
    if [ -e "$RESTORE_SOURCE/$item" ]; then
        rm -rf "$APP_DIR/$item"
        cp -a "$RESTORE_SOURCE/$item" "$APP_DIR/"
    fi
done

# Step 4: Re-verify runtime state integrity
if [ ! -f "$APP_DIR/.env" ] && [ -f "$RECOVERY_STAGE/.env.safe" ]; then
    cp -p "$RECOVERY_STAGE/.env.safe" "$APP_DIR/.env"
fi
chmod 600 "$APP_DIR/.env"

# Step 5: Reload PM2 and verify health
echo "[RECOVERY] Reloading PM2 backend process..."
pm2 reload ai-video-editor-backend --update-env || pm2 restart ai-video-editor-backend --update-env

if curl -s -f "http://127.0.0.1/health" | grep -q '"status":"ok"'; then
    echo "[RECOVERY-SUCCESS] Application recovered cleanly. Verified runtime state intact."
    rm -rf "$RECOVERY_STAGE"
    exit 0
else
    echo "ERROR: Application health check failed after restoring backup!" >&2
    exit 1
fi
