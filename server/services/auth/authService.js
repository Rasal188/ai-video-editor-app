import { config } from "../../config.js";
import {
  generateOtp,
  hashOtp,
  verifyOtpHash,
  generateSessionToken,
  hashSessionToken,
  isValidEmail,
  normalizeEmail,
} from "./crypto.js";
import {
  createOtpChallenge,
  getLatestActiveChallenge,
  incrementChallengeAttempts,
  markChallengeConsumed,
  createSession,
  getSessionWithUser,
  touchSession,
  deleteSessionByTokenHash,
} from "../../db/queries/auth.js";
import { getUserByEmail, createUser } from "../../db/queries/users.js";
import { getEmailProvider } from "../email/emailProvider.js";

export class AuthError extends Error {
  constructor(message, { code = "AUTH_ERROR", status = 400 } = {}) {
    super(message);
    this.name = "AuthError";
    this.code = code;
    this.status = status;
  }
}

/**
 * Handles requesting a new OTP verification code.
 */
export async function requestOtp(
  { email },
  { executor = null, emailProvider = null } = {}
) {
  if (!email || !isValidEmail(email)) {
    throw new AuthError("A valid email address is required.", {
      code: "INVALID_EMAIL",
      status: 400,
    });
  }

  const normalized = normalizeEmail(email);

  // Check resend cooldown
  const latestChallenge = await getLatestActiveChallenge(normalized, executor);
  if (latestChallenge) {
    const elapsedSeconds =
      (Date.now() - new Date(latestChallenge.created_at).getTime()) / 1000;
    if (elapsedSeconds < config.auth.otpResendCooldownSeconds) {
      const waitSeconds = Math.ceil(config.auth.otpResendCooldownSeconds - elapsedSeconds);
      throw new AuthError(
        `Please wait ${waitSeconds} seconds before requesting another code.`,
        {
          code: "COOLDOWN_ACTIVE",
          status: 429,
        }
      );
    }
  }

  // Generate cryptographically secure OTP
  const otp = generateOtp(config.auth.otpLength);
  const otpHash = hashOtp(normalized, otp, config.auth.salt);
  const expiresAt = new Date(
    Date.now() + config.auth.otpExpiresInMinutes * 60 * 1000
  );

  // Store hashed OTP in database
  await createOtpChallenge(
    {
      email: normalized,
      otpHash,
      expiresAt,
      maxAttempts: config.auth.otpMaxAttempts,
    },
    executor
  );

  // Deliver OTP via configured email provider
  const mailer = emailProvider || getEmailProvider();
  await mailer.sendOtpEmail({
    email: normalized,
    otp,
    expiresInMinutes: config.auth.otpExpiresInMinutes,
  });

  return {
    success: true,
    message: "If the email can receive a verification code, one has been sent.",
  };
}

/**
 * Verifies an OTP code, logs in or registers the user, and creates a session.
 */
export async function verifyOtp(
  { email, otp },
  { executor = null } = {}
) {
  if (!email || !isValidEmail(email)) {
    throw new AuthError("A valid email address is required.", {
      code: "INVALID_EMAIL",
      status: 400,
    });
  }

  if (!otp || typeof otp !== "string" || !otp.trim()) {
    throw new AuthError("A verification code is required.", {
      code: "INVALID_OTP",
      status: 400,
    });
  }

  const normalized = normalizeEmail(email);
  const candidateOtp = otp.trim();

  // Find active challenge
  const challenge = await getLatestActiveChallenge(normalized, executor);
  if (!challenge) {
    throw new AuthError("Invalid or expired verification code.", {
      code: "INVALID_OTP",
      status: 400,
    });
  }

  // Check attempt limit
  if (challenge.attempt_count >= challenge.max_attempts) {
    throw new AuthError(
      "Maximum verification attempts exceeded. Please request a new code.",
      {
        code: "MAX_ATTEMPTS_EXCEEDED",
        status: 400,
      }
    );
  }

  // Check expiration
  if (new Date(challenge.expires_at).getTime() < Date.now()) {
    throw new AuthError("Verification code has expired. Please request a new one.", {
      code: "EXPIRED_OTP",
      status: 400,
    });
  }

  // Verify hash
  const isValid = verifyOtpHash(
    normalized,
    candidateOtp,
    challenge.otp_hash,
    config.auth.salt
  );

  if (!isValid) {
    await incrementChallengeAttempts(challenge.id, executor);
    throw new AuthError("Invalid verification code.", {
      code: "INVALID_OTP",
      status: 400,
    });
  }

  // Mark challenge consumed
  await markChallengeConsumed(challenge.id, executor);

  // Retrieve or create user
  let user = await getUserByEmail(normalized, executor);
  if (!user) {
    const defaultName = normalized.split("@")[0];
    user = await createUser(
      {
        email: normalized,
        name: defaultName,
      },
      executor
    );
  }

  // Generate high-entropy session token
  const rawToken = generateSessionToken();
  const tokenHash = hashSessionToken(rawToken);
  const sessionExpiresAt = new Date(
    Date.now() + config.auth.sessionDurationDays * 24 * 60 * 60 * 1000
  );

  await createSession(
    {
      userId: user.id,
      tokenHash,
      expiresAt: sessionExpiresAt,
    },
    executor
  );

  return {
    rawToken,
    sessionExpiresAt,
    user: {
      id: user.id,
      email: user.email,
      displayName: user.name,
    },
  };
}

/**
 * Validates a raw session token and returns the authenticated user.
 */
export async function validateSession(rawToken, executor = null) {
  if (!rawToken || typeof rawToken !== "string") {
    return null;
  }

  const tokenHash = hashSessionToken(rawToken);
  const sessionWithUser = await getSessionWithUser(tokenHash, executor);

  if (!sessionWithUser) {
    return null;
  }

  // Touch session asynchronously (safe, non-blocking)
  touchSession(sessionWithUser.session_id, executor).catch(() => {});

  return {
    sessionId: sessionWithUser.session_id,
    user: {
      id: sessionWithUser.user_id,
      email: sessionWithUser.email,
      displayName: sessionWithUser.name,
      createdAt: sessionWithUser.user_created_at,
    },
  };
}

/**
 * Destroys an active session.
 */
export async function logoutSession(rawToken, executor = null) {
  if (!rawToken || typeof rawToken !== "string") {
    return true;
  }

  const tokenHash = hashSessionToken(rawToken);
  await deleteSessionByTokenHash(tokenHash, executor);
  return true;
}
