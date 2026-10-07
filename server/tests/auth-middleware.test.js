import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { requireAuth, optionalAuth } from "../middleware/auth.js";
import { createTestPool, setPool, closePool } from "../db/index.js";
import { runMigrations } from "../db/migrate.js";
import { verifyOtp, requestOtp } from "../services/auth/authService.js";
import { MockEmailProvider } from "../services/email/mockEmailProvider.js";
import { config } from "../config.js";

describe("Authentication Middleware", () => {
  it("requireAuth should reject missing or invalid cookie with 401", async () => {
    const testPool = await createTestPool();
    setPool(testPool);
    await runMigrations(testPool, { silent: true });

    let statusSet = null;
    let jsonSent = null;
    const res = {
      status(s) {
        statusSet = s;
        return this;
      },
      json(j) {
        jsonSent = j;
        return this;
      },
      clearCookie() {},
    };

    // 1. Missing cookie
    const reqMissing = { cookies: {} };
    let nextCalled = false;
    requireAuth(reqMissing, res, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, false);
    assert.equal(statusSet, 401);
    assert.equal(jsonSent.code, "UNAUTHORIZED");

    // Reset mocks for part 2
    statusSet = null;
    jsonSent = null;

    // 2. Invalid cookie
    const reqInvalid = { cookies: { [config.auth.sessionCookieName]: "invalid-raw-token" } };
    await new Promise((resolve) => {
      let resolved = false;
      const safeResolve = () => {
        if (!resolved) {
          resolved = true;
          resolve();
        }
      };
      const resWithHook = {
        status(s) {
          statusSet = s;
          return this;
        },
        json(j) {
          jsonSent = j;
          safeResolve();
          return this;
        },
        clearCookie() {},
      };
      requireAuth(reqInvalid, resWithHook, () => {
        safeResolve();
      });
      setTimeout(safeResolve, 150);
    });

    assert.equal(statusSet, 401);
    assert.equal(jsonSent.code, "INVALID_SESSION");

    await closePool();
  });

  it("requireAuth should populate req.user on valid session", async () => {
    const testPool = await createTestPool();
    setPool(testPool);
    await runMigrations(testPool, { silent: true });

    const mockEmail = new MockEmailProvider();
    await requestOtp(
      { email: "middleware.user@example.com" },
      { executor: testPool, emailProvider: mockEmail }
    );
    const sent = mockEmail.getLatestEmail("middleware.user@example.com");
    const { rawToken, user } = await verifyOtp(
      { email: "middleware.user@example.com", otp: sent.otp },
      { executor: testPool }
    );

    const req = { cookies: { [config.auth.sessionCookieName]: rawToken } };
    const res = {};
    let nextCalled = false;

    await new Promise((resolve) => {
      requireAuth(req, res, () => {
        nextCalled = true;
        resolve();
      });
    });

    assert.equal(nextCalled, true);
    assert.ok(req.user);
    assert.equal(req.user.id, user.id);
    assert.equal(req.user.email, user.email);

    await closePool();
  });

  it("optionalAuth should attach user if logged in, or null if guest", async () => {
    const reqGuest = { cookies: {} };
    let guestNext = false;
    optionalAuth(reqGuest, {}, () => {
      guestNext = true;
    });
    assert.equal(guestNext, true);
    assert.equal(reqGuest.user, null);
  });
});
