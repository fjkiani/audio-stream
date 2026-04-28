import { Router, type IRouter } from "express";
import healthRouter from "./health";
import tokenRouter from "./token";
import copilotRouter from "./copilot";
import transcribeRouter from "./transcribe";
import transcriptsRouter from "./transcripts";

const router: IRouter = Router();

router.use(healthRouter);
router.use(tokenRouter);
router.use(copilotRouter);
router.use(transcribeRouter);
router.use(transcriptsRouter);

export default router;
