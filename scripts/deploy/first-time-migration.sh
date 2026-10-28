#!/usr/bin/env bash
# ==============================================================================
# Reversible First-Time Migration Script for AI Video Editor VM
# Migrates /home/rasal/ai-video-editor from physical directory to releases layout
# Preserves all files, dotfiles, permissions, ownership, and application state
# Includes preflight checks, backup verification, and automated rollback
# ==============================================================================
set -euo pipefail

export PATH="${TEST_PATH:-/usr/local/bin:/usr/bin:/bin}"
export LC_ALL=C
export LANG=C

readonly DEPLOY_USER="rasal"
readonly HOME_DIR="${OVERRIDE_HOME:-/home/rasal}"
readonly APP_DIR="$HOME_DIR/ai-video-editor"
readonly BACKUP_DIR="$HOME_DIR/ai-video-editor.physical-backup"
readonly BACKUP_TAR="$HOME_DIR/ai-video-editor-pre-migration-backup.tar.gz"
readonly SHARED_DIR="$HOME_DIR/shared"
readonly RELEASES_DIR="$HOME_DIR/releases"
readonly BASELINE_DIR="$RELEASES_DIR/legacy-baseline"

echo "================================================================="
echo "AI Video Editor: First-Time Directory Migration"
echo "Target: $APP_DIR -> $SHARED_DIR & $BASELINE_DIR"
echo "================================================================="

# --- 1. Preflight Verification Checks ---
echo "[PREFLIGHT] Checking running user..."
if [ "${SKIP_USER_CHECK:-0}" != "1" ] && [ "$(whoami)" != "$DEPLOY_USER" ]; then
    echo "ERROR: Must be executed as user '$DEPLOY_USER' (current: $(whoami))." >&2
    exit 1
fi

echo "[PREFLIGHT] Checking physical directory status..."
if [ ! -d "$APP_DIR" ]; then
    echo "ERROR: Target path '$APP_DIR' does not exist." >&2
    exit 1
fi
if [ -L "$APP_DIR" ]; then
    echo "NOTICE: '$APP_DIR' is already a symlink. Migration already completed!"
    exit 0
fi

echo "[PREFLIGHT] Verifying required application files and secrets..."
for req in server/index.js dist/index.html package.json .env; do
    if [ ! -e "$APP_DIR/$req" ]; then
        echo "ERROR: Required application entry '$req' missing in $APP_DIR!" >&2
        exit 1
    fi
done

echo "[PREFLIGHT] Checking available disk space..."
AVAIL_KB=$(df -P "$HOME_DIR" | awk 'NR==2 {print $4}')
APP_KB=$(du -s "$APP_DIR" | awk '{print $1}')
if [ "$AVAIL_KB" -lt $(( APP_KB * 3 )) ]; then
    echo "ERROR: Insufficient disk space in $HOME_DIR (Available: ${AVAIL_KB}KB, Required: $(( APP_KB * 3 ))KB)." >&2
    exit 1
fi

# Rollback handler in case of migration failure
rollback_migration() {
    local exit_code=$?
    if [ $exit_code -ne 0 ]; then
        echo "[MIGRATION-FAILED] Error encountered during migration! Restoring physical directory..." >&2
        if [ -d "$BACKUP_DIR" ]; then
            # Sync any new uploads or logs created in shared/ back to physical backup before restore
            if [ -d "$SHARED_DIR/storage" ]; then
                mkdir -p "$BACKUP_DIR/storage"
                cp -aT "$SHARED_DIR/storage" "$BACKUP_DIR/storage" 2>/dev/null || true
            fi
            if [ -d "$SHARED_DIR/logs" ]; then
                mkdir -p "$BACKUP_DIR/logs"
                cp -aT "$SHARED_DIR/logs" "$BACKUP_DIR/logs" 2>/dev/null || true
            fi
            if [ -f "$SHARED_DIR/.env" ]; then
                cp -p "$SHARED_DIR/.env" "$BACKUP_DIR/.env" 2>/dev/null || true
            fi

            # Cleanly remove live symlinks if present
            if [ -L "$APP_DIR" ] || [ -f "$APP_DIR" ]; then
                rm -f "$APP_DIR" 2>/dev/null || true
            fi
            rm -f "$APP_DIR.tmp" 2>/dev/null || true

            # Move physical backup back to live path
            if [ ! -d "$APP_DIR" ]; then
                mv "$BACKUP_DIR" "$APP_DIR"
                echo "[MIGRATION-ROLLBACK] Restored physical directory from $BACKUP_DIR." >&2
                pm2 restart ai-video-editor-backend --update-env 2>/dev/null || pm2 reload ai-video-editor-backend --update-env 2>/dev/null || true
            else
                echo "[MIGRATION-WARN] $APP_DIR already exists as physical directory. Physical backup preserved at $BACKUP_DIR." >&2
            fi
        elif [ -d "$APP_DIR" ] && [ ! -L "$APP_DIR" ]; then
            echo "[MIGRATION-ROLLBACK] Cutover was interrupted before directory rename. Ensuring PM2 is started..." >&2
            pm2 start ai-video-editor-backend 2>/dev/null || pm2 reload ai-video-editor-backend --update-env 2>/dev/null || true
        fi
    fi
}
trap rollback_migration EXIT

# --- 2. Verified Full Tarball Backup ---
echo "[MIGRATION] Creating verified offline backup archive at $BACKUP_TAR..."
tar -czf "$BACKUP_TAR" -C "$HOME_DIR" ai-video-editor
echo "[MIGRATION] Verifying backup archive integrity..."
tar -tzf "$BACKUP_TAR" >/dev/null
echo "[MIGRATION] Backup archive successfully verified."

# --- 3. Initialize Shared Directory Hierarchy ---
echo "[MIGRATION] Initializing persistent shared directories..."
mkdir -p "$SHARED_DIR/storage" "$SHARED_DIR/logs" "$SHARED_DIR/db-snapshots" "$SHARED_DIR/diagnostics" "$RELEASES_DIR"
chmod 700 "$SHARED_DIR" "$SHARED_DIR/db-snapshots" "$SHARED_DIR/diagnostics"
chmod 750 "$SHARED_DIR/storage" "$SHARED_DIR/logs"
chmod 755 "$RELEASES_DIR"

# Ensure HOME_DIR allows search/traversal (+x) without read (+r) or write (+w) for web server
# Home directory group ownership remains strictly rasal:rasal (never transferred to www-data)
chmod 711 "$HOME_DIR"

# --- 4. Pre-cutover Initial Sync ---
echo "[MIGRATION] Performing pre-cutover bulk sync of media and logs..."
if [ -d "$APP_DIR/storage" ]; then
    rsync -a "$APP_DIR/storage/" "$SHARED_DIR/storage/"
fi
if [ -d "$APP_DIR/logs" ]; then
    rsync -a "$APP_DIR/logs/" "$SHARED_DIR/logs/"
fi

# --- 5. Populate Baseline Release Directory in Advance ---
echo "[MIGRATION] Populating legacy baseline release at $BASELINE_DIR..."
rm -rf "$BASELINE_DIR"
mkdir -p "$BASELINE_DIR"
cp -aT "$APP_DIR" "$BASELINE_DIR"

# Clean mutable files from baseline and link to shared state
rm -rf "$BASELINE_DIR/.env" "$BASELINE_DIR/storage" "$BASELINE_DIR/logs"
ln -sfn "$SHARED_DIR/.env" "$BASELINE_DIR/.env"
ln -sfn "$SHARED_DIR/storage" "$BASELINE_DIR/storage"
ln -sfn "$SHARED_DIR/logs" "$BASELINE_DIR/logs"
touch "$BASELINE_DIR/.activated"

# --- 6. Controlled Process Drain (Prevent In-Flight Write Corruption) ---
echo "[MIGRATION] Draining active processes to freeze in-flight writes..."
pm2 stop ai-video-editor-backend 2>/dev/null || true

# Verify no rogue/orphaned processes hold open write handles in storage
if command -v lsof &>/dev/null; then
    if lsof +D "$APP_DIR/storage" 2>/dev/null | grep -qE 'REG.*[0-9]+[wWuU]'; then
        echo "ERROR: Active processes still hold open write handles in storage! Aborting cutover." >&2
        pm2 start ai-video-editor-backend 2>/dev/null || true
        exit 1
    fi
fi

# --- 7. Deterministic Final Checksum Synchronization ---
echo "[MIGRATION] Performing final checksum sync for all runtime state..."
cp -p "$APP_DIR/.env" "$SHARED_DIR/.env"
chmod 600 "$SHARED_DIR/.env"

if [ -d "$APP_DIR/storage" ]; then
    rsync -a --checksum --delete "$APP_DIR/storage/" "$SHARED_DIR/storage/"
fi
if [ -d "$APP_DIR/logs" ]; then
    rsync -a --checksum --delete "$APP_DIR/logs/" "$SHARED_DIR/logs/"
fi

# Cryptographic integrity check: verify storage file count and hashes match
if [ -d "$APP_DIR/storage" ]; then
    SRC_HASHES=$(cd "$APP_DIR/storage" && find . -type f -exec sha256sum {} + | sort)
    DST_HASHES=$(cd "$SHARED_DIR/storage" && find . -type f -exec sha256sum {} + | sort)
    if [ "$SRC_HASHES" != "$DST_HASHES" ]; then
        echo "ERROR: Storage checksum mismatch during cutover! Aborting cutover." >&2
        pm2 start ai-video-editor-backend 2>/dev/null || pm2 reload ai-video-editor-backend 2>/dev/null || true
        exit 1
    fi
fi

# --- 8. Atomic Symlink Switch ---
echo "[MIGRATION] Moving physical directory to $BACKUP_DIR and activating symlink..."
mv "$APP_DIR" "$BACKUP_DIR"
ln -sfn "$BASELINE_DIR" "$APP_DIR.tmp"
mv -Tf "$APP_DIR.tmp" "$APP_DIR"

# --- 9. PM2 Process Start and Post-Migration Health Verification ---
echo "[MIGRATION] Starting PM2 backend process on symlinked release..."
pm2 start ai-video-editor-backend 2>/dev/null || pm2 reload ai-video-editor-backend --update-env 2>/dev/null || true

echo "[MIGRATION] Verifying post-migration health..."
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
    echo "[MIGRATION-SUCCESS] First-time migration completed successfully!"
    echo "Live link: $APP_DIR -> $(readlink -f "$APP_DIR")"
    echo "Physical backup retained at: $BACKUP_DIR"
    echo "Tarball backup retained at:  $BACKUP_TAR"
    echo "================================================================="
    exit 0
else
    echo "ERROR: Health verification failed after migration!" >&2
    exit 1
fi
