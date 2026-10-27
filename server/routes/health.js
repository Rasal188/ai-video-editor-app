import { Router } from "express";
import { checkHealth } from "../db/index.js";

const router = Router();

router.get("/health", async (_req, res) => {
  const dbHealth = await checkHealth();
  const isHealthy = dbHealth.ok;

  const payload = {
    status: isHealthy ? "ok" : "degraded",
    service: "ai-video-editor-backend",
    version: "1.0.0",
    syncMode: "live-automated",
    timestamp: new Date().toISOString(),
    database: dbHealth,
  };

  return res.status(isHealthy ? 200 : 503).json(payload);
});

export default router;
