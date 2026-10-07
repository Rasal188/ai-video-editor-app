import { query as defaultQuery } from "../index.js";

/**
 * Creates a new OTP challenge record.
 */
export async function createOtpChallenge(
  { email, otpHash, expiresAt, maxAttempts = 5 },
  executor = null
) {
  const q = executor ? executor.query.bind(executor) : defaultQuery;
  const sql = `
    INSERT INTO otp_challenges (email, otp_hash, expires_at, max_attempts)
    VALUES ($1, $2, $3, $4)
    RETURNING id, email, expires_at, attempt_count, max_attempts, created_at;
  `;
  const result = await q(sql, [email.toLowerCase().trim(), otpHash, expiresAt, maxAttempts]);
  return result.rows[0];
}

/**
 * Retrieves the most recent active (unconsumed, unexpired) OTP challenge for an email.
 */
export async function getLatestActiveChallenge(email, executor = null) {
  const q = executor ? executor.query.bind(executor) : defaultQuery;
  const sql = `
    SELECT id, email, otp_hash, expires_at, attempt_count, max_attempts, consumed_at, created_at
    FROM otp_challenges
    WHERE email = $1
      AND consumed_at IS NULL
    ORDER BY created_at DESC
    LIMIT 1;
  `;
  const result = await q(sql, [email.toLowerCase().trim()]);
  return result.rows[0] || null;
}

/**
 * Increments the attempt count for an OTP challenge.
 */
export async function incrementChallengeAttempts(challengeId, executor = null) {
  const q = executor ? executor.query.bind(executor) : defaultQuery;
  const sql = `
    UPDATE otp_challenges
    SET attempt_count = attempt_count + 1
    WHERE id = $1
    RETURNING id, attempt_count, max_attempts;
  `;
  const result = await q(sql, [challengeId]);
  return result.rows[0] || null;
}

/**
 * Marks an OTP challenge as consumed.
 */
export async function markChallengeConsumed(challengeId, executor = null) {
  const q = executor ? executor.query.bind(executor) : defaultQuery;
  const sql = `
    UPDATE otp_challenges
    SET consumed_at = NOW()
    WHERE id = $1
    RETURNING id, consumed_at;
  `;
  const result = await q(sql, [challengeId]);
  return result.rows[0] || null;
}

/**
 * Creates a new session record.
 */
export async function createSession(
  { userId, tokenHash, expiresAt },
  executor = null
) {
  const q = executor ? executor.query.bind(executor) : defaultQuery;
  const sql = `
    INSERT INTO sessions (user_id, token_hash, expires_at)
    VALUES ($1, $2, $3)
    RETURNING id, user_id, expires_at, created_at, last_used_at;
  `;
  const result = await q(sql, [userId, tokenHash, expiresAt]);
  return result.rows[0];
}

/**
 * Looks up an unexpired session by token hash, joining user details.
 */
export async function getSessionWithUser(tokenHash, executor = null) {
  const q = executor ? executor.query.bind(executor) : defaultQuery;
  const sql = `
    SELECT 
      s.id AS session_id,
      s.token_hash,
      s.expires_at AS session_expires_at,
      s.created_at AS session_created_at,
      s.last_used_at,
      u.id AS user_id,
      u.email,
      u.name,
      u.created_at AS user_created_at
    FROM sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.token_hash = $1
      AND s.expires_at > NOW();
  `;
  const result = await q(sql, [tokenHash]);
  return result.rows[0] || null;
}

/**
 * Touches last_used_at on a session.
 */
export async function touchSession(sessionId, executor = null) {
  const q = executor ? executor.query.bind(executor) : defaultQuery;
  const sql = `
    UPDATE sessions
    SET last_used_at = NOW()
    WHERE id = $1;
  `;
  await q(sql, [sessionId]);
}

/**
 * Deletes a session by its token hash (logout).
 */
export async function deleteSessionByTokenHash(tokenHash, executor = null) {
  const q = executor ? executor.query.bind(executor) : defaultQuery;
  const sql = `
    DELETE FROM sessions
    WHERE token_hash = $1
    RETURNING id;
  `;
  const result = await q(sql, [tokenHash]);
  return Boolean(result.rowCount);
}

/**
 * Deletes all sessions for a user (e.g. on password change or full revoke).
 */
export async function deleteSessionsByUserId(userId, executor = null) {
  const q = executor ? executor.query.bind(executor) : defaultQuery;
  const sql = `
    DELETE FROM sessions
    WHERE user_id = $1;
  `;
  const result = await q(sql, [userId]);
  return result.rowCount;
}
