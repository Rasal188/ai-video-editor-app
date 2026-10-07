import pg from "pg";
import { config } from "../config.js";

const { Pool } = pg;

let activePool = null;

export function createPool(options = {}) {
  const connectionString = options.url || config.db.url;
  const pool = new Pool({
    connectionString,
    max: options.maxConnections || config.db.maxConnections,
    idleTimeoutMillis: options.idleTimeoutMillis || config.db.idleTimeoutMillis,
    connectionTimeoutMillis: options.connectionTimeoutMillis || config.db.connectionTimeoutMillis,
    ssl: options.ssl !== undefined ? options.ssl : config.db.ssl,
    ...options,
  });

  pool.on("error", (err) => {
    console.error("[PostgreSQL Pool Error]:", err.message);
  });

  return pool;
}

/**
 * Creates an in-memory PostgreSQL pool using pg-mem for unit testing and CI
 * environments where an external database is not running.
 */
export async function createTestPool() {
  const { newDb } = await import("pg-mem");
  const crypto = await import("node:crypto");
  const db = newDb();

  // Register gen_random_uuid() which is standard in Postgres 13+
  db.public.registerFunction({
    name: "gen_random_uuid",
    returns: db.public.getType("uuid"),
    impure: true,
    implementation: () => crypto.randomUUID(),
  });

  // Register version() for health checks
  db.public.registerFunction({
    name: "version",
    returns: db.public.getType("text"),
    implementation: () => "PostgreSQL 16.0 (pg-mem in-memory emulation)",
  });

  const adapter = db.adapters.createPg();
  const pool = new adapter.Pool();
  return pool;
}

export function getPool() {
  if (!activePool) {
    activePool = createPool();
  }
  return activePool;
}

export function setPool(pool) {
  activePool = pool;
}

export async function query(text, params = []) {
  const pool = getPool();
  const start = performance.now();
  try {
    const result = await pool.query(text, params);
    return result;
  } catch (error) {
    const duration = (performance.now() - start).toFixed(2);
    const code = error?.code || "DB_QUERY_ERROR";
    const enhancedError = new Error(`Database query failed [${code}] after ${duration}ms: ${error.message}`);
    enhancedError.code = code;
    enhancedError.originalError = error;
    enhancedError.query = text;
    throw enhancedError;
  }
}

export async function getClient() {
  const pool = getPool();
  return pool.connect();
}

export async function checkHealth() {
  const pool = getPool();
  const start = performance.now();
  try {
    const result = await pool.query("SELECT 1 AS healthy, NOW() AS server_time, version() AS version");
    const latencyMs = Number((performance.now() - start).toFixed(2));
    const row = result.rows[0] || {};
    return {
      ok: true,
      healthy: Boolean(row.healthy),
      latencyMs,
      serverTime: row.server_time,
      version: row.version,
    };
  } catch (error) {
    const latencyMs = Number((performance.now() - start).toFixed(2));
    return {
      ok: false,
      healthy: false,
      latencyMs,
      error: error.message || error.code || "Connection failed",
      code: error?.code || "CONNECTION_FAILED",
    };
  }
}

export async function closePool() {
  if (activePool) {
    await activePool.end();
    activePool = null;
  }
}
