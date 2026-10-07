import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../app.js";
import { createTestPool, setPool, closePool } from "../db/index.js";

async function withServer(app, testFn) {
  const server = app.listen(0);
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    await testFn(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe("Backend HTTP API & Health Check Endpoint", () => {
  it("GET /health should return 200 and healthy JSON when DB is connected", async () => {
    const pool = await createTestPool();
    setPool(pool);

    const app = createApp();

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/health`);
      assert.equal(response.status, 200);

      const body = await response.json();
      assert.equal(body.status, "ok");
      assert.equal(body.service, "ai-video-editor-backend");
      assert.equal(body.database.ok, true);
      assert.equal(body.database.healthy, true);
      assert.equal(typeof body.database.latencyMs, "number");
    });

    await closePool();
  });

  it("GET /health should return 503 and degraded JSON when DB fails", async () => {
    const { createPool } = await import("../db/index.js");
    const badPool = createPool({
      url: "postgres://postgres:postgres@localhost:59998/offline",
      connectionTimeoutMillis: 500,
    });
    setPool(badPool);

    const app = createApp();

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/health`);
      assert.equal(response.status, 503);

      const body = await response.json();
      assert.equal(body.status, "degraded");
      assert.equal(body.database.ok, false);
      assert.ok(body.database.error);
    });

    await closePool();
  });

  it("GET /unknown-route should return 404", async () => {
    const app = createApp();

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/non-existent`);
      assert.equal(response.status, 404);

      const body = await response.json();
      assert.equal(body.code, "NOT_FOUND");
    });
  });

  it("GET /api/projects, /api/assets, /api/renders should require authentication (401 UNAUTHORIZED)", async () => {
    const app = createApp();

    await withServer(app, async (baseUrl) => {
      for (const endpoint of ["/api/projects", "/api/assets", "/api/renders"]) {
        const response = await fetch(`${baseUrl}${endpoint}`);
        assert.equal(response.status, 401, `Endpoint ${endpoint} should return 401`);

        const body = await response.json();
        assert.equal(body.code, "UNAUTHORIZED");
      }
    });
  });
});
