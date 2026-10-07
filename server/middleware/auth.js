import { config } from "../config.js";
import { validateSession } from "../services/auth/authService.js";

/**
 * Parses raw Cookie header into req.cookies object.
 */
export function cookieParserMiddleware(req, _res, next) {
  const cookies = {};
  const cookieHeader = req.headers.cookie;

  if (cookieHeader) {
    const pairs = cookieHeader.split(";");
    for (const pair of pairs) {
      const idx = pair.indexOf("=");
      if (idx !== -1) {
        const key = pair.slice(0, idx).trim();
        const val = pair.slice(idx + 1).trim();
        try {
          cookies[key] = decodeURIComponent(val);
        } catch {
          cookies[key] = val;
        }
      }
    }
  }

  req.cookies = cookies;
  next();
}

/**
 * Sets the secure HTTP-only session cookie on the response.
 */
export function setSessionCookie(res, token, expiresAt) {
  res.cookie(config.auth.sessionCookieName, token, {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

/**
 * Clears the session cookie on the response.
 */
export function clearSessionCookie(res) {
  res.clearCookie(config.auth.sessionCookieName, {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: "lax",
    path: "/",
  });
}

/**
 * Enforces authenticated session on protected routes.
 */
export function requireAuth(req, res, next) {
  const token = req.cookies?.[config.auth.sessionCookieName];

  if (!token) {
    return res.status(401).json({
      ok: false,
      code: "UNAUTHORIZED",
      message: "Authentication required.",
    });
  }

  validateSession(token)
    .then((sessionData) => {
      if (!sessionData) {
        clearSessionCookie(res);
        return res.status(401).json({
          ok: false,
          code: "INVALID_SESSION",
          message: "Session is invalid or has expired.",
        });
      }

      req.user = sessionData.user;
      req.sessionId = sessionData.sessionId;
      next();
    })
    .catch((err) => {
      next(err);
    });
}

/**
 * Attaches user to req if authenticated, without blocking unauthenticated requests.
 */
export function optionalAuth(req, res, next) {
  const token = req.cookies?.[config.auth.sessionCookieName];

  if (!token) {
    req.user = null;
    return next();
  }

  validateSession(token)
    .then((sessionData) => {
      req.user = sessionData?.user || null;
      req.sessionId = sessionData?.sessionId || null;
      next();
    })
    .catch(() => {
      req.user = null;
      next();
    });
}
