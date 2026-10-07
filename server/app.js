import express from "express";
import cors from "cors";
import { config } from "./config.js";
import { cookieParserMiddleware } from "./middleware/auth.js";
import healthRouter from "./routes/health.js";
import apiRouter from "./routes/api.js";

export function createApp() {
  const app = express();

  // Basic security headers
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    next();
  });

  // CORS configuration supporting credentials/cookies
  const origin = config.server.corsOrigin === "*" ? true : config.server.corsOrigin;
  app.use(
    cors({
      origin,
      credentials: true,
    })
  );

  // Body parsing & Cookie parsing
  app.use(express.json({ limit: "10mb" }));
  app.use(cookieParserMiddleware);

  // Routes
  app.use(healthRouter);
  app.use("/api", apiRouter);

  // 404 handler
  app.use((_req, res) => {
    res.status(404).json({
      ok: false,
      code: "NOT_FOUND",
      message: "The requested route does not exist.",
    });
  });

  // Global error handler
  app.use((err, _req, res, _next) => {
    const status = err.status || 500;
    res.status(status).json({
      ok: false,
      code: err.code || "INTERNAL_SERVER_ERROR",
      message: config.isProduction ? "An unexpected server error occurred." : err.message,
    });
  });

  return app;
}

export default createApp();
