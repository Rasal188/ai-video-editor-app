import { resolve } from "node:path";
import dotenv from "dotenv";

// Load .env if present
dotenv.config();

export const config = Object.freeze({
  env: process.env.NODE_ENV || "development",
  isProduction: process.env.NODE_ENV === "production",
  isTest: process.env.NODE_ENV === "test",

  server: Object.freeze({
    port: Number.parseInt(process.env.PORT || "3001", 10),
    host: process.env.HOST || "0.0.0.0",
    corsOrigin: process.env.CORS_ORIGIN || "*",
  }),

  db: Object.freeze({
    url: process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/ai_video_editor",
    maxConnections: Number.parseInt(process.env.DATABASE_MAX_CONNECTIONS || "10", 10),
    idleTimeoutMillis: Number.parseInt(process.env.DATABASE_IDLE_TIMEOUT_MS || "30000", 10),
    connectionTimeoutMillis: Number.parseInt(process.env.DATABASE_CONNECTION_TIMEOUT_MS || "5000", 10),
    ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : false,
  }),

  storage: Object.freeze({
    localDirectory: resolve(process.cwd(), process.env.STORAGE_DIRECTORY || "storage"),
    maxUploadSizeBytes: Number.parseInt(process.env.MAX_UPLOAD_SIZE_BYTES || String(500 * 1024 * 1024), 10), // 500MB default
  }),

  auth: Object.freeze({
    otpLength: 6,
    otpExpiresInMinutes: Number.parseInt(process.env.AUTH_OTP_EXPIRES_MINUTES || "10", 10),
    otpMaxAttempts: Number.parseInt(process.env.AUTH_OTP_MAX_ATTEMPTS || "5", 10),
    otpResendCooldownSeconds: Number.parseInt(process.env.AUTH_OTP_COOLDOWN_SECONDS || "60", 10),
    sessionDurationDays: Number.parseInt(process.env.AUTH_SESSION_DURATION_DAYS || "7", 10),
    sessionCookieName: process.env.AUTH_COOKIE_NAME || "timeline_session",
    salt: process.env.AUTH_SALT || "timeline-editor-dev-salt",
  }),

  email: Object.freeze({
    provider: process.env.EMAIL_PROVIDER || (process.env.OLLASTACK_API_KEY ? "ollastack" : "mock"),
    ollastack: Object.freeze({
      baseUrl: process.env.OLLASTACK_BASE_URL || "https://login.ollastack.com",
      apiKey: process.env.OLLASTACK_API_KEY || "",
      mailboxId: process.env.OLLASTACK_MAILBOX_ID || "",
    }),
  }),

  ollima: Object.freeze({
    apiKey: process.env.OLLIMA_API_KEY || "",
    model: process.env.OLLIMA_MODEL || "gemini-3-flash",
    baseUrl: process.env.OLLIMA_BASE_URL || "https://api.ollima.com/v1",
    timeoutMs: Number.parseInt(process.env.OLLIMA_TIMEOUT_MS || "60000", 10),
  }),

  // Fallback alias for backward compatibility
  openrouter: Object.freeze({
    apiKey: process.env.OLLIMA_API_KEY || process.env.OPENROUTER_API_KEY || "",
    model: process.env.OLLIMA_MODEL || process.env.OPENROUTER_MODEL || "gemini-3-flash",
    baseUrl: process.env.OLLIMA_BASE_URL || process.env.OPENROUTER_BASE_URL || "https://api.ollima.com/v1",
    timeoutMs: Number.parseInt(process.env.OLLIMA_TIMEOUT_MS || process.env.OPENROUTER_TIMEOUT_MS || "30000", 10),
  }),
});
