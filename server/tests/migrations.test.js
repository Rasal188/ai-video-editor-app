import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTestPool, setPool, closePool } from "../db/index.js";
import { runMigrations } from "../db/migrate.js";

describe("Database Migrations", () => {
  it("should apply initial migration and create all required tables", async () => {
    const testPool = await createTestPool();
    setPool(testPool);

    const result = await runMigrations(testPool, { silent: true });

    assert.equal(result.applied.length, 2);
    assert.deepEqual(result.applied, ["0001_initial_schema.sql", "0002_otp_and_sessions.sql"]);
    assert.equal(result.alreadyApplied.length, 0);

    // Verify _migrations tracking table
    const migrationRows = await testPool.query("SELECT name FROM _migrations ORDER BY name ASC");
    assert.equal(migrationRows.rows.length, 2);
    assert.equal(migrationRows.rows[0].name, "0001_initial_schema.sql");
    assert.equal(migrationRows.rows[1].name, "0002_otp_and_sessions.sql");

    // Verify all 7 core tables exist
    const tablesCheck = await testPool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"
    );
    const existingTableNames = new Set(tablesCheck.rows.map((r) => r.table_name));
    const expectedTables = [
      "users",
      "projects",
      "project_versions",
      "assets",
      "render_jobs",
      "otp_challenges",
      "sessions",
    ];
    for (const table of expectedTables) {
      assert.ok(existingTableNames.has(table), `Table "${table}" should exist`);
    }

    await closePool();
  });

  it("should be idempotent when run a second time", async () => {
    const testPool = await createTestPool();
    setPool(testPool);

    // First run
    await runMigrations(testPool, { silent: true });

    // Second run
    const secondResult = await runMigrations(testPool, { silent: true });
    assert.equal(secondResult.applied.length, 0);
    assert.equal(secondResult.alreadyApplied.length, 2);
    assert.deepEqual(secondResult.alreadyApplied, [
      "0001_initial_schema.sql",
      "0002_otp_and_sessions.sql",
    ]);

    await closePool();
  });
});
