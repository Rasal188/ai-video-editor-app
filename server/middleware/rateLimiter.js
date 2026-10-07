/**
 * Lightweight in-memory rate limiter for single-server authentication protection.
 */
export function createRateLimiter({ windowMs = 60 * 1000, max = 10, message = "Too many requests. Please try again later." } = {}) {
  const hits = new Map();

  // Periodically clean up expired entries
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, record] of hits.entries()) {
      if (now > record.resetTime) {
        hits.delete(key);
      }
    }
  }, Math.max(windowMs, 30000));

  if (cleanupInterval.unref) {
    cleanupInterval.unref();
  }

  return (req, res, next) => {
    const ip = req.ip || req.socket?.remoteAddress || "127.0.0.1";
    const now = Date.now();
    let record = hits.get(ip);

    if (!record || now > record.resetTime) {
      record = { count: 1, resetTime: now + windowMs };
      hits.set(ip, record);
    } else {
      record.count += 1;
    }

    res.setHeader("X-RateLimit-Limit", max);
    res.setHeader("X-RateLimit-Remaining", Math.max(0, max - record.count));
    res.setHeader("X-RateLimit-Reset", Math.ceil(record.resetTime / 1000));

    if (record.count > max) {
      return res.status(429).json({
        ok: false,
        code: "RATE_LIMIT_EXCEEDED",
        message,
      });
    }

    next();
  };
}
