import crypto from "node:crypto";

/**
 * Validates basic email structure.
 */
export function isValidEmail(email) {
  if (typeof email !== "string") return false;
  const trimmed = email.trim();
  if (trimmed.length < 3 || trimmed.length > 254) return false;
  // RFC 5322 compliant simplified regex
  const emailRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
  return emailRegex.test(trimmed);
}

/**
 * Normalizes an email address.
 */
export function normalizeEmail(email) {
  return typeof email === "string" ? email.toLowerCase().trim() : "";
}

/**
 * Generates a cryptographically secure numeric OTP of the specified length (default 6).
 */
export function generateOtp(length = 6) {
  if (length <= 0 || length > 10) {
    throw new Error("Invalid OTP length");
  }
  const min = 10 ** (length - 1);
  const max = 10 ** length;
  const num = crypto.randomInt(min, max);
  return String(num);
}

/**
 * Hashes an OTP along with the user's email and an application salt.
 */
export function hashOtp(email, otp, salt) {
  const normEmail = normalizeEmail(email);
  return crypto
    .createHash("sha256")
    .update(`${normEmail}:${otp}:${salt}`)
    .digest("hex");
}

/**
 * Constant-time comparison between candidate OTP and expected hash.
 */
export function verifyOtpHash(email, candidateOtp, expectedHash, salt) {
  if (!email || !candidateOtp || !expectedHash || !salt) {
    return false;
  }
  const candidateHash = hashOtp(email, candidateOtp, salt);
  const candidateBuf = Buffer.from(candidateHash, "hex");
  const expectedBuf = Buffer.from(expectedHash, "hex");

  if (candidateBuf.length !== expectedBuf.length) {
    return false;
  }

  return crypto.timingSafeEqual(candidateBuf, expectedBuf);
}

/**
 * Generates a high-entropy session token (256 bits / 64 hex chars).
 */
export function generateSessionToken() {
  return crypto.randomBytes(32).toString("hex");
}

/**
 * Hashes a session token using SHA-256 for secure database storage.
 */
export function hashSessionToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}
