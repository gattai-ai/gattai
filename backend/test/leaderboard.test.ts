import { afterAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import app from "../src/app";
import { db } from "../src/db";
import { apiKeys, projects, runs } from "../src/db/schema";
import { generateApiKey, hashSecret } from "../src/lib/crypto";
import { newId } from "../src/lib/id";
import {
  DAILY_RUN_CAP,
  getLeaderboardRanking,
  leaderboardDisplayName,
  leaderboardMeRank,
  leaderboardRankOf,
} from "../src/leaderboard/service";
import { weekWindow } from "../src/leaderboard/week";

/**
 * Leaderboard mingguan:
 *  - window Senin UTC,
 *  - cap 200 run/project/hari,
 *  - trial tetap dihitung,
 *  - opt-out dan exclusion benar-benar hilang dari daftar,
 *  - rank `me` tetap tersedia di luar top 20.
 *
 * Semua run test ditaruh di minggu sebelumnya supaya tidak bercampur dengan run
 * test lain yang biasanya memakai `finishedAt = now`.
 */

const NOW = new Date();
const PREV = weekWindow("previous", NOW);
const DAY_ONE = new Date(PREV.start.getTime() + 12 * 60 * 60 * 1000);
const DAY_TWO = new Date(PREV.start.getTime() + 36 * 60 * 60 * 1000);

const OLD_EXCLUDED = process.env.LEADERBOARD_EXCLUDED_WALLETS;

afterAll(() => {
  if (OLD_EXCLUDED === undefined) delete process.env.LEADERBOARD_EXCLUDED_WALLETS;
  else process.env.LEADERBOARD_EXCLUDED_WALLETS = OLD_EXCLUDED;
});

function auth(secret: string): Record<string, string> {
  return { authorization: `Bearer ${secret}`, "content-type": "application/json" };
}

function randomWallet(): string {
  return `0x${randomBytes(20).toString("hex")}`;
}

async function newProject(
  name: string,
  ownerWallet = randomWallet(),
): Promise<{ id: string; secret: string; wallet: string }> {
  const id = newId("prj");
  await db.insert(projects).values({ id, name, ownerWallet });
  const generated = generateApiKey();
  await db.insert(apiKeys).values({
    id: newId("key"),
    projectId: id,
    prefix: generated.prefix,
    hash: hashSecret(generated.secret),
    label: name,
  });
  return { id, secret: generated.secret, wallet: ownerWallet };
}

async function seedRuns(
  projectId: string,
  count: number,
  finishedAt: Date,
  isTrial = false,
): Promise<void> {
  const values = Array.from({ length: count }, () => ({
    id: newId("run"),
    projectId,
    recipeId: "refine",
    status: "SETTLED" as const,
    mode: "streaming",
    input: "leaderboard test",
    isTrial,
    idempotencyKey: newId("idem"),
    finishedAt,
  }));
  for (let index = 0; index < values.length; index += 100) {
    await db.insert(runs).values(values.slice(index, index + 100));
  }
}

function findStat(
  ranking: Awaited<ReturnType<typeof getLeaderboardRanking>>,
  projectId: string,
) {
  return ranking.stats.find((stat) => stat.projectId === projectId);
}

describe("leaderboard week window", () => {
  test("Senin 00:00 UTC, termasuk edge Minggu malam", () => {
    const sunday = new Date("2026-10-25T23:59:59.999Z");
    const monday = new Date("2026-10-26T00:00:00.000Z");

    expect(weekWindow("current", sunday).start.toISOString()).toBe("2026-10-19T00:00:00.000Z");
    expect(weekWindow("current", monday).start.toISOString()).toBe("2026-10-26T00:00:00.000Z");
    expect(weekWindow("previous", monday).start.toISOString()).toBe("2026-10-19T00:00:00.000Z");
    expect(weekWindow("previous", monday).end.toISOString()).toBe("2026-10-26T00:00:00.000Z");
  });
});

describe("leaderboard aggregation", () => {
  test("cap 200 per project per hari, bukan per minggu", async () => {
    const oneDay = await newProject("cap-one-day");
    await seedRuns(oneDay.id, 500, DAY_ONE);

    const twoDays = await newProject("cap-two-days");
    await seedRuns(twoDays.id, 150, DAY_ONE);
    await seedRuns(twoDays.id, 150, DAY_TWO);

    const ranking = await getLeaderboardRanking(PREV);
    expect(findStat(ranking, oneDay.id)?.runs).toBe(DAILY_RUN_CAP);
    expect(findStat(ranking, twoDays.id)?.runs).toBe(300);
  });

  test("trial tetap dihitung", async () => {
    const project = await newProject("trial-counted");
    await seedRuns(project.id, 3, DAY_ONE, true);

    const ranking = await getLeaderboardRanking(PREV);
    expect(findStat(ranking, project.id)?.runs).toBe(3);
    expect(ranking.ranked.some((stat) => stat.projectId === project.id)).toBe(true);
  });

  test("exclusion wallet tim/kontrak tidak muncul di ranking", async () => {
    const wallet = randomWallet();
    process.env.LEADERBOARD_EXCLUDED_WALLETS = wallet;
    const project = await newProject("excluded-wallet", wallet);
    await seedRuns(project.id, 5, DAY_ONE);

    const ranking = await getLeaderboardRanking(PREV);
    expect(findStat(ranking, project.id)?.excluded).toBe(true);
    expect(ranking.ranked.some((stat) => stat.projectId === project.id)).toBe(false);
  });

  test("wallet tim dari TEAM_BURN_WALLETS dikecualikan otomatis", async () => {
    const wallet = randomWallet();
    const previous = process.env.TEAM_BURN_WALLETS;
    process.env.TEAM_BURN_WALLETS = wallet;
    try {
      const project = await newProject("team-wallet", wallet);
      await seedRuns(project.id, 7, DAY_ONE);

      const ranking = await getLeaderboardRanking(PREV);
      expect(findStat(ranking, project.id)?.excluded).toBe(true);
      expect(ranking.ranked.some((stat) => stat.projectId === project.id)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.TEAM_BURN_WALLETS;
      else process.env.TEAM_BURN_WALLETS = previous;
    }
  });

  test("public response top 20, tanpa wallet/project id", async () => {
    const projectsToSeed = 21;
    for (let index = 0; index < projectsToSeed; index += 1) {
      const project = await newProject(`top20-${index}`);
      await seedRuns(project.id, 1, DAY_ONE);
    }

    const response = await app.request("/v1/public/leaderboard?week=previous");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("max-age=60");

    const body = (await response.json()) as {
      week: { label: string };
      entries: Array<Record<string, unknown>>;
      me: null;
      updated_at: string;
    };
    expect(body.week.label).toBe("previous");
    expect(body.entries).toHaveLength(20);
    expect(body.me).toBeNull();
    expect(new Date(body.updated_at).toString()).not.toBe("Invalid Date");

    for (const [index, entry] of body.entries.entries()) {
      expect(entry.rank).toBe(index + 1);
      expect(typeof entry.display_name).toBe("string");
      expect(String(entry.display_name)).toMatch(/^Project [0-9a-f]{4}$/);
      expect(typeof entry.runs).toBe("number");
      expect(entry.is_me).toBe(false);
      expect(entry).not.toHaveProperty("project_id");
      expect(entry).not.toHaveProperty("owner_wallet");
      expect(entry).not.toHaveProperty("wallet");
    }
  });
});

describe("leaderboard opt-out & me", () => {
  test("opt-out menghilangkan project dari ranking tetapi rank me tetap terlihat", async () => {
    const project = await newProject("opt-out-project");
    await seedRuns(project.id, 210, DAY_ONE);
    const displayName = leaderboardDisplayName(project.id);

    const optOut = await app.request("/v1/leaderboard/opt-out", {
      method: "POST",
      headers: auth(project.secret),
      body: JSON.stringify({ opted_out: true }),
    });
    expect(optOut.status).toBe(200);
    expect(await optOut.json()).toEqual({ opted_out: true });

    const ranking = await getLeaderboardRanking(PREV);
    expect(findStat(ranking, project.id)?.optedOut).toBe(true);
    expect(ranking.ranked.some((stat) => stat.projectId === project.id)).toBe(false);
    const ownRank = leaderboardMeRank(ranking, project.id);
    expect(ownRank).not.toBeNull();

    const publicResponse = await app.request("/v1/public/leaderboard?week=previous");
    const publicBody = (await publicResponse.json()) as {
      entries: Array<{ display_name: string }>;
    };
    expect(publicBody.entries.some((entry) => entry.display_name === displayName)).toBe(false);

    const me = await app.request("/v1/leaderboard/me?week=previous", {
      headers: auth(project.secret),
    });
    expect(me.status).toBe(200);
    expect(me.headers.get("cache-control")).toContain("no-store");
    const meBody = (await me.json()) as {
      me: { rank: number | null; runs: number; opted_out: boolean; display_name: string };
    };
    expect(meBody.me).toMatchObject({
      rank: ownRank,
      runs: 200,
      opted_out: true,
      display_name: displayName,
    });

    // Idempotent dan bisa ikut lagi.
    const again = await app.request("/v1/leaderboard/opt-out", {
      method: "POST",
      headers: auth(project.secret),
      body: JSON.stringify({ opted_out: true }),
    });
    expect(again.status).toBe(200);

    const join = await app.request("/v1/leaderboard/opt-out", {
      method: "POST",
      headers: auth(project.secret),
      body: JSON.stringify({ opted_out: false }),
    });
    expect(join.status).toBe(200);
    expect(await join.json()).toEqual({ opted_out: false });

    const meAfter = await app.request("/v1/leaderboard/me?week=previous", {
      headers: auth(project.secret),
    });
    const meAfterBody = (await meAfter.json()) as {
      me: { rank: number | null; runs: number; opted_out: boolean };
    };
    expect(meAfterBody.me.opted_out).toBe(false);
    expect(meAfterBody.me.runs).toBe(200);
    expect(meAfterBody.me.rank).not.toBeNull();
  });

  test("rank me cocok dengan ranking lengkap di luar top 20", async () => {
    const project = await newProject("me-rank");
    await seedRuns(project.id, 4, DAY_ONE);

    const ranking = await getLeaderboardRanking(PREV);
    const expectedRank = leaderboardRankOf(ranking, project.id);
    expect(expectedRank).not.toBeNull();

    const me = await app.request("/v1/leaderboard/me?week=previous", {
      headers: auth(project.secret),
    });
    expect(me.status).toBe(200);
    const body = (await me.json()) as {
      me: { rank: number | null; runs: number; opted_out: boolean; display_name: string };
    };
    expect(body.me.rank).toBe(expectedRank);
    expect(body.me.runs).toBe(4);
    expect(body.me.opted_out).toBe(false);
    expect(body.me.display_name).toBe(leaderboardDisplayName(project.id));
  });

  test("week tidak sah ditolak 400", async () => {
    const response = await app.request("/v1/public/leaderboard?week=last");
    expect(response.status).toBe(400);
  });

  test("me butuh auth", async () => {
    const response = await app.request("/v1/leaderboard/me");
    expect(response.status).toBe(401);
  });
});
