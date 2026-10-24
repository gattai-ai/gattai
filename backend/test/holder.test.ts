import { describe, expect, test } from "bun:test";
import app from "../src/app";
import { getParams } from "../src/config";
import {
  calculateNextTierProgress,
  estimateNextSnapshotHours,
  evaluateTierFromSnapshots,
  getPublicHolderTiers,
  getStartOfTodayUtc,
  getStartOfTomorrowUtc,
} from "../src/holder/service";

describe("holder tiers service & algorithm", () => {
  const { tiers } = getParams().holder;

  test("0 snapshot: tidak ada active tier atau pending tier", () => {
    const res = evaluateTierFromSnapshots([], tiers, 2);
    expect(res.activeTier).toBeNull();
    expect(res.pendingTier).toBeNull();
    expect(res.effectiveTokens).toBe(0);
    expect(res.latestSnapshot).toBeNull();
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
});
