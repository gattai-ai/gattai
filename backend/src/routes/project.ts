import { Hono } from "hono";
import { getParams } from "../config";
import { db } from "../db";
import { readTrialState } from "../billing/trial";
import { requireProject } from "../middleware/auth";
import type { AppEnv } from "../types";

/**
 * Info project untuk sesi/key aktif. Menyertakan `onchain_id` (bytes32)
 * yang dipakai sebagai `projectId` pada `DepositManager.deposit()`, plus sisa
 * kuota trial gratis milik wallet ini.
 */
export const projectRoutes = new Hono<AppEnv>();
projectRoutes.use("*", requireProject);

projectRoutes.get("/", async (c) => {
  const project = c.get("project");
  const params = getParams();
  const trial = await readTrialState(
    db,
    project.id,
    params.trial.free_runs,
    params.trial.max_attempts,
  );
  return c.json({
    project_id: project.id,
    name: project.name,
    owner_wallet: project.ownerWallet,
    onchain_id: project.onchainId,
    status: project.status,
    created_at: project.createdAt,
    trial: {
      limit: trial.limit,
      text_used: trial.textUsed,
      remaining: trial.remaining,
      attempts_limit: trial.maxAttempts,
      attempts_used: trial.attempts,
      media_limit: params.trial.free_media_attempts,
      media_used: trial.mediaAttempts,
    },
  });
});
