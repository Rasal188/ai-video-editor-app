# Backend & PostgreSQL Architecture (Phase 1)

This document describes the server layer, database integration, and operational workflows added in Phase 1 of the AI Video Editor project.

---

## 1. Architectural Overview & Boundaries

The AI Video Editor backend is built as a modular, lightweight service that complements the existing local-first browser editor and CLI command engine without altering their behavior.

### Core Principles
1. **Loose Coupling**: The browser editor and CLI (`timeline-command.mjs`, `projectCommandEngine.js`) remain self-contained and fully functional without requiring a running backend.
2. **Canonical Project Preservation**: The physical `.timeline` archive (containing `project.json` and bundled media assets) remains the authoritative, portable project representation. PostgreSQL stores relational metadata, revision histories, storage pointers, and job states.
3. **Storage Abstraction**: Large media binaries (source videos, exported MP4s) are never stored in database columns. Storage paths are tracked as URIs/keys, enabling transparent transition from local filesystem storage to S3/Cloud Storage in future phases.

```
                      ┌───────────────────────────────────────┐
                      │    Client (Browser Editor / CLI)      │
                      └──────────────────┬────────────────────┘
                                         │ HTTP REST / JSON
                                         ▼
                      ┌───────────────────────────────────────┐
                      │        Express Backend Server         │
                      │  - /health (with live DB probe)       │
                      │  - /api/* (routes for Phase 2)        │
                      └──────────┬─────────────────┬──────────┘
                                 │                 │
         Relational Metadata     │                 │ Local / Object Storage
         (Parameterized SQL)     ▼                 ▼
             ┌─────────────────────────┐     ┌───────────────────────┐
             │       PostgreSQL        │     │  .timeline Archives   │
             │  - users                │     │  & Rendered Media     │
             │  - projects             │     │  (storage/ directory) │
             │  - project_versions     │     └───────────────────────┘
             │  - assets               │
             │  - render_jobs          │
             └─────────────────────────┘
```

---

## 2. PostgreSQL Schema & Data Model

The schema is defined in [server/db/migrations/0001_initial_schema.sql](../server/db/migrations/0001_initial_schema.sql).

### Table Specifications

#### `users`
Foundation for future authentication and multi-tenant project ownership.
- `id` (`UUID PK DEFAULT gen_random_uuid()`): Unique identifier.
- `email` (`VARCHAR(255) UNIQUE NOT NULL`): Account email address.
- `name` (`VARCHAR(255) NOT NULL`): Display name.
- `password_hash` (`VARCHAR(255) NULL`): Password digest (nullable for OAuth / future auth).
- `created_at`, `updated_at` (`TIMESTAMPTZ NOT NULL DEFAULT NOW()`).
- Index: `idx_users_email`.

#### `projects`
Stores high-level metadata for each video editing project.
- `id` (`UUID PK DEFAULT gen_random_uuid()`): Unique project ID.
- `owner_id` (`UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT`): Project owner. Deleting a user with projects is restricted to prevent accidental loss.
- `title` (`VARCHAR(255) NOT NULL DEFAULT 'Untitled Project'`): Project name.
- `current_revision` (`INTEGER NOT NULL DEFAULT 0`): Matches `.timeline` command state revision.
- `duration` (`DOUBLE PRECISION NOT NULL DEFAULT 0`): Timeline total duration in seconds.
- `fps` (`INTEGER NOT NULL DEFAULT 30`): Project frame rate.
- `ratio` (`VARCHAR(16) NOT NULL DEFAULT '16:9'`): Aspect ratio (`16:9`, `9:16`, `1:1`, etc.).
- `archive_storage_path` (`TEXT NULL`): Relative path or storage key pointing to the active `.timeline` archive.
- `metadata` (`JSONB NOT NULL DEFAULT '{}'`): Extensible snapshot data (marker counts, track summaries).
- `created_at`, `updated_at` (`TIMESTAMPTZ NOT NULL DEFAULT NOW()`).
- Indexes: `idx_projects_owner_id`, `idx_projects_updated_at`.

#### `project_versions`
Audit log and snapshot repository of revisions for rollback and recovery.
- `id` (`UUID PK DEFAULT gen_random_uuid()`): Unique version ID.
- `project_id` (`UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE`): Target project.
- `revision` (`INTEGER NOT NULL`): Revision number.
- `archive_storage_path` (`TEXT NOT NULL`): Path to the archived `.timeline` file for this revision.
- `duration` (`DOUBLE PRECISION NOT NULL DEFAULT 0`): Duration at this revision.
- `change_summary` (`TEXT NULL`): Summary of applied operations (e.g. "Trimmed clip by 2s").
- `metadata` (`JSONB NOT NULL DEFAULT '{}'`): Applied operation IDs, timestamps, and parameters.
- `created_at` (`TIMESTAMPTZ NOT NULL DEFAULT NOW()`).
- Constraints & Indexes:
  - `uq_project_versions_project_revision UNIQUE (project_id, revision)`.
  - `idx_project_versions_project_rev (project_id, revision DESC)`.

#### `assets`
Registry of uploaded and imported media assets.
- `id` (`UUID PK DEFAULT gen_random_uuid()`): Unique asset ID.
- `project_id` (`UUID NULL REFERENCES projects(id) ON DELETE CASCADE`): Optional association with a project.
- `owner_id` (`UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE`): Asset owner.
- `filename` (`VARCHAR(255) NOT NULL`): Original file name.
- `media_type` (`VARCHAR(32) NOT NULL`): Visual, audio, etc. (`video`, `image`, `audio`).
- `mime_type` (`VARCHAR(128) NOT NULL`): MIME type (`video/mp4`, `audio/wav`).
- `storage_path` (`TEXT NOT NULL`): File location in storage.
- `size_bytes` (`BIGINT NOT NULL`): Binary file size.
- `sha256` (`VARCHAR(64) NULL`): Cryptographic hash for deduplication and integrity.
- `metadata` (`JSONB NOT NULL DEFAULT '{}'`): Video dimensions, probed audio channels, duration.
- `created_at`, `updated_at` (`TIMESTAMPTZ NOT NULL DEFAULT NOW()`).
- Indexes: `idx_assets_project_id`, `idx_assets_owner_id`, `idx_assets_sha256`.

#### `render_jobs`
Orchestration queue for background headless FFmpeg rendering tasks.
- `id` (`UUID PK DEFAULT gen_random_uuid()`): Unique render task ID.
- `project_id` (`UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE`): Project being rendered.
- `requested_revision` (`INTEGER NOT NULL`): Target revision snapshot.
- `status` (`VARCHAR(32) NOT NULL DEFAULT 'pending'`): State machine constrained to `pending`, `processing`, `completed`, `failed`, or `cancelled`.
- `output_video_path` (`TEXT NULL`): Storage location of rendered MP4 file.
- `error_message` (`TEXT NULL`): Diagnostics if rendering fails.
- `settings` (`JSONB NOT NULL DEFAULT '{}'`): Dimensions, CRF, preset, frame rate.
- `verification` (`JSONB NOT NULL DEFAULT '{}'`): FFprobe post-render validation results.
- `started_at`, `completed_at` (`TIMESTAMPTZ NULL`): Timing records.
- `created_at`, `updated_at` (`TIMESTAMPTZ NOT NULL DEFAULT NOW()`).
- Indexes: `idx_render_jobs_project_id`, `idx_render_jobs_status`.

---

## 3. Environment Configuration

Configuration is loaded from environment variables or a `.env` file via [server/config.js](../server/config.js).

| Variable | Default Value | Description |
|---|---|---|
| `PORT` | `3001` | HTTP server port |
| `HOST` | `0.0.0.0` | Bind host address |
| `NODE_ENV` | `development` | Runtime environment (`development`, `production`, `test`) |
| `CORS_ORIGIN` | `http://localhost:5173` | Allowed frontend origin for CORS |
| `DATABASE_URL` | `postgres://postgres:postgres@localhost:5432/ai_video_editor` | PostgreSQL connection URI |
| `DATABASE_MAX_CONNECTIONS` | `10` | Max pool client connections |
| `DATABASE_IDLE_TIMEOUT_MS` | `30000` | Client idle timeout before release |
| `DATABASE_CONNECTION_TIMEOUT_MS` | `5000` | Connection acquisition timeout |
| `DATABASE_SSL` | `false` | Enable TLS/SSL connection for cloud databases |
| `STORAGE_DIRECTORY` | `storage` | Local directory for uploaded assets and project files |
| `MAX_UPLOAD_SIZE_BYTES` | `524288000` | Maximum asset upload size (500 MB) |

A template is provided in [.env.example](../.env.example).

---

## 4. Local Development & PostgreSQL Setup

### Option A: Running PostgreSQL with Docker Compose (Recommended)
A preconfigured [docker-compose.yml](../docker-compose.yml) is included:

```bash
# Start PostgreSQL in the background
docker compose up -d

# Verify database health
docker compose ps
```

### Option B: Local Native PostgreSQL
If you already run PostgreSQL locally, create the database:
```sql
CREATE DATABASE ai_video_editor;
```
Configure credentials in your `.env` file matching `DATABASE_URL`.

---

## 5. Migration Commands

Migrations are tracked in the `_migrations` table and executed within database transactions.

```bash
# Run pending migrations
npm run db:migrate
```

Each migration in `server/db/migrations/` is executed exactly once in alphanumeric order and is completely idempotent.

---

## 6. Starting the Backend Server

```bash
# Production / standard start
npm run server

# Development mode with automatic watch & restart
npm run server:dev
```

When started, the server connects to PostgreSQL, logs connection latency, and binds to `http://localhost:3001`.

---

## 7. Running Backend Tests

The test suite runs using Node's native test runner (`node:test`) and supports both live PostgreSQL instances and isolated in-memory testing (via `pg-mem`):

```bash
# Run all backend unit & integration tests
npm run test:backend
```

Tests cover:
- **`server/tests/db-connection.test.js`**: Connection pool creation, health status, latency metrics, and error degradation.
- **`server/tests/migrations.test.js`**: Transactional migration application, table creation, and idempotency.
- **`server/tests/schema-crud.test.js`**: Parameterized queries, foreign key cascading, unique constraints, and status validation across all 7 tables.
- **`server/tests/health.test.js`**: HTTP `GET /health` probe (200 OK / 503 degraded), 404 handler, and 501 scaffolded API routes.
- **`server/tests/crypto-auth.test.js`**: Cryptographic OTP generation, SHA-256 salted hashing, constant-time verification, session tokens.
- **`server/tests/email-providers.test.js`**: Mock email provider capture and OllaStack OpenAPI-compliant request formatting, error handling, and timeout behavior.
- **`server/tests/auth-service.test.js`**: OTP request lifecycle, cooldown enforcement, attempt lockouts, expiration, user creation, and session management.
- **`server/tests/auth-middleware.test.js`**: `requireAuth` and `optionalAuth` cookie validation.
- **`server/tests/auth-endpoints.test.js`**: End-to-end HTTP API tests for `/api/auth/request-otp`, `/api/auth/verify-otp`, `/api/auth/me`, and `/api/auth/logout`.

---

## 8. Phase 2: Passwordless OTP Authentication & OllaStack Integration

### 8.1 Authentication Architecture & Authority

Our backend remains authoritative for all authentication decisions:
1. **Express Backend**:
   - Generates cryptographically secure 6-digit numeric OTPs (`crypto.randomInt`).
   - Salts and hashes OTPs with SHA-256 before persisting to PostgreSQL.
   - Enforces challenge expiration (10 min) and maximum attempts (5).
   - Enforces resend cooldowns (60s) and IP rate limiting.
   - Authoritatively provisions users and signs session tokens.
   - Issues secure HTTP-only cookies (`timeline_session`).
2. **OllaStack**:
   - Acts strictly as the transactional email delivery layer.
   - Does NOT generate or verify application OTPs.
   - Endpoints are called via the official OllaStack OpenAPI 3.1 specification.

### 8.2 Confirmed OllaStack API Behavior

From the official OllaStack OpenAPI 3.1 specification (`https://login.ollastack.com/api/openapi.json`):
- **Base URL**: `https://login.ollastack.com`
- **Authentication**: `Authorization: Bearer <OLLASTACK_API_KEY>`
- **Token Scope Required**: `mail.agent:send` (for agent mailboxes) or `mail.test:send` (for test mailboxes)
- **Confirmed Endpoint**:
  ```http
  POST /api/mailboxes/{mailboxId}/send
  Authorization: Bearer <API_KEY>
  Content-Type: application/json

  {
    "to": "recipient@example.com",
    "subject": "Your Timeline Studio Verification Code",
    "text": "Your verification code is: 123456\nThis code expires in 10 minutes.",
    "html": "..."
  }
  ```
- **Responses**:
  - `200 OK`: `{ "success": true, "data": { "id": "msg_...", ... } }`
  - `400 Bad Request`: Validation failure, monthly send quota reached, or outbound not configured.
  - `401 Unauthorized`: Token missing or lacks `mail.agent:send` / `mail.test:send` scope.
  - `404 Not Found`: Mailbox ID does not exist.

### 8.3 Email Provider Abstraction

- **`MockEmailProvider`** (`server/services/email/mockEmailProvider.js`):
  - Captures sent emails in-memory (`sentEmails` array).
  - Used by default in automated tests and local development when no OllaStack credentials are present.
  - Enables zero-network-dependency CI testing.
- **`OllastackEmailProvider`** (`server/services/email/ollastackEmailProvider.js`):
  - Fully implements the official OllaStack OpenAPI contract.
  - Never leaks API keys in logs or client error responses.
  - Handles network timeouts and provider errors gracefully.

### 8.4 API Endpoints

| Method | Endpoint | Protection | Description |
|---|---|---|---|
| `POST` | `/api/auth/request-otp` | Rate-limited (15/5m) | Generates OTP, hashes, stores challenge, and sends email. Returns generic success message. |
| `POST` | `/api/auth/verify-otp` | Rate-limited (30/5m) | Validates OTP hash, provisions user if new, sets HTTP-only `timeline_session` cookie. |
| `GET` | `/api/auth/me` | `requireAuth` | Returns authenticated user info `{ id, email, displayName }`. |
| `POST` | `/api/auth/logout` | Optional | Invalidates session in database and clears session cookie. |

### 8.5 Security Protections

- **Zero Plaintext Secrets**: Plaintext OTPs and raw session tokens are never stored in the database.
- **Timing Safe Equal**: Hashes are compared in constant time (`crypto.timingSafeEqual`) to prevent timing attacks.
- **Secure HTTP-Only Cookies**: `httpOnly: true`, `sameSite: "lax"`, `secure` in production. No tokens stored in `localStorage` or `sessionStorage`.
- **Generic Responses**: `/api/auth/request-otp` returns identical responses regardless of whether the user exists, preventing account enumeration.
- **Single-Use Consumption**: OTPs are permanently marked consumed upon successful verification.

