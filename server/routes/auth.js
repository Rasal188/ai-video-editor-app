import { Router } from "express";
import {
  requestOtp,
  verifyOtp,
  logoutSession,
  AuthError,
} from "../services/auth/authService.js";
import {
  setSessionCookie,
  clearSessionCookie,
  requireAuth,
} from "../middleware/auth.js";
import { createRateLimiter } from "../middleware/rateLimiter.js";
import { config } from "../config.js";

const router = Router();

// Rate limiters for auth endpoints
const requestOtpLimiter = createRateLimiter({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 15,
  message: "Too many verification requests. Please try again later.",
});

const verifyOtpLimiter = createRateLimiter({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 30,
  message: "Too many verification attempts. Please try again later.",
});

/**
 * POST /api/auth/request-otp
 * Generates and dispatches a passwordless OTP to the given email.
 */
router.post("/request-otp", requestOtpLimiter, async (req, res, next) => {
  try {
    const { email } = req.body || {};
    const result = await requestOtp({ email });
    return res.status(200).json(result);
  } catch (err) {
    if (err instanceof AuthError) {
      return res.status(err.status).json({
        ok: false,
        code: err.code,
        message: err.message,
      });
    }
    next(err);
  }
});

/**
 * POST /api/auth/verify-otp
 * Verifies the OTP, provisions the user if necessary, and issues an HTTP-only session cookie.
 */
router.post("/verify-otp", verifyOtpLimiter, async (req, res, next) => {
  try {
    const { email, otp } = req.body || {};
    const result = await verifyOtp({ email, otp });

    // Set secure HTTP-only cookie
    setSessionCookie(res, result.rawToken, result.sessionExpiresAt);

    // Return safe user info (never return token or OTP)
    return res.status(200).json({
      success: true,
      user: result.user,
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return res.status(err.status).json({
        ok: false,
        code: err.code,
        message: err.message,
      });
    }
    next(err);
  }
});

/**
 * GET /api/auth/me
 * Returns current authenticated user details.
 */
router.get("/me", requireAuth, (req, res) => {
  return res.status(200).json({
    success: true,
    user: req.user,
  });
});

/**
 * POST /api/auth/logout
 * Destroys the current session and clears the session cookie.
 */
router.post("/logout", async (req, res, next) => {
  try {
    const token = req.cookies?.[config.auth.sessionCookieName];
    if (token) {
      await logoutSession(token);
    }
    clearSessionCookie(res);
    return res.status(200).json({
      success: true,
      message: "Logged out successfully.",
    });
  } catch (err) {
    next(err);
  }
});

export default router;
