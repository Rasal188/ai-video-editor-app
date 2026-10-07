import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../app.js";
import { createTestPool, setPool, closePool } from "../db/index.js";
import { runMigrations } from "../db/migrate.js";
import { setEmailProvider, resetEmailProvider, getEmailProvider } from "../services/email/emailProvider.js";
import { MockEmailProvider } from "../services/email/mockEmailProvider.js";

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

describe("Authentication HTTP Endpoints & Cookie Session Flow", () => {
  let mockEmail;

  beforeEach(() => {
    mockEmail = new MockEmailProvider();
    setEmailProvider(mockEmail);
  });

  afterEach(() => {
    resetEmailProvider();
  });

  it("should execute end-to-end authentication flow via HTTP", async () => {
    const testPool = await createTestPool();
    setPool(testPool);
    await runMigrations(testPool, { silent: true });

    const app = createApp();

    await withServer(app, async (baseUrl) => {
      // 1. Initial GET /api/auth/me without session should return 401
      const initialMeRes = await fetch(`${baseUrl}/api/auth/me`);
      assert.equal(initialMeRes.status, 401);
      const initialMeBody = await initialMeRes.json();
      assert.equal(initialMeBody.code, "UNAUTHORIZED");

      // 2. Request OTP
      const requestRes = await fetch(`${baseUrl}/api/auth/request-otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "editor.user@example.com" }),
      });

      assert.equal(requestRes.status, 200);
      const requestBody = await requestRes.json();
      assert.equal(requestBody.success, true);
      assert.ok(requestBody.message.includes("verification code"));
      assert.equal(requestBody.otp, undefined, "Response must NEVER return OTP");

      // 3. Inspect Mock Provider to retrieve generated OTP
      const emailProvider = getEmailProvider();
      const captured = emailProvider.getLatestEmail("editor.user@example.com");
      assert.ok(captured);
      const generatedOtp = captured.otp;
      assert.match(generatedOtp, /^\d{6}$/);

      // 4. Verify with wrong OTP -> 400
      const wrongVerifyRes = await fetch(`${baseUrl}/api/auth/verify-otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "editor.user@example.com", otp: "000000" }),
      });
      assert.equal(wrongVerifyRes.status, 400);

      // 5. Verify with correct OTP -> 200 and Set-Cookie
      const verifyRes = await fetch(`${baseUrl}/api/auth/verify-otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "editor.user@example.com", otp: generatedOtp }),
      });

      assert.equal(verifyRes.status, 200);
      const verifyBody = await verifyRes.json();
      assert.equal(verifyBody.success, true);
      assert.ok(verifyBody.user.id);
      assert.equal(verifyBody.user.email, "editor.user@example.com");
      assert.equal(verifyBody.rawToken, undefined, "Raw token must not be in JSON body");

      // Extract Set-Cookie header
      const cookieHeader = verifyRes.headers.get("set-cookie");
      assert.ok(cookieHeader, "Session cookie header must be set");
      assert.ok(cookieHeader.includes("timeline_session="));
      assert.ok(cookieHeader.toLowerCase().includes("httponly"));
      assert.ok(cookieHeader.toLowerCase().includes("samesite=lax"));

      // Extract the cookie value
      const sessionCookie = cookieHeader.split(";")[0];

      // 6. GET /api/auth/me with session cookie -> 200
      const meRes = await fetch(`${baseUrl}/api/auth/me`, {
        headers: { Cookie: sessionCookie },
      });
      assert.equal(meRes.status, 200);
      const meBody = await meRes.json();
      assert.equal(meBody.success, true);
      assert.equal(meBody.user.email, "editor.user@example.com");
      assert.equal(meBody.user.password_hash, undefined);

      // 7. Logout -> 200 and Clears Cookie
      const logoutRes = await fetch(`${baseUrl}/api/auth/logout`, {
        method: "POST",
        headers: { Cookie: sessionCookie },
      });
      assert.equal(logoutRes.status, 200);
      const logoutCookieHeader = logoutRes.headers.get("set-cookie");
      assert.ok(logoutCookieHeader);
      // Cleared cookie has empty value or past expiration
      assert.ok(
        logoutCookieHeader.includes("timeline_session=;") ||
        logoutCookieHeader.includes("Expires=")
      );

      // 8. Subsequent GET /api/auth/me with old session cookie -> 401
      const postLogoutMeRes = await fetch(`${baseUrl}/api/auth/me`, {
        headers: { Cookie: sessionCookie },
      });
      assert.equal(postLogoutMeRes.status, 401);
    });

    await closePool();
  });

  it("should reject malformed requests with 400", async () => {
    const testPool = await createTestPool();
    setPool(testPool);
    await runMigrations(testPool, { silent: true });

    const app = createApp();

    await withServer(app, async (baseUrl) => {
      // Missing email
      const res1 = await fetch(`${baseUrl}/api/auth/request-otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      assert.equal(res1.status, 400);

      // Invalid email format
      const res2 = await fetch(`${baseUrl}/api/auth/request-otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "not-an-email" }),
      });
      assert.equal(res2.status, 400);

      // Missing OTP
      const res3 = await fetch(`${baseUrl}/api/auth/verify-otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "test@example.com" }),
      });
      assert.equal(res3.status, 400);
    });

    await closePool();
  });
});
