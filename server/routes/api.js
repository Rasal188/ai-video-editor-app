import { Router } from "express";
import authRouter from "./auth.js";
import projectsRouter from "./projects.js";
import assetsRouter from "./assets.js";
import rendersRouter from "./renders.js";
import assistantRouter from "./assistant.js";

const apiRouter = Router();

apiRouter.use("/auth", authRouter);
apiRouter.use("/projects", projectsRouter);
apiRouter.use("/assets", assetsRouter);
apiRouter.use("/renders", rendersRouter);
apiRouter.use("/assistant", assistantRouter);

export default apiRouter;
