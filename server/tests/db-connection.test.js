import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTestPool, checkHealth, setPool, closePool } from "../db/index.js";

describe("Database Connection & Health Checks", () => {
  it("should report healthy status and latency with an active pool", async () => {
    const testPool = await createTestPool();
    setPool(testPool);

    const health = await checkHealth();
    assert.equal(health.ok, true);
    assert.equal(health.healthy, true);
    assert.equal(typeof health.latencyMs, "number");
    assert.ok(health.latencyMs >= 0);
    assert.ok(health.version.includes("PostgreSQL"));

    await closePool();
  });

  it("should report degraded status and error message when connection fails", async () => {
    // Create a pool pointing to a guaranteed non-existent port with small timeout
    const { createPool } = await import("../db/index.js");
    const badPool = createPool({
      url: "postgres://postgres:postgres@localhost:59999/non_existent_db",
      connectionTimeoutMillis: 500,
    });
    setPool(badPool);

    const health = await checkHealth();
    assert.equal(health.ok, false);
    assert.equal(health.healthy, false);
    assert.ok(health.error);

    await closePool();
  });
});
