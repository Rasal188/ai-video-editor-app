#!/usr/bin/env bash
# ==============================================================================
# Safe Receiver Drain & Ingress Termination Script
# Safely verifies that no active receiver, SSH transfer, or tar extraction is running.
# Never automatically kills broad process patterns; stops for operator review on timeout.
# ==============================================================================
set -euo pipefail

TIMEOUT_SEC="${1:-30}"

get_active_receiver_pids() {
    local self_pid="$$"
    local parent_pid="$PPID"
    pgrep -u rasal -f '(/home/rasal/bin/vm-deploy-receiver\.sh|tar.*ai-video-editor)' 2>/dev/null | \
        grep -v -E "^(${self_pid}|${parent_pid})$" || true
}

echo "[DRAIN] Checking for active legacy receiver or tar extraction processes..."
elapsed=0

while [ "$elapsed" -lt "$TIMEOUT_SEC" ]; do
    active_pids=$(get_active_receiver_pids)
    if [ -z "$active_pids" ]; then
        echo "[DRAIN-SUCCESS] No active receiver or tar extraction processes detected."
        exit 0
    fi
    echo "[DRAIN-WAIT] Active PIDs detected: $active_pids (elapsed: ${elapsed}s / ${TIMEOUT_SEC}s)..."
    sleep 1
    elapsed=$((elapsed + 1))
done

echo "==========================================================================" >&2
echo "ERROR: Receiver processes did not terminate within ${TIMEOUT_SEC}s timeout!" >&2
echo "Active Process Details:" >&2
for pid in $(get_active_receiver_pids); do
    ps -f --forest -p "$pid" >&2 || ps -fp "$pid" >&2 || true
done
echo "" >&2
echo "STOPPING CUTOVER FOR OPERATOR REVIEW." >&2
echo "Do NOT automatically kill processes. Inspect active operation first." >&2
echo "==========================================================================" >&2
exit 2
