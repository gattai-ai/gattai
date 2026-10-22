import { Hono } from "hono";
import { getBalanceMicro, listLots } from "../billing/ledger";
import { microToCredits } from "../lib/money";
import { requireProject } from "../middleware/auth";
import { serializeLot } from "../serialize";
import type { AppEnv } from "../types";

export const balanceRoutes = new Hono<AppEnv>();
balanceRoutes.use("*", requireProject);

balanceRoutes.get("/", async (c) => {
  const project = c.get("project");
  const balanceMicro = await getBalanceMicro(project.id);
  const lots = await listLots(project.id);
  return c.json({
    balance_micro: balanceMicro,
    balance_credits: microToCredits(balanceMicro),
    lots: lots.map(serializeLot),
  });
});
