import { reloadConfig } from "../config";
import { Hono } from "hono";
import { requireProject } from "../middleware/auth";
import type { AppEnv } from "../types";

/** Muat ulang config (recipes/pricing/params) tanpa restart server. */
export const reloadRoutes = new Hono<AppEnv>();
reloadRoutes.use("*", requireProject);

reloadRoutes.post("/", (c) => {
  const config = reloadConfig();
  return c.json({ ok: true, recipes: config.recipes.length });
});
