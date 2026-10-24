import { Hono } from "hono";
import { z } from "zod";
import { requireProject } from "../middleware/auth";
import { getHolderStatus } from "../holder/service";
import {
  getLeaderboardRanking,
  isProjectOptedOut,
  leaderboardDisplayName,
  leaderboardMeRank,
  setProjectOptedOut,
} from "../leaderboard/service";
import { leaderboardWeekSchema, serializeWeek, weekWindow } from "../leaderboard/week";
import type { AppEnv } from "../types";

const optOutSchema = z.object({
  opted_out: z.boolean().default(true),
});

/** Endpoint leaderboard untuk project yang sedang login. */
export const leaderboardRoutes = new Hono<AppEnv>();
leaderboardRoutes.use("*", requireProject);

leaderboardRoutes.get("/me", async (c) => {
  c.header("Cache-Control", "private, no-store");
  const project = c.get("project");
  const week = leaderboardWeekSchema.parse(c.req.query("week") ?? "current");
  const window = weekWindow(week);
  const ranking = await getLeaderboardRanking(window);
  const stat = ranking.stats.find((entry) => entry.projectId === project.id);
  const optedOut = stat?.optedOut ?? (await isProjectOptedOut(project.id));

  let tier: { id: string; name: string } | null = null;
  try {
    const holderStatus = await getHolderStatus(project.ownerWallet, project.id);
    if (holderStatus.tier) {
      tier = { id: holderStatus.tier.id, name: holderStatus.tier.name };
    }
  } catch {
    // Abaikan error snapshot/RPC agar leaderboard tetap responsif
  }

  return c.json({
    week: serializeWeek(window),
    me: {
      rank: leaderboardMeRank(ranking, project.id),
      runs: stat?.runs ?? 0,
      opted_out: optedOut,
      display_name: leaderboardDisplayName(project.id),
      tier,
    },
  });
});

/**
 * Opt-out bersifat toggle eksplisit. Body kosong berarti opt-out (`true`) agar
 * pemanggilan sederhana tetap aman; frontend selalu mengirim nilai boolean.
 */
leaderboardRoutes.post("/opt-out", async (c) => {
  c.header("Cache-Control", "private, no-store");
  const project = c.get("project");
  const body = optOutSchema.parse(await c.req.json().catch(() => ({})));
  await setProjectOptedOut(project.id, body.opted_out);
  return c.json({ opted_out: body.opted_out });
});
