import { Hono } from "hono";
import { listLedger } from "../billing/ledger";
import { requireProject } from "../middleware/auth";
import { serializeLedger } from "../serialize";
import type { AppEnv } from "../types";

export const usageRoutes = new Hono<AppEnv>();
usageRoutes.use("*", requireProject);

/** Ambil integer query yang aman: non-angka/negatif → fallback, lalu klem. */
function parseBoundedInt(raw: string | undefined, fallback: number, max: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.floor(value), 0), max);
}

usageRoutes.get("/", async (c) => {
  const project = c.get("project");
  const limit = parseBoundedInt(c.req.query("limit"), 50, 200);
  const offset = parseBoundedInt(c.req.query("offset"), 0, 1_000_000);
  const entries = await listLedger(project.id, limit, offset);
  return c.json({ entries: entries.map(serializeLedger) });
});
