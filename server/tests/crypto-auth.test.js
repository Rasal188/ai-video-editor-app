import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  generateOtp,
  hashOtp,
  verifyOtpHash,
  generateSessionToken,
  hashSessionToken,
  isValidEmail,
  normalizeEmail,
} from "../services/auth/crypto.js";

describe("Authentication Cryptographic Utilities", () => {
  it("generateOtp should generate numeric string of exact length", () => {
    for (let i = 0; i < 20; i++) {
      const otp6 = generateOtp(6);
      assert.equal(typeof otp6, "string");
      assert.equal(otp6.length, 6);
      assert.match(otp6, /^\d{6}$/);

      const otp4 = generateOtp(4);
      assert.equal(otp4.length, 4);
      assert.match(otp4, /^\d{4}$/);
    }
  });

  it("generateOtp should reject invalid length parameters", () => {
    assert.throws(() => generateOtp(0), /Invalid OTP length/);
    assert.throws(() => generateOtp(15), /Invalid OTP length/);
  });

  it("hashOtp should be deterministic and salt-dependent", () => {
    const email = "user@example.com";
    const otp = "123456";
    const saltA = "salt-alpha";
    const saltB = "salt-beta";

    const hash1 = hashOtp(email, otp, saltA);
    const hash2 = hashOtp(email, otp, saltA);
    const hashDiffSalt = hashOtp(email, otp, saltB);
    const hashDiffEmail = hashOtp("other@example.com", otp, saltA);

    assert.equal(typeof hash1, "string");
    assert.equal(hash1.length, 64); // SHA-256 hex length
    assert.equal(hash1, hash2, "Identical inputs should produce identical hash");
    assert.notEqual(hash1, hashDiffSalt, "Different salt should produce different hash");
    assert.notEqual(hash1, hashDiffEmail, "Different email should produce different hash");
  });

  it("verifyOtpHash should perform constant-time verification", () => {
    const email = "Test.User@Example.COM";
    const otp = "839201";
    const salt = "secure-salt";
    const expectedHash = hashOtp(email, otp, salt);

    assert.ok(verifyOtpHash(email, "839201", expectedHash, salt));
    assert.ok(verifyOtpHash("test.user@example.com", "839201", expectedHash, salt), "Case-insensitive normalization");
    assert.equal(verifyOtpHash(email, "000000", expectedHash, salt), false);
    assert.equal(verifyOtpHash(email, "83920", expectedHash, salt), false);
    assert.equal(verifyOtpHash("other@test.com", "839201", expectedHash, salt), false);
    assert.equal(verifyOtpHash(null, "839201", expectedHash, salt), false);
  });

  it("generateSessionToken and hashSessionToken should produce secure high-entropy tokens", () => {
    const token1 = generateSessionToken();
    const token2 = generateSessionToken();

    assert.equal(typeof token1, "string");
    assert.equal(token1.length, 64); // 32 bytes hex = 64 chars
    assert.notEqual(token1, token2);

    const hash1 = hashSessionToken(token1);
    const hash2 = hashSessionToken(token2);
    assert.equal(hash1.length, 64);
    assert.notEqual(hash1, hash2);
  });

  it("email validation and normalization helpers", () => {
    assert.ok(isValidEmail("alice@example.com"));
    assert.ok(isValidEmail("alice.bob+tag@company.co.uk"));
    assert.equal(isValidEmail("invalid-email"), false);
    assert.equal(isValidEmail("@missing-user.com"), false);
    assert.equal(isValidEmail("missing-at.com"), false);
    assert.equal(isValidEmail(""), false);
    assert.equal(isValidEmail(null), false);

    assert.equal(normalizeEmail("  Alice@Example.COM  "), "alice@example.com");
  });
});
