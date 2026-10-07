import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPool, closePool } from "./index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "migrations");

export async function runMigrations(customPool = null, options = {}) {
  const pool = customPool || getPool();
  const migrationsDir = options.migrationsDir || MIGRATIONS_DIR;

  // 1. Ensure migrations tracking table exists
  const checkTable = await pool.query(
    "SELECT 1 FROM information_schema.tables WHERE table_name = '_migrations'"
  );
  if (!checkTable.rows.length) {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
  }

  // 2. Fetch already applied migrations
  const existingResult = await pool.query("SELECT name FROM _migrations ORDER BY id ASC");
  const appliedSet = new Set(existingResult.rows.map((r) => r.name));

  // 3. Read migration files
  const fileEntries = await readdir(migrationsDir, { withFileTypes: true });
  const sqlFiles = fileEntries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort();

  const applied = [];
  const alreadyApplied = [];

  for (const fileName of sqlFiles) {
    if (appliedSet.has(fileName)) {
      alreadyApplied.push(fileName);
      continue;
    }

    const filePath = join(migrationsDir, fileName);
    const sqlContent = await readFile(filePath, "utf8");

    // Execute migration inside a transaction
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sqlContent);
      await client.query("INSERT INTO _migrations (name) VALUES ($1)", [fileName]);
      await client.query("COMMIT");
      applied.push(fileName);
      if (!options.silent) {
        console.log(`[Migration Applied]: ${fileName}`);
      }
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw new Error(`Failed to apply migration "${fileName}": ${error.message}`, { cause: error });
    } finally {
      client.release();
    }
  }

  return {
    applied,
    alreadyApplied,
    total: sqlFiles.length,
  };
}

// Allow direct execution via CLI
const isDirectExecution = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectExecution) {
  runMigrations()
    .then((result) => {
      console.log(`\nMigration completed successfully.`);
      console.log(`Applied: ${result.applied.length}, Already up-to-date: ${result.alreadyApplied.length}, Total: ${result.total}`);
      return closePool();
    })
    .catch((error) => {
      console.error("\nMigration failed:", error.message);
      process.exitCode = 1;
      return closePool();
    });
}
