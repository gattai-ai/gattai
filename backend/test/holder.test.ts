import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import app from "../src/app";
import { getParams } from "../src/config";
import { db } from "../src/db";
import { holderCostLedger, holderSnapshots, projects, runs } from "../src/db/schema";
import { env } from "../src/env";
import {
  calculateNextTierProgress,
  checkHolderEligibility,
  confirmedBlockNumber,
  deriveSnapshotStatus,
  estimateNextSnapshotHours,
  evaluateTierFromSnapshots,
  formatUnitsToScale,
  getHolderTodayRuns,
  getPublicHolderTiers,
  getStartOfTodayUtc,
  getStartOfTomorrowUtc,
  isHolderBudgetExhausted,
  recordHolderCost,
  recordSnapshot,
} from "../src/holder/service";
import { newId } from "../src/lib/id";
import { ApiError } from "../src/lib/http";
import { createRun } from "../src/orchestration/create-run";

describe("holder tiers service & algorithm", () => {
  const { tiers } = getParams().holder;

  test("0 snapshot: tidak ada active tier atau pending tier", () => {
    const res = evaluateTierFromSnapshots([], tiers, 2);
    expect(res.activeTier).toBeNull();
    expect(res.pendingTier).toBeNull();
    expect(res.effectiveTokens).toBe(0);
    expect(res.latestSnapshot).toBeNull();
  });

  test("confirmedBlockNumber membaca block di belakang head", () => {
    expect(confirmedBlockNumber(1000n, 60)).toBe(940n);
    expect(confirmedBlockNumber(1000n, 0)).toBe(1000n);
    expect(confirmedBlockNumber(50n, 60)).toBe(0n);
    expect(confirmedBlockNumber(1000n, -5)).toBe(1000n);
  });

  test("1 snapshot: tier belum aktif, masuk ke pendingTier", () => {
    const snap1 = {
      balanceTokens: "60000.0000",
      balanceRaw: "60000000000000000000000",
      blockNumber: 1000,
      takenAt: new Date(Date.now() - 3600000),
    };
    const res = evaluateTierFromSnapshots([snap1], tiers, 2);
    expect(res.activeTier).toBeNull();
    expect(res.pendingTier).not.toBeNull();
    expect(res.pendingTier?.id).toBe("commander");
    expect(res.effectiveTokens).toBe(0);
    expect(res.latestSnapshot?.balance).toBe("60000.0000");
    expect(res.latestSnapshot?.block_number).toBe(1000);
  });

  test("2 snapshot konsisten: activeTier terkualifikasi", () => {
    const snapLatest = {
      balanceTokens: "60000.0000",
      balanceRaw: "60000000000000000000000",
      blockNumber: 1050,
      takenAt: new Date(Date.now() - 3600000),
    };
    const snapPrev = {
      balanceTokens: "55000.0000",
      balanceRaw: "55000000000000000000000",
      blockNumber: 1000,
      takenAt: new Date(Date.now() - 90000000),
    };
    const res = evaluateTierFromSnapshots([snapLatest, snapPrev], tiers, 2);
    expect(res.activeTier?.id).toBe("commander");
    expect(res.pendingTier).toBeNull();
    expect(res.effectiveTokens).toBe(55000);
  });

  test("2 snapshot dengan top-up baru: activeTier tetap tier sebelumnya, pendingTier tier lebih tinggi", () => {
    const snapLatest = {
      balanceTokens: "260000.0000", // Cukup untuk Admiral
      balanceRaw: "260000000000000000000000",
      blockNumber: 1200,
      takenAt: new Date(Date.now() - 1000000),
    };
    const snapPrev = {
      balanceTokens: "15000.0000", // Hanya Pilot
      balanceRaw: "15000000000000000000000",
      blockNumber: 1100,
      takenAt: new Date(Date.now() - 86400000),
    };
    const res = evaluateTierFromSnapshots([snapLatest, snapPrev], tiers, 2);
    expect(res.activeTier?.id).toBe("pilot");
    expect(res.pendingTier?.id).toBe("admiral");
    expect(res.effectiveTokens).toBe(15000);
  });

  test("2 snapshot dengan token di-dump: saldo efektif turun ke min", () => {
    const snapLatest = {
      balanceTokens: "5000.0000", // Di bawah Pilot
      balanceRaw: "5000000000000000000000",
      blockNumber: 1300,
      takenAt: new Date(),
    };
    const snapPrev = {
      balanceTokens: "100000.0000", // Mantan Commander
      balanceRaw: "100000000000000000000000",
      blockNumber: 1200,
      takenAt: new Date(Date.now() - 86400000),
    };
    const res = evaluateTierFromSnapshots([snapLatest, snapPrev], tiers, 2);
    expect(res.activeTier).toBeNull();
    expect(res.pendingTier).toBeNull();
    expect(res.effectiveTokens).toBe(5000);
  });

  test("calculateNextTierProgress: menghitung target dan progress percentage dengan benar", () => {
    // 1. Belum ada tier, baru 4,000 token (target Pilot 10,000)
    const progressNoTier = calculateNextTierProgress(null, 4000, tiers);
    expect(progressNoTier).not.toBeNull();
    expect(progressNoTier?.id).toBe("pilot");
    expect(progressNoTier?.tokens_needed).toBe("6000.0000");
    expect(progressNoTier?.progress_pct).toBe(40);

    // 2. Pilot aktif (10,000), holding 30,000 token (target Commander 50,000: range 40,000, selisih 20,000 = 50%)
    const pilotTier = tiers.find((t) => t.id === "pilot")!;
    const progressPilot = calculateNextTierProgress(pilotTier, 30000, tiers);
    expect(progressPilot).not.toBeNull();
    expect(progressPilot?.id).toBe("commander");
    expect(progressPilot?.tokens_needed).toBe("20000.0000");
    expect(progressPilot?.progress_pct).toBe(50);

    // 3. Admiral aktif (tier tertinggi) -> null
    const admiralTier = tiers.find((t) => t.id === "admiral")!;
    const progressAdmiral = calculateNextTierProgress(admiralTier, 300000, tiers);
    expect(progressAdmiral).toBeNull();
  });

  test("estimateNextSnapshotHours: jam positif dalam batas interval", () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000);
    const hoursLeft = estimateNextSnapshotHours(twoHoursAgo, 24);
    expect(hoursLeft).toBeGreaterThanOrEqual(21);
    expect(hoursLeft).toBeLessThanOrEqual(23);
  });

  test("getStartOfTodayUtc & getStartOfTomorrowUtc: tepat pada 00:00:00 UTC", () => {
    const todayUtc = getStartOfTodayUtc();
    const tomorrowUtc = getStartOfTomorrowUtc();

    expect(todayUtc.getUTCHours()).toBe(0);
    expect(todayUtc.getUTCMinutes()).toBe(0);
    expect(todayUtc.getUTCSeconds()).toBe(0);
    expect(tomorrowUtc.getUTCHours()).toBe(0);
    expect(tomorrowUtc.getTime() - todayUtc.getTime()).toBe(24 * 3600 * 1000);
  });

  test("getPublicHolderTiers: mengembalikan 3 tier resmi dan aturan", () => {
    const data = getPublicHolderTiers();
    expect(data.tiers).toHaveLength(3);
    expect(data.tiers.map((t) => t.id)).toEqual(["pilot", "commander", "admiral"]);
    expect(data.rules.snapshot_interval_hours).toBe(24);
    expect(data.rules.consecutive_snapshots_required).toBe(2);
    expect(data.rules.reset_time_utc).toBe("00:00");
    expect(data.rules.enabled).toBe(true);
  });

  test("kuota Fleet Admiral sesuai brief: 50 teks + 3 media per hari", () => {
    const admiral = getPublicHolderTiers().tiers.find((t) => t.id === "admiral");
    expect(admiral).toBeDefined();
    expect(admiral?.free_runs_per_day).toBe(50);
    expect(admiral?.free_media_per_day).toBe(3);
  });

  test("GET /v1/public/formations mengirim cache header publik", async () => {
    const res = await app.request("/v1/public/formations");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=300, stale-while-revalidate=60",
    );
  });

  test("GET /v1/public/deposits/config mengirim cache header pendek", async () => {
    const res = await app.request("/v1/public/deposits/config");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=60, stale-while-revalidate=30",
    );
  });

  test("GET /v1/public/holder/tiers mengembalikan 200 dengan cache header yang benar", async () => {
    const res = await app.request("/v1/public/holder/tiers");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=300, stale-while-revalidate=60");

    const json = (await res.json()) as ReturnType<typeof getPublicHolderTiers>;
    expect(json.tiers).toHaveLength(3);
    expect(json.rules).toBeDefined();
    expect(json.tiers[0].name).toBe("Pilot");
  });

  test("GET /v1/holder/status tanpa auth mengembalikan 401", async () => {
    const res = await app.request("/v1/holder/status");
    expect(res.status).toBe(401);
  });

  test("dua snapshot terlalu dekat tidak boleh mengaktifkan tier", () => {
    const now = Date.now();
    const snapLatest = {
      balanceTokens: "60000.0000",
      balanceRaw: "60000000000000000000000",
      blockNumber: 2001,
      takenAt: new Date(now),
    };
    const snapPrev = {
      balanceTokens: "60000.0000",
      balanceRaw: "60000000000000000000000",
      blockNumber: 2000,
      takenAt: new Date(now - 3600_000),
    };
    const res = evaluateTierFromSnapshots([snapLatest, snapPrev], tiers, 2);
    expect(res.activeTier).toBeNull();
    expect(res.pendingTier?.id).toBe("commander");
    expect(res.effectiveTokens).toBe(0);
  });

  test("saldo di bawah ambang tidak dibulatkan naik menjadi tier", () => {
    // 9999.999999999999999999 token; pembulatan 4 desimal akan terlihat 10000.
    const snap = {
      balanceTokens: "10000.0000",
      balanceRaw: "9999999999999999999999",
      blockNumber: 3000,
      takenAt: new Date(),
    };
    const res = evaluateTierFromSnapshots([snap], tiers, 2);
    expect(res.pendingTier).toBeNull();
    expect(formatUnitsToScale(9999999999999999999999n, 18, 4)).toBe("9999.9999");
  });

  test("deriveSnapshotStatus membedakan ok/pending/stale/unavailable", () => {
    const now = new Date("2026-10-25T12:00:00.000Z");
    const base = {
      unavailable: false,
      consecutiveRequired: 2,
      intervalHours: 24,
      now,
    };

    expect(
      deriveSnapshotStatus({ ...base, snapshotCount: 0, latestTakenAt: null }),
    ).toBe("unavailable");
    expect(
      deriveSnapshotStatus({
        ...base,
        snapshotCount: 1,
        latestTakenAt: new Date(now.getTime() - 60 * 60 * 1000),
      }),
    ).toBe("pending");
    expect(
      deriveSnapshotStatus({
        ...base,
        snapshotCount: 2,
        latestTakenAt: new Date(now.getTime() - 60 * 60 * 1000),
      }),
    ).toBe("ok");
    expect(
      deriveSnapshotStatus({
        ...base,
        snapshotCount: 2,
        latestTakenAt: new Date(now.getTime() - 50 * 60 * 60 * 1000),
      }),
    ).toBe("stale");
    expect(
      deriveSnapshotStatus({
        ...base,
        unavailable: true,
        snapshotCount: 2,
        latestTakenAt: now,
      }),
    ).toBe("unavailable");
  });

  test("budget holder menghitung reservasi run in-flight", () => {
    const base = {
      spentMicro: 0n,
      maxProviderCostUsd: 5,
      dailyBudgetUsd: 50,
    };
    expect(isHolderBudgetExhausted({ ...base, inFlightRuns: 9 })).toBe(false);
    expect(isHolderBudgetExhausted({ ...base, inFlightRuns: 10 })).toBe(true);
    expect(
      isHolderBudgetExhausted({ ...base, spentMicro: 50_00000000n, inFlightRuns: 0 }),
    ).toBe(true);
  });

  test("recordSnapshot idempotent untuk wallet+block yang sama", async () => {
    const wallet = "0x00000000000000000000000000000000000000aa";
    await db.delete(holderSnapshots).where(eq(holderSnapshots.wallet, wallet));

    const first = await recordSnapshot(wallet, 60000n * 10n ** 18n, 123456n, "0xabc");
    const second = await recordSnapshot(wallet, 60000n * 10n ** 18n, 123456n, "0xabc");

    expect(second.id).toBe(first.id);
    expect(first.balanceTokens).toBe("60000.0000");

    const rows = await db
      .select()
      .from(holderSnapshots)
      .where(eq(holderSnapshots.wallet, wallet));
    expect(rows).toHaveLength(1);

    await db.delete(holderSnapshots).where(eq(holderSnapshots.wallet, wallet));
  });

  test("run holder RELEASED tidak memotong kuota harian", async () => {
    const wallet = "0x00000000000000000000000000000000000000bb";
    const projectId = newId("prj");
    const now = Date.now();

    await db.insert(projects).values({
      id: projectId,
      name: "holder-quota-test",
      ownerWallet: wallet,
    });
    await recordSnapshot(
      wallet,
      60000n * 10n ** 18n,
      5000n,
      "0xaaa",
      new Date(now - 48 * 3600_000),
    );
    await recordSnapshot(
      wallet,
      60000n * 10n ** 18n,
      5001n,
      "0xbbb",
      new Date(now - 24 * 3600_000),
    );
    await db.insert(runs).values({
      id: newId("run"),
      projectId,
      recipeId: "refine",
      status: "RELEASED",
      mode: "streaming",
      input: "gagal",
      isHolder: true,
      holderTier: "commander",
      idempotencyKey: newId("idem"),
    });

    const today = await getHolderTodayRuns(projectId, getStartOfTodayUtc());
    expect(today.usedTextCount).toBe(0);

    const check = await checkHolderEligibility(wallet, projectId, false);
    expect(check.eligible).toBe(true);
    expect(check.tierId).toBe("commander");

    await db.delete(runs).where(eq(runs.projectId, projectId));
    await db.delete(projects).where(eq(projects.id, projectId));
    await db.delete(holderSnapshots).where(eq(holderSnapshots.wallet, wallet));
  });

  test("batas hari kuota memakai createdAt, bukan finishedAt", async () => {
    const projectId = newId("prj");
    await db.insert(projects).values({
      id: projectId,
      name: "holder-day-boundary",
      ownerWallet: `0x${projectId.slice(-40).padStart(40, "0")}`.toLowerCase(),
    });

    const beforeMidnight = new Date("2026-01-01T23:59:00.000Z");
    const afterMidnight = new Date("2026-01-02T00:01:00.000Z");
    await db.insert(runs).values([
      {
        id: newId("run"),
        projectId,
        recipeId: "refine",
        status: "SETTLED",
        mode: "streaming",
        input: "sebelum tengah malam",
        isHolder: true,
        holderTier: "pilot",
        idempotencyKey: newId("idem"),
        createdAt: beforeMidnight,
        finishedAt: afterMidnight,
      },
      {
        id: newId("run"),
        projectId,
        recipeId: "refine",
        status: "SETTLED",
        mode: "streaming",
        input: "sesudah tengah malam",
        isHolder: true,
        holderTier: "pilot",
        idempotencyKey: newId("idem"),
        createdAt: afterMidnight,
        finishedAt: afterMidnight,
      },
    ]);

    const dayOne = await getHolderTodayRuns(
      projectId,
      new Date("2026-01-01T00:00:00.000Z"),
    );
    expect(dayOne.usedTextCount).toBe(1);
    expect(dayOne.runs[0].status).toBe("SETTLED");

    await db.delete(runs).where(eq(runs.projectId, projectId));
    await db.delete(projects).where(eq(projects.id, projectId));
  });

  test("reservasi budget menghitung run holder in-flight lintas project", async () => {
    const wallet = "0x00000000000000000000000000000000000000ee";
    const projectA = newId("prj");
    const projectB = newId("prj");
    const now = Date.now();

    await db.insert(projects).values([
      { id: projectA, name: "budget-holder", ownerWallet: wallet },
      {
        id: projectB,
        name: "budget-other-project",
        ownerWallet: "0x00000000000000000000000000000000000000ef",
      },
    ]);
    await recordSnapshot(
      wallet,
      60000n * 10n ** 18n,
      7000n,
      "0xaaa1",
      new Date(now - 48 * 3600_000),
    );
    await recordSnapshot(
      wallet,
      60000n * 10n ** 18n,
      7001n,
      "0xbbb1",
      new Date(now - 24 * 3600_000),
    );

    const { daily_budget_usd } = getParams().holder;
    const inFlightNeeded = Math.ceil(daily_budget_usd / env.maxProviderCostUsdPerRun);

    // Transaksi di-rollback agar run in-flight tidak bocor ke test lain.
    // Sengaja pakai try/catch, bukan `expect(...).rejects`: wrapper Bun untuk
    // promise Drizzle transaction tidak memulai callback sampai timeout.
    try {
      await db.transaction(async (tx) => {
        await tx.insert(runs).values(
          Array.from({ length: inFlightNeeded }, () => ({
            id: newId("run"),
            projectId: projectB,
            recipeId: "refine",
            status: "CREATED" as const,
            mode: "streaming",
            input: "in-flight",
            isHolder: true,
            holderTier: "commander",
            idempotencyKey: newId("idem"),
          })),
        );

        const check = await checkHolderEligibility(wallet, projectA, false, tx);
        expect(check.reason).toBe("HOLDER_BUDGET_EXHAUSTED");
        throw new Error("rollback-budget-test");
      });
      throw new Error("expected rollback");
    } catch (error) {
      expect((error as Error).message).toBe("rollback-budget-test");
    }

    await db.delete(runs).where(eq(runs.projectId, projectA));
    await db.delete(runs).where(eq(runs.projectId, projectB));
    await db.delete(projects).where(eq(projects.id, projectA));
    await db.delete(projects).where(eq(projects.id, projectB));
    await db.delete(holderSnapshots).where(eq(holderSnapshots.wallet, wallet));
  });

  test("recordHolderCost idempotent per run", async () => {
    const projectId = newId("prj");
    const runId = newId("run");
    const wallet = `0x${projectId.slice(-40).padStart(40, "0")}`.toLowerCase();

    await db.insert(projects).values({
      id: projectId,
      name: "holder-cost-idempotent",
      ownerWallet: wallet,
    });
    await db.insert(runs).values({
      id: runId,
      projectId,
      recipeId: "refine",
      status: "SETTLED",
      mode: "streaming",
      input: "cost",
      isHolder: true,
      holderTier: "pilot",
      idempotencyKey: newId("idem"),
    });

    await recordHolderCost(runId, projectId, wallet, "pilot", "0.12345678");
    await recordHolderCost(runId, projectId, wallet, "pilot", "0.12345678");

    const rows = await db
      .select()
      .from(holderCostLedger)
      .where(eq(holderCostLedger.runId, runId));
    expect(rows).toHaveLength(1);

    await db.delete(holderCostLedger).where(eq(holderCostLedger.runId, runId));
    await db.delete(runs).where(eq(runs.id, runId));
    await db.delete(projects).where(eq(projects.id, projectId));
  });

  test("kuota holder tidak bisa di-oversubscribe oleh request paralel", async () => {
    const wallet = "0x00000000000000000000000000000000000000cc";
    const projectId = newId("prj");
    const now = Date.now();

    await db.insert(projects).values({
      id: projectId,
      name: "holder-race",
      ownerWallet: wallet,
    });
    await recordSnapshot(
      wallet,
      60000n * 10n ** 18n,
      6000n,
      "0xccc",
      new Date(now - 48 * 3600_000),
    );
    await recordSnapshot(
      wallet,
      60000n * 10n ** 18n,
      6001n,
      "0xddd",
      new Date(now - 24 * 3600_000),
    );

    // Habiskan kuota trial (10 teks + 2 media) agar jalur holder yang dipakai.
    const trialRuns = [
      ...Array.from({ length: 10 }, () => ({
        id: newId("run"),
        projectId,
        recipeId: "refine",
        status: "SETTLED" as const,
        mode: "streaming",
        input: "trial teks",
        isTrial: true,
        idempotencyKey: newId("idem"),
      })),
      ...Array.from({ length: 2 }, () => ({
        id: newId("run"),
        projectId,
        recipeId: "visual",
        status: "SETTLED" as const,
        mode: "mixed",
        input: "trial media",
        isTrial: true,
        idempotencyKey: newId("idem"),
      })),
    ];
    await db.insert(runs).values(trialRuns);

    // Commander hanya punya 1 jatah media/hari. Lima request paralel harus
    // menghasilkan tepat satu run; sisanya ditolak karena kuota sudah terpakai.
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        createRun({
          projectId,
          recipeId: "visual",
          input: "holder race",
          openConversation: false,
        }),
      ),
    );

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(rejected).toHaveLength(4);
    for (const result of rejected) {
      expect(result.reason).toBeInstanceOf(ApiError);
      expect((result.reason as ApiError).code).toBe("HOLDER_QUOTA_EXHAUSTED");
    }

    await db.delete(runs).where(eq(runs.projectId, projectId));
    await db.delete(projects).where(eq(projects.id, projectId));
    await db.delete(holderSnapshots).where(eq(holderSnapshots.wallet, wallet));
  });
});
