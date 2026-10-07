import { Router } from "express";
import authRouter from "./auth.js";
import projectsRouter from "./projects.js";
import assetsRouter from "./assets.js";
import rendersRouter from "./renders.js";

const apiRouter = Router();

apiRouter.use("/auth", authRouter);
apiRouter.use("/projects", projectsRouter);
apiRouter.use("/assets", assetsRouter);
apiRouter.use("/renders", rendersRouter);

export default apiRouter;
