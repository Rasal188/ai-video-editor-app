# Timeline Studio — AI Video Editor

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg)](package.json)
[![Database](https://img.shields.io/badge/database-PostgreSQL%2016-blue.svg)](docker-compose.yml)
[![Rendering](https://img.shields.io/badge/engine-FFmpeg%20%2B%20WebCodecs-orange.svg)](scripts/timeline-command.mjs)

Timeline Studio is a full-stack, local-first AI video editor. It pairs a rich browser editing studio (WebGPU AI music, AI repair, multilingual voiceovers, automatic captions, and talking avatars) with a robust Node.js/Express backend, PostgreSQL persistence, session-based OTP authentication, and a headless CLI render engine powered by FFmpeg.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Prerequisites](#prerequisites)
3. [Quick Start (Local Development)](#quick-start-local-development)
4. [Environment Configuration](#environment-configuration)
5. [Database Setup & Migrations](#database-setup--migrations)
6. [Authentication & Email Delivery](#authentication--email-delivery)
7. [FFmpeg & Headless Rendering](#ffmpeg--headless-rendering)
8. [CLI Tooling & Command Engine](#cli-tooling--command-engine)
9. [Testing & Quality Verification](#testing--quality-verification)
10. [Production Build & Deployment](#production-build--deployment)
11. [Troubleshooting](#troubleshooting)
12. [License](#license)

---

## Architecture Overview

```
                      ┌───────────────────────────────────────┐
                      │    Client (Vite React Browser App)    │
                      │    - Multi-track timeline editor      │
                      │    - WebGPU / ONNX AI capabilities    │
                      │    - AuthGate & Cloud Sync Modals     │
                      └──────────────────┬────────────────────┘
                                         │ HTTP REST / JSON (Cookie Session)
                                         ▼
                      ┌───────────────────────────────────────┐
                      │        Express Backend Server         │
                      │  - /api/auth (Passwordless Email OTP) │
                      │  - /api/projects (Metadata & versions)│
                      │  - /api/renders (CLI render execution)│
                      │  - /health (Live PostgreSQL probe)    │
                      └──────────┬─────────────────┬──────────┘
                                 │                 │
         Relational Metadata     │                 │ Local / Object Storage
         (Parameterized SQL)     ▼                 ▼
             ┌─────────────────────────┐     ┌───────────────────────┐
             │       PostgreSQL        │     │  .timeline Archives   │
             │  - users                │     │  & Rendered Media     │
             │  - projects             │     │  (storage/ directory) │
             │  - project_versions     │     └───────────────────────┘
             │  - assets               │                 ▲
             │  - render_jobs          │                 │ Reads & outputs
             └─────────────────────────┘                 │
                                                         ▼
                                             ┌───────────────────────┐
                                             │ Headless CLI Engine   │
                                             │ - timeline-command.mjs│
                                             │ - FFmpeg & FFprobe    │
                                             └───────────────────────┘
```

---

## Prerequisites

Before building or running the project, ensure you have the following installed on your machine:

1. **Node.js**: `v20.0.0` or higher (`v22+` recommended).
   Verify with:
   ```bash
   node -v
   npm -v
   ```
2. **Docker & Docker Compose** (Recommended for PostgreSQL):
   Verify with:
   ```bash
   docker --version
   docker compose version
   ```
   *(Alternatively, a local PostgreSQL 16 instance running on port 5432).*
3. **FFmpeg & FFprobe**:
   Required for CLI media inspection, audio stream probing, and headless video rendering.
   Verify with:
   ```bash
   ffmpeg -version
   ffprobe -version
   ```
   - **macOS**: `brew install ffmpeg`
   - **Linux (Ubuntu/Debian)**: `sudo apt update && sudo apt install -y ffmpeg`
   - **Windows**: `winget install Gyan.FFmpeg` or `choco install ffmpeg`
4. **Modern Chromium Browser**:
   Chrome, Edge, or Brave with WebGPU and SharedArrayBuffer support enabled.

---

## Quick Start (Local Development)

### 1. Clone the Repository

```bash
git clone https://github.com/Rasal188/ai-video-editor-app.git
cd ai-video-editor-app
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Configure Environment

Copy the example environment file:

```bash
cp .env.example .env
```
*(The default settings in `.env.example` work out-of-the-box for local development using Docker Compose and mock email OTP).*

### 4. Start PostgreSQL & Run Migrations

```bash
# Start PostgreSQL container in the background
docker compose up -d

# Run database migrations
npm run db:migrate
```

### 5. Start Backend Server

In a terminal, start the Express backend on port `3001`:

```bash
npm run server
```

Verify backend health by visiting [http://localhost:3001/health](http://localhost:3001/health). It should return:
```json
{
  "status": "ok",
  "database": {
    "status": "healthy"
  }
}
```

### 6. Start Frontend Studio

In a second terminal, start the Vite development server on port `5173`:

```bash
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) in your browser.

---

## Environment Configuration

All environment variables are documented with safe placeholders in `.env.example`:

| Variable | Default Value | Description |
|---|---|---|
| `PORT` | `3001` | Port on which the Express backend listens. |
| `HOST` | `0.0.0.0` | Host bind address for the backend. |
| `NODE_ENV` | `development` | Runtime environment (`development`, `production`, `test`). |
| `CORS_ORIGIN` | `http://localhost:5173` | Allowed origin for CORS requests from the frontend. |
| `DATABASE_URL` | `postgres://postgres:postgres@localhost:5432/ai_video_editor` | PostgreSQL connection string. |
| `DATABASE_MAX_CONNECTIONS`| `10` | Maximum connections in the database pool. |
| `DATABASE_IDLE_TIMEOUT_MS`| `30000` | Idle timeout before closing pool client. |
| `DATABASE_CONNECTION_TIMEOUT_MS` | `5000` | Timeout for establishing new database connection. |
| `DATABASE_SSL` | `false` | Enable SSL for managed cloud databases (`true` / `false`). |
| `STORAGE_DIRECTORY` | `storage` | Local directory for `.timeline` archives and rendered videos. |
| `MAX_UPLOAD_SIZE_BYTES` | `524288000` | Maximum asset/archive upload size (500 MB default). |
| `AUTH_OTP_EXPIRES_MINUTES` | `10` | Lifetime of an email OTP code in minutes. |
| `AUTH_OTP_MAX_ATTEMPTS` | `5` | Maximum failed attempts allowed before OTP challenge is locked. |
| `AUTH_OTP_COOLDOWN_SECONDS` | `60` | Minimum wait time before requesting another OTP for the same email. |
| `AUTH_SESSION_DURATION_DAYS`| `7` | Session lifetime stored in HttpOnly cookie. |
| `AUTH_COOKIE_NAME` | `timeline_session` | Name of the HttpOnly session cookie. |
| `AUTH_SALT` | `replace-with-a-secure-random-salt` | Secret salt used for hashing OTPs and session tokens. |
| `EMAIL_PROVIDER` | `mock` | Delivery provider: `mock` (logs to console) or `ollastack` (HTTP API). |
| `OLLASTACK_BASE_URL` | `https://login.ollastack.com` | Base URL of the OllaStack service. |
| `OLLASTACK_API_KEY` | *(empty)* | API Bearer token for OllaStack (required if `EMAIL_PROVIDER=ollastack`). |
| `OLLASTACK_MAILBOX_ID` | *(empty)* | Claimed Mailbox ID in OllaStack (required if `EMAIL_PROVIDER=ollastack`). |

---

## Database Setup & Migrations

The project includes declarative SQL migrations and an automated migration runner.

### Using Docker Compose

The included `docker-compose.yml` configures a PostgreSQL 16 container with a persistent volume and automated healthcheck:

```bash
# Start container
docker compose up -d

# Stop container
docker compose down

# Check status
docker compose ps
```

### Running Migrations

Execute the migration runner to apply all pending schema changes:

```bash
npm run db:migrate
# or
npm run migrate
```

Migrations are tracked idempotently in the `schema_migrations` table. Re-running the command safely detects applied versions.

---

## Authentication & Email Delivery

Timeline Studio features passwordless email authentication with one-time passcodes (OTP).

### 1. Local Development (`EMAIL_PROVIDER=mock`)
By default, the backend operates in mock mode. When you request an OTP code in the browser:
- The backend generates a secure 6-digit code.
- The code is printed directly to the **backend terminal log**:
  ```text
  [MockEmailProvider] Sent email to user@example.com
  Subject: Your Timeline Studio Verification Code
  Code: 123456
  ```
- Enter the code in the modal to immediately establish an authenticated session.

### 2. Production (`EMAIL_PROVIDER=ollastack`)
For live email delivery:
1. Set `EMAIL_PROVIDER=ollastack` in `.env`.
2. Provide your OllaStack API Key: `OLLASTACK_API_KEY=your_key_here`.
3. Provide your mailbox identifier: `OLLASTACK_MAILBOX_ID=mb_your_mailbox_id`.
4. The backend communicates directly with `POST https://login.ollastack.com/api/mailboxes/{mailboxId}/send` conforming to OllaStack's OpenAPI specification.

---

## FFmpeg & Headless Rendering

The headless render engine translates `.timeline` archive projects into complete FFmpeg filtergraphs and produces verified MP4 videos.

### Supported Headless Render Features
- **Visual Segments**: Contiguous sequencing, custom resolution & aspect ratios (16:9, 9:16, 1:1, 4:5), letterboxing/pad, scaling, and fps conversion.
- **Embedded Video Audio**: Extracts, synchronizes, trims, scales volume, and adjusts tempo for video clips that contain audio.
- **Silence Synchronization**: Clips without audio (or images) automatically generate matching silence (`anullsrc`) to prevent video/audio drift across splits and transitions.
- **Audio Mixing**: Mixes embedded video audio with independent AI voiceover tracks (`project.audioSegments`) and background music tracks (`project.musicSegments`) via FFmpeg `amix`.
- **Pure Silent Projects**: Disables audio cleanly with `-an` when no audio tracks exist.
- **Encoding**: Produces standard web-compatible H.264 video with AAC stereo audio (`192k`, `44100 Hz`).

---

## CLI Tooling & Command Engine

The CLI tool allows programmatic inspection, modification, and headless rendering of `.timeline` archives:

```bash
npm run agent -- <command> <argument> [selector]
```

### 1. Project & Track Inspection
```bash
# Inspect overall project metadata, duration, track counts, and media inventory
npm run agent -- project.inspect path/to/project.timeline

# Inspect specific track (visuals, audio, music, caption, etc.)
npm run agent -- track.inspect path/to/project.timeline visuals

# Inspect specific clip
npm run agent -- clip.inspect path/to/project.timeline visual-123
```

### 2. Declarative Operation Planning (`diff` & `run`)
Execute atomic operations (splits, trims, moves, imports, volume adjustments) via a versioned JSON plan:

```bash
# Dry run: view predicted changes and warnings without writing
npm run agent -- project.diff path/to/edit-plan.json

# Execute plan: applies edits transactionally and outputs new .timeline archive
npm run agent -- project.run path/to/edit-plan.json
```

### 3. Headless Render Request
Render a `.timeline` project to MP4 using FFmpeg:

```bash
npm run agent -- project.render path/to/render-request.json
```

**Example `render-request.json`:**
```json
{
  "schemaVersion": 1,
  "project": "C:/path/to/project.timeline",
  "output": {
    "video": "C:/path/to/output.mp4"
  },
  "render": {
    "width": 1280,
    "height": 720,
    "frameRate": 30,
    "preset": "medium",
    "crf": 18
  }
}
```

---

## Testing & Quality Verification

Timeline Studio maintains a comprehensive test suite across the backend, rendering engine, and frontend assets.

```bash
# Run backend & render regression test suite (66 tests)
npm run test:backend

# Run ESLint code quality audit
npm run lint

# Run TypeScript typecheck
npm run typecheck

# Run production bundle build
npm run build

# Run all checks in a single command
npm run check
```

---

## Production Build & Deployment

### Building the Frontend

```bash
npm run build
```
Build output is saved to `dist/`, including web workers, WASM runtimes, and optimized bundles.

To preview the production bundle locally:
```bash
npm run preview
```

### Running Backend in Production

```bash
NODE_ENV=production npm run server
```

In production, ensure:
- `CORS_ORIGIN` matches your production frontend URL.
- `DATABASE_SSL=true` if using a managed cloud database (AWS RDS, Neon, Supabase, Cloud SQL).
- `STORAGE_DIRECTORY` points to a persistent volume or mounted storage bucket.
- `AUTH_SALT` is configured with a secure high-entropy secret.

---

## Troubleshooting

### 1. Database Connection Refused (`ECONNREFUSED 127.0.0.1:5432`)
- Ensure Docker is running: `docker compose ps`
- Start the database: `docker compose up -d`
- Check PostgreSQL container logs: `docker compose logs postgres`

### 2. Missing FFmpeg / FFprobe
- If you see `Error: spawn ffprobe ENOENT` or `spawn ffmpeg ENOENT`:
- Ensure FFmpeg is installed and added to your system `PATH`.
- Test by running `ffmpeg -version` and `ffprobe -version` in a fresh terminal.

### 3. OTP Code Not Received
- If `EMAIL_PROVIDER=mock`, check your **backend terminal output** for the generated 6-digit code.
- If using `EMAIL_PROVIDER=ollastack`, verify your `OLLASTACK_API_KEY` and `OLLASTACK_MAILBOX_ID` in `.env`.

### 4. Cross-Origin Isolation Warnings in Browser
- Features like WebGPU, FFmpeg WASM, and WebCodecs require `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`.
- These headers are pre-configured in `vite.config.mjs`, `server/index.js`, and `netlify.toml`.

---

## License

Timeline Studio's source code is licensed under the [MIT License](LICENSE).
Third-party models, weights, and datasets downloaded at runtime are subject to their respective upstream licenses. See [MODEL_LICENSES.md](MODEL_LICENSES.md) for details.
