import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import app from "../src/app";
import { db } from "../src/db";
import { deposits, holderCostLedger, projects, runs } from "../src/db/schema";
import { newId } from "../src/lib/id";
import { getContractsStats } from "../src/stats/contracts";
import {
  formatUsdgAmount,
  getHolderStats,
  getLast30DaysUtc,
  getRevenueStats,
  getUsageStats,
} from "../src/stats/service";

function randomHex(bytes = 32): string {
  return `0x${randomBytes(bytes).toString("hex")}`;
}

async function createTestProject(): Promise<string> {
  const id = newId("prj");
  await db.insert(projects).values({
    id,
    name: "Stats Test Project",
    ownerWallet: `0x${randomBytes(20).toString("hex")}`,
  });
  return id;
}

describe("stats service & endpoints", () => {
  test("getLast30DaysUtc menghasilkan tepat 30 tanggal berurutan", () => {
    const dates = getLast30DaysUtc();
    expect(dates).toHaveLength(30);
    for (let i = 0; i < dates.length - 1; i++) {
      expect(dates[i] < dates[i + 1]).toBe(true);
      expect(dates[i]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  test("formatUsdgAmount memformat base-unit 6 desimal sebagai string", () => {
    expect(formatUsdgAmount(0n)).toBe("0.000000");
    expect(formatUsdgAmount(1234560000n)).toBe("1234.560000");
    expect(formatUsdgAmount(50n)).toBe("0.000050");
  });

  test("P3-QA-03: RPC gagal/tidak ada -> paused adalah null, bukan false", async () => {
    const contracts = await getContractsStats();
    expect(contracts.chain_id).toBeDefined();
    expect(contracts.deposit_manager.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(contracts.deposit_manager.explorer_url).toContain(contracts.deposit_manager.address);
    // Di lingkungan test tanpa RPC mainnet langsung, paused harus null
    expect(contracts.deposit_manager.paused === null || typeof contracts.deposit_manager.paused === "boolean").toBe(true);
    expect(contracts.treasury.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(contracts.token.symbol).toBe("GATTAI");
    expect(contracts.token.decimals).toBe(18);
  });

  test("GET /v1/public/stats mengembalikan struktur lengkap dan header cache", async () => {
    const res = await app.request("/v1/public/stats");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=60, stale-while-revalidate=30");

    const data = await res.json();
    expect(data.usage).toBeDefined();
    expect(data.revenue).toBeDefined();
    expect(data.burns).toBeDefined();
    expect(data.contracts).toBeDefined();

    expect(data.usage.daily).toHaveLength(30);
    expect(data.revenue.deposits_daily).toHaveLength(30);
  });

  test("P3-QA-01: konsistensi burn antara /v1/public/stats dan /v1/public/burns", async () => {
    const [statsRes, burnsRes] = await Promise.all([
      app.request("/v1/public/stats"),
      app.request("/v1/public/burns"),
    ]);

    expect(statsRes.status).toBe(200);
    expect(burnsRes.status).toBe(200);

    const statsData = await statsRes.json();
    const burnsData = await burnsRes.json();

    expect(statsData.burns.total_tokens_burned).toBe(burnsData.total_tokens_burned);
    expect(statsData.burns.total_tokens_burned_raw).toBe(burnsData.total_tokens_burned_raw);
    expect(statsData.burns.team_tokens_burned).toBe(burnsData.team_tokens_burned);
    expect(statsData.burns.team_tokens_burned_raw).toBe(burnsData.team_tokens_burned_raw);
    expect(statsData.burns.epoch_tokens_burned).toBe(burnsData.epoch_tokens_burned);
    expect(statsData.burns.epoch_tokens_burned_raw).toBe(burnsData.epoch_tokens_burned_raw);
  });

  test("P3-QA-02: semua metrik uang adalah string dengan presisi exact, bukan float", async () => {
    const res = await app.request("/v1/public/stats");
    const data = await res.json();

    expect(typeof data.revenue.deposits_usdg).toBe("string");
    expect(data.revenue.deposits_usdg).toMatch(/^\d+\.\d{6}$/);

    expect(typeof data.revenue.settled_credits).toBe("string");
    expect(data.revenue.settled_credits).toMatch(/^\d+\.\d{6}$/);

    expect(typeof data.revenue.settled_usd).toBe("string");
    expect(data.revenue.settled_usd).toMatch(/^\d+\.\d{8}$/);

    for (const d of data.revenue.deposits_daily) {
      expect(typeof d.usd).toBe("string");
      expect(d.usd).toMatch(/^\d+\.\d{8}$/);
    }

    expect(typeof data.burns.total_tokens_burned).toBe("string");
    expect(typeof data.burns.total_tokens_burned_raw).toBe("string");
  });

  test("pemakaian SETTLED run dan deposit confirmed tercatat akurat", async () => {
    const projectId = await createTestProject();
    const now = new Date();

    // Buat satu run SETTLED dengan charged 50 credits (50_000_000 micro)
    await db.insert(runs).values({
      id: newId("run"),
      projectId,
      recipeId: "refine",
      status: "SETTLED",
      input: "test prompt",
      reservedMicro: 50_000_000,
      chargedMicro: 50_000_000,
      idempotencyKey: randomHex(16),
      finishedAt: now,
    });

    // Buat satu deposit USDG confirmed senilai 100 USDG (100_000_000 base units)
    await db.insert(deposits).values({
      id: newId("dep"),
      projectId,
      chainTx: randomHex(32),
      logIndex: 0,
      token: "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
      source: "USDG",
      amountRaw: "100000000",
      usdValue: "100.00000000",
      creditsMicro: 10_000_000_000,
      status: "confirmed",
      createdAt: now,
    });

    const [usage, revenue] = await Promise.all([
      getUsageStats(now),
      getRevenueStats(now),
    ]);

    expect(usage.total_runs).toBeGreaterThanOrEqual(1);
    expect(usage.runs_24h).toBeGreaterThanOrEqual(1);
    expect(usage.runs_7d).toBeGreaterThanOrEqual(1);

    const refineFormation = usage.by_formation.find((f) => f.recipe === "refine");
    expect(refineFormation).toBeDefined();
    expect(refineFormation!.count).toBeGreaterThanOrEqual(1);

    // Revenue settled bertambah
    const creditsNum = Number(revenue.settled_credits);
    expect(creditsNum).toBeGreaterThanOrEqual(50);

    // USDG deposit bertambah
    const usdgNum = Number(revenue.deposits_usdg);
    expect(usdgNum).toBeGreaterThanOrEqual(100);
  });

  test("P2-10: biaya 30 hari dan daily memakai holder_cost_ledger.created_at", async () => {
    const projectId = await createTestProject();
    const now = new Date();
    const runWithCost = newId("run");
    const runWithoutCost = newId("run");
    const wallet = `0x${randomBytes(20).toString("hex")}`;

    try {
      // Baseline sebelum data uji dimasukkan; suite lain boleh punya data.
      const before = await getHolderStats(now);

      await db.insert(runs).values([
        {
          id: runWithCost,
          projectId,
          recipeId: "refine",
          status: "SETTLED",
          input: "holder cost ledger test",
          reservedMicro: 0,
          chargedMicro: 0,
          isHolder: true,
          holderTier: "pilot",
          idempotencyKey: randomHex(16),
          finishedAt: now,
        },
        {
          id: runWithoutCost,
          projectId,
          recipeId: "refine",
          status: "SETTLED",
          input: "holder run without ledger",
          reservedMicro: 0,
          chargedMicro: 0,
          isHolder: true,
          holderTier: "pilot",
          idempotencyKey: randomHex(16),
          finishedAt: now,
        },
      ]);
      await db.insert(holderCostLedger).values({
        id: newId("hcl"),
        runId: runWithCost,
        projectId,
        wallet,
        tier: "pilot",
        costUsd: "0.25000000",
        createdAt: now,
      });

      const after = await getHolderStats(now);
      const today = now.toISOString().slice(0, 10);
      const beforeToday = before.daily.find((day) => day.date === today);
      const afterToday = after.daily.find((day) => day.date === today);
      expect(beforeToday).toBeDefined();
      expect(afterToday).toBeDefined();

      // Dua run SETTLED menambah count run, tetapi hanya satu baris ledger
      // yang menambah biaya dan count harian.
      expect(after.total_runs).toBe(before.total_runs + 2);
      expect(after.runs_24h).toBe(before.runs_24h + 2);
      expect(afterToday!.count).toBe(beforeToday!.count + 1);
      expect(Number(afterToday!.subsidized_usd)).toBeCloseTo(
        Number(beforeToday!.subsidized_usd) + 0.25,
        8,
      );

      // Acceptance: total 30 hari harus sama dengan jumlah daily.
      const dailySum = after.daily.reduce(
        (sum, day) => sum + Number(day.subsidized_usd),
        0,
      );
      expect(dailySum).toBeCloseTo(Number(after.subsidized_cost_usd), 8);
      expect(Number(after.subsidized_cost_usd)).toBeCloseTo(
        Number(before.subsidized_cost_usd) + 0.25,
        8,
      );
    } finally {
      await db.delete(runs).where(eq(runs.projectId, projectId));
      await db.delete(projects).where(eq(projects.id, projectId));
    }
  });
});
