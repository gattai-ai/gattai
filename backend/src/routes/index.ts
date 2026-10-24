import { Hono } from "hono";
import { env } from "../env";
import { csrfOriginGuard } from "../middleware/origin";
import { createRateLimiter, ipKey } from "../middleware/rate-limit";
import { balanceRoutes } from "./balance";
import { authRoutes } from "./auth";
import { chatCompletionsRoutes } from "./chat-completions";
import { conversationRoutes } from "./conversations";
import { createDepositRoutes } from "./deposits";
import { devRoutes } from "./dev";
import { holderRoutes } from "./holder";
import { keyRoutes } from "./keys";
import { leaderboardRoutes } from "./leaderboard";
import { projectRoutes } from "./project";
import { publicRoutes } from "./public";
import { recipeRoutes, routerRoutes } from "./recipes";
import { reloadRoutes } from "./reload";
import { runRoutes } from "./runs";
import { usageRoutes } from "./usage";

/** Router utama. `/auth` + `/v1/*`. */
export const api = new Hono();

// Penjaga CSRF (Origin/Sec-Fetch-Site) sebelum rate limit: permintaan
// lintas-situs ditolak tanpa menghabiskan jatah bucket IP.
api.use("*", csrfOriginGuard);

// Anti-abuse global per IP (termasuk /auth). Batas murah hati; kuota ketat
// per project dipasang di endpoint pembuatan run.
api.use(
  "*",
  createRateLimiter({
    windowMs: env.rateLimitWindowMs,
    max: env.rateLimitIpPerMin,
    key: ipKey,
  }),
);

api.route("/auth", authRoutes);

export const v1Routes = new Hono();
v1Routes.route("/recipes", recipeRoutes);
v1Routes.route("/router", routerRoutes);
v1Routes.route("/chat/completions", chatCompletionsRoutes);
v1Routes.route("/runs", runRoutes);
v1Routes.route("/conversations", conversationRoutes);
v1Routes.route("/balance", balanceRoutes);
v1Routes.route("/deposits", createDepositRoutes());
v1Routes.route("/usage", usageRoutes);
v1Routes.route("/keys", keyRoutes);
v1Routes.route("/leaderboard", leaderboardRoutes);
v1Routes.route("/holder", holderRoutes);
v1Routes.route("/project", projectRoutes);
v1Routes.route("/public", publicRoutes);
v1Routes.route("/dev", devRoutes);
v1Routes.route("/reload", reloadRoutes);

api.route("/v1", v1Routes);
