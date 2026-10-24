import { Hono } from "hono";
import { requireProject } from "../middleware/auth";
import { getHolderStatus } from "../holder/service";
import type { AppEnv } from "../types";

export const holderRoutes = new Hono<AppEnv>();
holderRoutes.use("*", requireProject);

/**
 * GET /v1/holder/status
 *
 * Mengembalikan status tier, snapshot saldo token onchain, sisa kuota gratis hari ini,
 * kemajuan ke tier berikutnya, status pending snapshot kedua, riwayat pemakaian hari ini,
 * anggaran platform, dan status kill switch untuk wallet pengguna saat ini.
 */
holderRoutes.get("/status", async (c) => {
  const project = c.get("project");
  const status = await getHolderStatus(project.ownerWallet, project.id);
  c.header("Cache-Control", "private, no-store");
  return c.json(status);
});
