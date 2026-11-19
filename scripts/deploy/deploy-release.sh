#!/usr/bin/env bash
# ==============================================================================
# Production Release Deployment Wrapper for AI Video Editor
# Target Host: Ubuntu VM (10.70.70.46)
# Invocation:  sudo -u rasal /home/rasal/bin/deploy-release.sh <40-char-sha>
# Security:    Strict PATH, environment purge, origin verification,
#              branch reachability, late secret-binding, atomic promotion,
#              backend + database + frontend health checks, diagnostic capture
# ==============================================================================
set -euo pipefail

# --- A. Environment Sanitization and Controlled PATH ---
# Purge all potential override, debugging, and ambient variables
unset OVERRIDE_PATH OVERRIDE_HOME OVERRIDE_REPO_CACHE OVERRIDE_ORIGIN OVERRIDE_LOCK_FILE \
      NODE_OPTIONS npm_config_prefix LD_PRELOAD LD_LIBRARY_PATH PYTHONPATH 2>/dev/null || true

export PATH="/usr/local/bin:/usr/bin:/bin"
export LC_ALL=C
export LANG=C
export GIT_CONFIG_NOSYSTEM=1
export GIT_SSH_COMMAND="ssh -i /home/rasal/.ssh/ai-video-editor-deploy -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes"

# --- B. Strict Argument Validation ---
if [ "$#" -ne 1 ]; then
    echo "ERROR: Exactly 1 argument required. Usage: deploy-release.sh <40-char-commit-sha>" >&2
    exit 1
fi

COMMIT_SHA="$1"
if [[ ! "$COMMIT_SHA" =~ ^[0-9a-f]{40}$ ]]; then
    echo "ERROR: Invalid commit SHA format. Must be a 40-character lowercase hexadecimal hash." >&2
    exit 1
fi

# --- C. Immutable Fixed Paths & Constants ---
readonly DEPLOY_USER="rasal"
readonly HOME_DIR="/home/rasal"
readonly SHARED_DIR="$HOME_DIR/shared"
readonly RELEASES_DIR="$HOME_DIR/releases"
readonly LIVE_LINK="$HOME_DIR/ai-video-editor"
readonly TMP_LINK="$HOME_DIR/ai-video-editor.tmp"
readonly REPO_CACHE="$HOME_DIR/repo-cache.git"
readonly EXPECTED_ORIGIN="git@github.com:Rasal188/ai-video-editor-app.git"
readonly DB_SNAPSHOT_DIR="$SHARED_DIR/db-snapshots"
readonly DIAGNOSTICS_DIR="$SHARED_DIR/diagnostics"
readonly LOCK_FILE="$SHARED_DIR/.deploy.lock"
readonly NEW_RELEASE_DIR="$RELEASES_DIR/$COMMIT_SHA"

# --- D. Concurrency Protection Lock ---
mkdir -p "$SHARED_DIR"
exec 200>"$LOCK_FILE"
if ! flock -n 200; then
    echo "ERROR: Another deployment is currently in progress. Aborting." >&2
    exit 1
fi

# --- E. Staging Cleanup Trap on Failure ---
cleanup_on_abort() {
    local exit_code=$?
    if [ $exit_code -ne 0 ]; then
        if [ -d "$NEW_RELEASE_DIR" ] && [ ! -f "$NEW_RELEASE_DIR/.activated" ]; then
            echo "[DEPLOY-CLEANUP] Removing unactivated staging release $NEW_RELEASE_DIR..."
            rm -rf "$NEW_RELEASE_DIR"
        fi
        if [ -L "$TMP_LINK" ] || [ -e "$TMP_LINK" ]; then
            rm -f "$TMP_LINK"
        fi
    fi
}
trap cleanup_on_abort EXIT

# --- F. Usability Verification of Previous Active Release ---
PREV_RELEASE=""
VALID_PREV_RELEASE=""
if [ -L "$LIVE_LINK" ]; then
    PREV_RELEASE=$(readlink -f "$LIVE_LINK" 2>/dev/null || true)
    if [ -n "$PREV_RELEASE" ] && [ -d "$PREV_RELEASE" ]; then
        if [ -f "$PREV_RELEASE/server/index.js" ] && [ -f "$PREV_RELEASE/dist/index.html" ]; then
            VALID_PREV_RELEASE="$PREV_RELEASE"
            echo "[DEPLOY-INFO] Verified previous active release: $VALID_PREV_RELEASE"
        else
            echo "[DEPLOY-WARN] Current live link target is missing critical application files: $PREV_RELEASE" >&2
        fi
    fi
elif [ -e "$LIVE_LINK" ]; then
    echo "ERROR: $LIVE_LINK is not a symlink! Run first-time migration before deploying." >&2
    exit 1
fi

# --- G. Verify Bare Git Mirror, Remote Origin & Branch Reachability ---
if [ ! -d "$REPO_CACHE" ]; then
    echo "[DEPLOY] Initializing bare repository cache from $EXPECTED_ORIGIN..."
    git -c core.hooksPath=/dev/null clone --bare "$EXPECTED_ORIGIN" "$REPO_CACHE"
fi

CACHE_REMOTE=$(git -c core.hooksPath=/dev/null --git-dir="$REPO_CACHE" remote get-url origin 2>/dev/null || echo "")
if [ "$CACHE_REMOTE" != "$EXPECTED_ORIGIN" ]; then
    echo "ERROR: Remote cache origin mismatch ($CACHE_REMOTE != $EXPECTED_ORIGIN)" >&2
    exit 1
fi

echo "[DEPLOY] Fetching latest refs from origin main..."
# STRICT: No '|| true'. Fetch failure must abort deployment immediately.
git -c core.hooksPath=/dev/null --git-dir="$REPO_CACHE" fetch --prune origin refs/heads/main:refs/remotes/origin/main

# Verify target commit exists in repository mirror
if ! git -c core.hooksPath=/dev/null --git-dir="$REPO_CACHE" cat-file -e "$COMMIT_SHA^{commit}" 2>/dev/null; then
    echo "ERROR: Target commit $COMMIT_SHA does not exist in repository mirror." >&2
    exit 1
fi

# STRICT: Reachability check. Commit MUST be an ancestor of or equal to origin/main
if ! git -c core.hooksPath=/dev/null --git-dir="$REPO_CACHE" merge-base --is-ancestor "$COMMIT_SHA" origin/main 2>/dev/null; then
    echo "ERROR: Target commit $COMMIT_SHA is not reachable from origin/main. Rejecting unmerged or stale commit." >&2
    exit 1
fi

# --- H. Freshness Check: Prevent Stale or Out-of-Order Deployments ---
if [ -n "$VALID_PREV_RELEASE" ]; then
    ACTIVE_RELEASE_NAME=$(basename "$VALID_PREV_RELEASE")
    if [[ "$ACTIVE_RELEASE_NAME" =~ ^[0-9a-f]{40}$ ]]; then
        if git -c core.hooksPath=/dev/null --git-dir="$REPO_CACHE" merge-base --is-ancestor "$COMMIT_SHA" "$ACTIVE_RELEASE_NAME" 2>/dev/null; then
            if [ "$COMMIT_SHA" != "$ACTIVE_RELEASE_NAME" ]; then
                echo "ERROR: Freshness check failed. Target commit $COMMIT_SHA is an ancestor of currently active release $ACTIVE_RELEASE_NAME. Out-of-order or stale deployment rejected." >&2
                exit 1
            else
                echo "ERROR: Commit $COMMIT_SHA is already the active production release." >&2
                exit 1
            fi
        fi
    fi
fi

# --- I. Prepare Immutable Release Directory from Verified Commit ---
if [ -d "$NEW_RELEASE_DIR" ]; then
    if [ -f "$NEW_RELEASE_DIR/.activated" ] && [ "$VALID_PREV_RELEASE" = "$NEW_RELEASE_DIR" ]; then
        echo "ERROR: Commit $COMMIT_SHA is already the active production release." >&2
        exit 1
    fi
    echo "[DEPLOY-INFO] Cleaning existing inactive release directory for $COMMIT_SHA..."
    rm -rf "$NEW_RELEASE_DIR"
fi

mkdir -p "$NEW_RELEASE_DIR" "$DB_SNAPSHOT_DIR" "$DIAGNOSTICS_DIR" "$SHARED_DIR/storage" "$SHARED_DIR/logs"
echo "[DEPLOY] Extracting clean commit tree into $NEW_RELEASE_DIR..."
git -c core.hooksPath=/dev/null --git-dir="$REPO_CACHE" archive "$COMMIT_SHA" | tar -x -C "$NEW_RELEASE_DIR"

# Security audit: Verify payload contains NO protected runtime state files
for protected_name in .env storage logs; do
    if [ -e "$NEW_RELEASE_DIR/$protected_name" ]; then
        echo "ERROR: Security violation - payload contains protected runtime path '$protected_name'!" >&2
        exit 1
    fi
done

# Bind shared storage and logs (non-secret directories)
ln -sfn "$SHARED_DIR/storage" "$NEW_RELEASE_DIR/storage"
ln -sfn "$SHARED_DIR/logs" "$NEW_RELEASE_DIR/logs"

# NOTE: .env is intentionally NOT symlinked yet.
# Secrets remain isolated from npm ci and npm run build.

# --- I. Staging Build & Runtime Dependency Strategy ---
echo "[DEPLOY] Installing dependencies and compiling frontend in staging..."
cd "$NEW_RELEASE_DIR"

# Production is CPU-only, so skip only the optional ONNX Runtime CUDA archive.
# CPU ONNX Runtime and all other required native binaries are still installed.
ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm ci
NODE_OPTIONS="--max-old-space-size=4096" npm run build
npm prune --omit=dev

# Verify required runtime artifacts exist before proceeding
if [ ! -f "$NEW_RELEASE_DIR/dist/index.html" ]; then
    echo "ERROR: Frontend compilation failed - dist/index.html not found!" >&2
    exit 1
fi
if [ ! -f "$NEW_RELEASE_DIR/server/index.js" ]; then
    echo "ERROR: Backend entrypoint server/index.js not found!" >&2
    exit 1
fi

# Set permissions on static dist directory for Nginx www-data traversal
chmod 755 "$NEW_RELEASE_DIR" "$NEW_RELEASE_DIR/dist"
chmod -R u=rwX,go=rX "$NEW_RELEASE_DIR/dist"
if getent group www-data &>/dev/null; then
    chgrp -R www-data "$NEW_RELEASE_DIR/dist" 2>/dev/null || true
fi

# Late-bind production secrets ONLY AFTER build phase is complete
ln -sfn "$SHARED_DIR/.env" "$NEW_RELEASE_DIR/.env"

# --- J. Pre-Migration Database Schema Snapshot & Validation ---
SCHEMA_SNAPSHOT="$DB_SNAPSHOT_DIR/schema-pre-$COMMIT_SHA.sql"
echo "[DEPLOY] Generating pre-migration schema snapshot at $SCHEMA_SNAPSHOT..."
DB_TARGET="ai_video_editor"
if [ -f "$SHARED_DIR/.env" ]; then
    ENV_DB_URL=$(grep -E '^[[:space:]]*DATABASE_URL=' "$SHARED_DIR/.env" | cut -d '=' -f2- | tr -d '"' | tr -d "'" | tr -d '\r' || true)
    if [ -n "$ENV_DB_URL" ]; then
        DB_TARGET="$ENV_DB_URL"
    fi
fi
if ! pg_dump -d "$DB_TARGET" --schema-only --no-owner --no-privileges > "$SCHEMA_SNAPSHOT" 2>/dev/null; then
    echo "ERROR: Failed to create database schema snapshot via pg_dump. Aborting deployment." >&2
    exit 1
fi

if [ ! -s "$SCHEMA_SNAPSHOT" ] || ! grep -q "CREATE TABLE" "$SCHEMA_SNAPSHOT"; then
    echo "ERROR: Schema snapshot validation failed (empty or invalid output). Aborting." >&2
    exit 1
fi

# --- K. Diagnostic Capture & Rollback Function Definition ---
capture_diagnostics() {
    local context="$1"
    local diag_file="$DIAGNOSTICS_DIR/incident-$(date +%s).log"
    echo "[DEPLOY-DIAGNOSTICS] Capturing failure diagnostics to $diag_file..." >&2
    {
        echo "=== INCIDENT CONTEXT: $context ==="
        echo "Timestamp: $(date -u +'%Y-%m-%dT%H:%M:%SZ')"
        echo "Target Commit: $COMMIT_SHA"
        echo "Previous Release: $VALID_PREV_RELEASE"
        echo "=== PM2 STATUS ==="
        pm2 status 2>&1 || true
        echo "=== HEALTH CHECK ENDPOINT ==="
        curl -v -s "http://127.0.0.1/health" 2>&1 || true
        echo "=== FRONTEND ENDPOINT ==="
        curl -v -s "http://127.0.0.1/" 2>&1 || true
        echo "=== BACKEND APPLICATION LOGS (LAST 50 LINES) ==="
        tail -n 50 "$SHARED_DIR/logs/"*.log 2>&1 || true
    } > "$diag_file" 2>&1 || true
    echo "[DEPLOY-DIAGNOSTICS] Diagnostic file written: $diag_file" >&2
}

rollback_activation() {
    local reason="${1:-Application failed health checks after activation}"
    echo "[DEPLOY-FAILED] $reason! Initiating rollback..." >&2

    capture_diagnostics "Post-Activation Failure: $reason"

    if [ -n "$VALID_PREV_RELEASE" ] && [ -d "$VALID_PREV_RELEASE" ]; then
        echo "[DEPLOY-ROLLBACK] Reverting live symlink to verified previous release: $VALID_PREV_RELEASE..."
        ln -sfn "$VALID_PREV_RELEASE" "$TMP_LINK"
        mv -Tf "$TMP_LINK" "$LIVE_LINK"
        pm2 reload ai-video-editor-backend --update-env || pm2 restart ai-video-editor-backend --update-env || true

        # Verify health of the rolled-back release
        echo "[DEPLOY-ROLLBACK] Verifying rollback release health..."
        local rb_healthy=false
        for attempt in 1 2 3; do
            local rb_code
            rb_code=$(curl -s -o /tmp/rb_health.json -w "%{http_code}" "http://127.0.0.1/health" 2>/dev/null || echo "000")
            if [ "$rb_code" = "200" ] && grep -q '"status":"ok"' /tmp/rb_health.json 2>/dev/null; then
                rb_healthy=true
                break
            fi
            sleep 1
        done

        if [ "$rb_healthy" = "true" ]; then
            echo "[DEPLOY-ROLLBACK-SUCCESS] Reverted to previous release $VALID_PREV_RELEASE and verified healthy." >&2
        else
            echo "[DEPLOY-CRITICAL-ALERT] CRITICAL: Rollback attempted but previous release is ALSO failing health checks!" >&2
            capture_diagnostics "Failed Rollback Health Check"
            exit 2
        fi
    else
        echo "[DEPLOY-CRITICAL-ALERT] CRITICAL: No verified previous release directory exists for rollback!" >&2
        capture_diagnostics "No Rollback Target Available"
        exit 2
    fi
    exit 1
}

# --- L. Database Migrations (Additive / Backward-Compatible Only) ---
echo "[DEPLOY] Applying database migrations..."
node server/db/migrate.js || {
    echo "ERROR: Database migration failed. Staging release aborted. Live application remains untouched." >&2
    capture_diagnostics "Migration Execution Failure"
    exit 1
}

# --- M. Hardened Same-Filesystem and Symlink Validation ---
echo "[DEPLOY] Validating filesystem and symlink constraints for atomic rename..."
LIVE_PARENT=$(dirname "$LIVE_LINK")

# 1. Parent directory must exist and be writable
if [ ! -d "$LIVE_PARENT" ] || [ ! -w "$LIVE_PARENT" ]; then
    echo "ERROR: Live parent directory '$LIVE_PARENT' is not writable." >&2
    exit 1
fi

# 2. Live link must not be an active filesystem mountpoint
if command -v mountpoint &>/dev/null && mountpoint -q "$LIVE_LINK" 2>/dev/null; then
    echo "ERROR: '$LIVE_LINK' is a filesystem mountpoint, cannot atomically replace with symlink!" >&2
    exit 1
fi

# 3. Create temporary symlink and verify device ID matches parent directory
ln -sfn "$NEW_RELEASE_DIR" "$TMP_LINK"
TMP_DEV=$(stat -c %d "$TMP_LINK" 2>/dev/null || stat -f -c %d "$TMP_LINK" 2>/dev/null || echo "")
PARENT_DEV=$(stat -c %d "$LIVE_PARENT" 2>/dev/null || stat -f -c %d "$LIVE_PARENT" 2>/dev/null || echo "")

if [ -n "$TMP_DEV" ] && [ -n "$PARENT_DEV" ] && [ "$TMP_DEV" != "$PARENT_DEV" ]; then
    echo "ERROR: Filesystem mismatch between temporary symlink and live parent directory." >&2
    rm -f "$TMP_LINK"
    exit 1
fi

# 4. Verify temporary symlink points to target release
if [ "$(readlink "$TMP_LINK")" != "$NEW_RELEASE_DIR" ]; then
    echo "ERROR: Temporary symlink target mismatch!" >&2
    rm -f "$TMP_LINK"
    exit 1
fi

# --- N. Genuinely Atomic Release Activation ---
echo "[DEPLOY] Activating release $COMMIT_SHA atomically via rename..."
touch "$NEW_RELEASE_DIR/.activated"
mv -Tf "$TMP_LINK" "$LIVE_LINK"

# --- O. PM2 Backend Zero-Downtime Reload ---
echo "[DEPLOY] Reloading PM2 backend process..."
if ! pm2 reload ai-video-editor-backend --update-env 2>/dev/null; then
    rollback_activation "PM2 process reload failed"
fi

# --- P. Comprehensive Multi-Vector Health Verification ---
echo "[DEPLOY] Verifying comprehensive release health (Backend, Database, Frontend)..."
HEALTHY_BACKEND=false
HEALTHY_DATABASE=false
HEALTHY_FRONTEND=false

for attempt in 1 2 3 4 5; do
    # 1. Check Backend and Database connectivity via /health
    HTTP_CODE=$(curl -s -o /tmp/health_response_check.json -w "%{http_code}" "http://127.0.0.1/health" 2>/dev/null || echo "000")
    if [ "$HTTP_CODE" = "200" ] && grep -q '"status":"ok"' /tmp/health_response_check.json 2>/dev/null; then
        HEALTHY_BACKEND=true
        if grep -q '"database":{"ok":true' /tmp/health_response_check.json 2>/dev/null; then
            HEALTHY_DATABASE=true
        fi
    fi

    # 2. Check Frontend Asset Delivery via /
    FE_CODE=$(curl -s -o /tmp/fe_response_check.html -w "%{http_code}" "http://127.0.0.1/" 2>/dev/null || echo "000")
    if [ "$FE_CODE" = "200" ] && grep -q -i 'doctype html' /tmp/fe_response_check.html 2>/dev/null; then
        HEALTHY_FRONTEND=true
    fi

    if [ "$HEALTHY_BACKEND" = "true" ] && [ "$HEALTHY_DATABASE" = "true" ] && [ "$HEALTHY_FRONTEND" = "true" ]; then
        break
    fi
    sleep 1
done

if [ "$HEALTHY_BACKEND" != "true" ]; then
    rollback_activation "Backend service health check failed"
fi
if [ "$HEALTHY_DATABASE" != "true" ]; then
    rollback_activation "Database connectivity check failed (database.ok is not true)"
fi
if [ "$HEALTHY_FRONTEND" != "true" ]; then
    rollback_activation "Frontend static asset delivery check failed (/ did not return valid HTML)"
fi

# --- Q. Safe Cleanup of Old Inactive Releases ---
echo "[DEPLOY] Pruning old inactive releases (keeping last 5)..."
ACTIVE_TARGET=$(readlink -f "$LIVE_LINK" 2>/dev/null || true)
find "$RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d | sort -r | tail -n +6 | while read -r old_release; do
    # Invariant: Never delete active release or previous rollback release
    if [ "$old_release" != "$ACTIVE_TARGET" ] && [ "$old_release" != "$VALID_PREV_RELEASE" ]; then
        echo "[DEPLOY-CLEANUP] Pruning old release: $old_release"
        rm -rf "$old_release"
    fi
done

echo "[DEPLOY-SUCCESS] Release $COMMIT_SHA successfully deployed, verified, and activated."
exit 0
