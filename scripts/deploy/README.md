# Production Deployment & Migration Guide

Target Host: `10.70.70.46` (Ubuntu 24.04 LTS)
Target Application: AI Video Editor (`Rasal188/ai-video-editor-app`)

---

## Architecture Overview

```
GitHub Actions (Workflow: Deploy to Production VM)
    │
    ▼ (self-hosted runner: github-runner)
sudo -u rasal /home/rasal/bin/deploy-release.sh <40-char-sha>
    │
    ├─► flock on /home/rasal/shared/.deploy.lock
    ├─► Fetch bare mirror: /home/rasal/repo-cache.git
    ├─► Verify branch reachability & freshness
    ├─► Build in staging: /home/rasal/releases/<SHA>
    ├─► Pre-migration schema snapshot: /home/rasal/shared/db-snapshots/
    ├─► Run database migrations: node server/db/migrate.js
    ├─► Atomic symlink switch: /home/rasal/ai-video-editor -> /home/rasal/releases/<SHA>
    ├─► PM2 zero-downtime reload: pm2 reload ai-video-editor-backend --update-env
    └─► Multi-vector health verification (/health + /)
```

---

## File Directory

- `deploy-release.sh`: The immutable release deployment wrapper invoked by GitHub Actions runner.
- `first-time-migration.sh`: Reversible one-time migration moving physical directory `/home/rasal/ai-video-editor` to symlink layout.
- `rollback-first-time-migration.sh`: Reversal script restoring physical directory layout.
- `drain-legacy-receiver.sh`: Process drain and ingress disable helper for decommissioning legacy watcher/receiver.
- `recover-interrupted-sync.sh`: Data-preserving recovery procedure for any interrupted legacy sync.

---

## Production Prerequisites (External Setup)

### 1. Runner User & Sudoers File (`/etc/sudoers.d/github-runner`)
On the target VM (`10.70.70.46`), configure user `github-runner`:
```bash
sudo useradd -m -s /bin/bash github-runner
sudo usermod -aG rasal github-runner
```
Install `/etc/sudoers.d/github-runner` (mode `0440`):
```sudoers
github-runner ALL=(rasal) NOPASSWD: /home/rasal/bin/deploy-release.sh [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]
```
Validate syntax:
```bash
sudo visudo -c -f /etc/sudoers.d/github-runner
```

### 2. Wrapper Installation for User `rasal`
```bash
mkdir -p /home/rasal/bin
cp scripts/deploy/deploy-release.sh /home/rasal/bin/deploy-release.sh
chmod 0750 /home/rasal/bin/deploy-release.sh
chown rasal:rasal /home/rasal/bin/deploy-release.sh
```

### 3. Decommission Legacy Watcher & Receiver
1. On Windows: Run `powershell -File scripts/stop-dev-sync.ps1`.
2. On VM: Disable receiver:
   ```bash
   chmod 000 /home/rasal/bin/vm-deploy-receiver.sh && mv /home/rasal/bin/vm-deploy-receiver.sh /home/rasal/bin/vm-deploy-receiver.sh.disabled
   ```
3. On VM: Drain active processes:
   ```bash
   bash scripts/deploy/drain-legacy-receiver.sh 30
   ```

### 4. Execute First-Time Migration
As user `rasal` on the VM:
```bash
bash scripts/deploy/first-time-migration.sh
```
Verify health:
```bash
curl -s http://127.0.0.1/health
```
