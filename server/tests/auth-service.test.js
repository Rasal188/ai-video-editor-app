import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTestPool, setPool, closePool } from "../db/index.js";
import { runMigrations } from "../db/migrate.js";
import {
  requestOtp,
  verifyOtp,
  validateSession,
  logoutSession,
  AuthError,
} from "../services/auth/authService.js";
import { MockEmailProvider } from "../services/email/mockEmailProvider.js";
import { hashSessionToken } from "../services/auth/crypto.js";

describe("Authentication Service & Lifecycle", () => {
  it("should complete full OTP request, verification, user creation, session and logout lifecycle", async () => {
    const testPool = await createTestPool();
    setPool(testPool);
    await runMigrations(testPool, { silent: true });

    const mockEmail = new MockEmailProvider();

    // 1. Request OTP for a new user
    const email = "  Alice.Creator@Example.Com  ";
    const requestResult = await requestOtp(
      { email },
      { executor: testPool, emailProvider: mockEmail }
    );

    assert.equal(requestResult.success, true);
    assert.equal(
      requestResult.message,
      "If the email can receive a verification code, one has been sent."
    );

    // Verify email captured by mock provider
    const sent = mockEmail.getLatestEmail("alice.creator@example.com");
    assert.ok(sent);
    assert.equal(typeof sent.otp, "string");
    assert.equal(sent.otp.length, 6);

    // Verify OTP challenge in database is hashed, not plaintext!
    const challenges = await testPool.query(
      "SELECT email, otp_hash, attempt_count, consumed_at FROM otp_challenges WHERE email = $1",
      ["alice.creator@example.com"]
    );
    assert.equal(challenges.rows.length, 1);
    assert.equal(challenges.rows[0].otp_hash.length, 64);
    assert.notEqual(challenges.rows[0].otp_hash, sent.otp, "Plaintext OTP must NOT be stored in DB");
    assert.equal(challenges.rows[0].consumed_at, null);

    // 2. Cooldown check - immediate resend must be rejected with 429
    await assert.rejects(
      () =>
        requestOtp(
          { email: "alice.creator@example.com" },
          { executor: testPool, emailProvider: mockEmail }
        ),
      (err) => err instanceof AuthError && err.code === "COOLDOWN_ACTIVE" && err.status === 429
    );

    // 3. Verify OTP with incorrect code - should increment attempts and reject
    await assert.rejects(
      () =>
        verifyOtp(
          { email: "alice.creator@example.com", otp: "000000" },
          { executor: testPool }
        ),
      (err) => err instanceof AuthError && err.code === "INVALID_OTP"
    );

    const attemptsCheck = await testPool.query(
      "SELECT attempt_count FROM otp_challenges WHERE email = $1",
      ["alice.creator@example.com"]
    );
    assert.equal(attemptsCheck.rows[0].attempt_count, 1);

    // 4. Verify OTP with correct code - should create user, session, and mark challenge consumed
    const verifyResult = await verifyOtp(
      { email: "alice.creator@example.com", otp: sent.otp },
      { executor: testPool }
    );

    assert.ok(verifyResult.rawToken);
    assert.equal(typeof verifyResult.rawToken, "string");
    assert.equal(verifyResult.rawToken.length, 64);
    assert.ok(verifyResult.user.id);
    assert.equal(verifyResult.user.email, "alice.creator@example.com");
    assert.equal(verifyResult.user.displayName, "alice.creator");

    // Challenge should now be marked consumed
    const consumedCheck = await testPool.query(
      "SELECT consumed_at FROM otp_challenges WHERE email = $1",
      ["alice.creator@example.com"]
    );
    assert.ok(consumedCheck.rows[0].consumed_at);

    // Session in DB should store hashed token, not raw token
    const sessionRows = await testPool.query(
      "SELECT token_hash, user_id FROM sessions WHERE user_id = $1",
      [verifyResult.user.id]
    );
    assert.equal(sessionRows.rows.length, 1);
    assert.equal(
      sessionRows.rows[0].token_hash,
      hashSessionToken(verifyResult.rawToken),
      "Session token in DB must be hashed"
    );

    // 5. Replay attempt with same OTP must fail immediately
    await assert.rejects(
      () =>
        verifyOtp(
          { email: "alice.creator@example.com", otp: sent.otp },
          { executor: testPool }
        ),
      (err) => err instanceof AuthError && err.code === "INVALID_OTP"
    );

    // 6. Validate session
    const sessionData = await validateSession(verifyResult.rawToken, testPool);
    assert.ok(sessionData);
    assert.equal(sessionData.user.id, verifyResult.user.id);
    assert.equal(sessionData.user.email, "alice.creator@example.com");

    // Invalid raw token returns null
    const invalidSession = await validateSession("non-existent-token", testPool);
    assert.equal(invalidSession, null);

    // 7. Logout session
    const logoutRes = await logoutSession(verifyResult.rawToken, testPool);
    assert.equal(logoutRes, true);

    // Session is now invalidated in DB
    const postLogoutSession = await validateSession(verifyResult.rawToken, testPool);
    assert.equal(postLogoutSession, null);

    await closePool();
  });

  it("should enforce maximum verification attempts lockout", async () => {
    const testPool = await createTestPool();
    setPool(testPool);
    await runMigrations(testPool, { silent: true });

    const mockEmail = new MockEmailProvider();
    await requestOtp(
      { email: "locked@example.com" },
      { executor: testPool, emailProvider: mockEmail }
    );

    // 5 incorrect attempts
    for (let i = 0; i < 5; i++) {
      await assert.rejects(
        () => verifyOtp({ email: "locked@example.com", otp: "000000" }, { executor: testPool }),
        (err) => err instanceof AuthError
      );
    }

    // 6th attempt should be blocked with MAX_ATTEMPTS_EXCEEDED
    await assert.rejects(
      () => verifyOtp({ email: "locked@example.com", otp: "000000" }, { executor: testPool }),
      (err) => err instanceof AuthError && err.code === "MAX_ATTEMPTS_EXCEEDED"
    );

    await closePool();
  });

  it("should reject expired OTP challenge", async () => {
    const testPool = await createTestPool();
    setPool(testPool);
    await runMigrations(testPool, { silent: true });

    const mockEmail = new MockEmailProvider();
    await requestOtp(
      { email: "expired@example.com" },
      { executor: testPool, emailProvider: mockEmail }
    );
    const sent = mockEmail.getLatestEmail("expired@example.com");

    // Manually backdate expiration in DB to simulate expired OTP
    await testPool.query(
      "UPDATE otp_challenges SET expires_at = NOW() - INTERVAL '1 minute' WHERE email = $1",
      ["expired@example.com"]
    );

    await assert.rejects(
      () => verifyOtp({ email: "expired@example.com", otp: sent.otp }, { executor: testPool }),
      (err) => err instanceof AuthError && err.code === "EXPIRED_OTP"
    );

    await closePool();
  });
});
