import { Hono } from "hono";
import { z } from "zod";
import { getBalanceMicro, recordCreditLot } from "../billing/ledger";
import { isProd } from "../env";
import { ApiError } from "../lib/http";
import { creditsToMicro, microToCredits } from "../lib/money";
import { newId } from "../lib/id";
import { requireProject } from "../middleware/auth";
import type { AppEnv } from "../types";

/**
 * Endpoint pengembangan untuk menambah credits tanpa onchain.
 * Dipakai pada Fase 1; diganti integrasi deposit onchain di Fase 2.
 * Dinonaktifkan di produksi.
 */
export const devRoutes = new Hono<AppEnv>();
devRoutes.use("*", requireProject);

const schema = z.object({
  credits: z.number().positive().optional(),
  micro: z.number().int().positive().optional(),
});

devRoutes.post("/credits", async (c) => {
  if (isProd()) throw new ApiError(404, "NOT_FOUND", "Not available in production.");
  const project = c.get("project");
  const body = schema.parse(await c.req.json().catch(() => ({})));
  const micro = body.micro ?? (body.credits ? creditsToMicro(body.credits) : 0);
  if (micro <= 0) {
    throw new ApiError(400, "BAD_REQUEST", "Provide a positive value for `credits` or `micro`.");
  }

  const idempotencyKey = c.req.header("Idempotency-Key") ?? `dev:${newId("dep")}`;
  const result = await recordCreditLot({
    projectId: project.id,
    source: "PROMO",
    amountMicro: micro,
    idempotencyKey,
  });

  const balanceMicro = await getBalanceMicro(project.id);
  return c.json({
    applied: result.applied,
    lot_id: result.lotId,
    balance_micro: balanceMicro,
    balance_credits: microToCredits(balanceMicro),
  });
});
