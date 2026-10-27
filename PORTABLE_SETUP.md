# Timeline Studio (AI Video Editor) — Portable Setup & Installation Guide

This package contains the complete source code, configuration, database migrations, CLI rendering engine, and automated test suites for **Timeline Studio** — a full-stack, local-first AI video editing platform.

---

## 1. System Prerequisites

Ensure the following tools are installed on the target machine:

1. **Node.js**: `v20.0.0` or higher (`v22+` recommended).
   - Check with: `node -v` and `npm -v`.
2. **PostgreSQL**:
   - **Recommended**: Docker & Docker Compose (`docker compose version`).
   - *Alternative*: Local PostgreSQL 16 service running on port `5432`.
3. **FFmpeg & FFprobe**:
   - Required for audio probing, waveform generation, and headless video rendering.
   - **Windows**: `winget install Gyan.FFmpeg` or `choco install ffmpeg`.
   - **macOS**: `brew install ffmpeg`.
   - **Linux (Ubuntu/Debian)**: `sudo apt update && sudo apt install -y ffmpeg`.
   - Verify with: `ffmpeg -version` and `ffprobe -version`.
4. **Modern Chromium Browser**:
   - Google Chrome, Microsoft Edge, or Brave with WebGPU support enabled (`chrome://gpu`).
5. **(Optional) Local Ollama**:
   - If running local AI Assistant inference without cloud APIs, install [Ollama](https://ollama.ai) and pull a model:
     ```bash
     ollama pull qwen2.5-coder:7b
     ```

---

## 2. Quick Start Installation

### Step 1: Install Dependencies
Open a terminal in the extracted project root directory:
```bash
npm install
```

### Step 2: Configure Environment Variables
Copy the provided `.env.example` file to create your local `.env`:
- **Windows (PowerShell)**:
  ```powershell
  Copy-Item .env.example .env
  ```
- **macOS / Linux**:
  ```bash
  cp .env.example .env
  ```
*(The default settings in `.env.example` are pre-configured to work out-of-the-box for local development with mock email authentication and local PostgreSQL).*

### Step 3: Start PostgreSQL & Apply Database Migrations
If using Docker:
```bash
# Start PostgreSQL container in background
docker compose up -d

# Execute database migrations
npm run db:migrate
```

### Step 4: Start the Backend Server
In your first terminal:
```bash
npm run server
```
- The backend will listen at `http://localhost:3001`.
- Verify backend health at [http://localhost:3001/health](http://localhost:3001/health). It should return `{"status":"ok","database":{"status":"healthy"}}`.

### Step 5: Start the Frontend Studio
In a second terminal:
```bash
npm run dev
```
- Open [http://localhost:5173](http://localhost:5173) in your Chromium browser to access the editing studio.

---

## 3. Authentication in Local Development

The platform features passwordless Email OTP authentication:
- When prompted for login or when syncing projects, enter any valid email address (e.g. `test@example.com`).
- By default (`EMAIL_PROVIDER=mock`), the 6-digit OTP code will be logged directly to the **backend terminal window**:
  ```text
  [MockEmailProvider] Sent email to test@example.com
  Subject: Your Timeline Studio Verification Code
  Code: 123456
  ```
- Type the 6-digit code into the browser prompt to complete sign-in.

---

## 4. Key Available Commands

| Command | Purpose |
|---|---|
| `npm run dev` | Starts Vite frontend dev server on port `5173` |
| `npm run server` | Starts Express backend server on port `3001` |
| `npm run build` | Builds the production bundle into `dist/` |
| `npm run typecheck` | Runs TypeScript compiler checks without emitting files (`tsc --noEmit`) |
| `npm run test:backend` | Runs the full backend Node.js test suite |
| `node scripts/e2e-smart-pipeline-test.mjs` | Runs Playwright E2E test for the Smart Editing Pipeline |
| `node scripts/verify-smart-pipeline-minimize.mjs` | Verifies Smart Pipeline minimize & background processing |
| `npm run agent -- <command>` | Headless CLI agent for inspecting, diffing, and rendering `.timeline` archives |

---

## 5. Production Build Verification

To verify that the production bundle compiles correctly on your laptop:
```bash
# On systems with standard heap limits, assign 4GB for ONNX WebGPU bundle parsing:
# PowerShell:
$env:NODE_OPTIONS="--max-old-space-size=4096"; npm run build

# Bash / macOS / Linux:
NODE_OPTIONS="--max-old-space-size=4096" npm run build
```

---

## 6. Project Architecture Overview

- **`src/`**: Vite React client application. Contains timeline canvas, multi-track audio/video lanes, WebCodecs export engine, WebWorkers for Silero VAD, Transformers.js Whisper ASR, MediaPipe Smart Frame, and ONNX WebGPU runtime.
- **`server/`**: Express backend. Manages PostgreSQL relational persistence, user accounts, OTP authentication, and headless FFmpeg rendering pipelines.
- **`scripts/`**: Automated Playwright integration tests, headless CLI engine (`timeline-command.mjs`), and regression validation scripts.
- **`public/`**: Static media assets, icons, fonts, and WebAssembly runtime files.
- **`storage/`**: Local storage for rendered MP4 exports and `.timeline` project archives.
