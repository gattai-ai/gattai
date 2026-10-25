import { and, desc, eq, gte, sql } from "drizzle-orm";
import { formatUnits } from "viem";
import { MAINNET_CONTRACTS } from "@web3-starter/shared";
import { getConfig } from "../config";
import { db } from "../db";
import { deposits, holderCostLedger, holderFeeAllocations, runs, tokenBurns } from "../db/schema";
import { env } from "../env";
import { microToCreditsString, microToUsdString } from "../lib/money";
import { formatTokenAmount, getTokenBurnStats } from "../burn/token-burns";
import { getContractsStats, type ContractsStats } from "./contracts";

export interface FormationUsageStat {
  recipe: string;
  name?: string;
  count: number;
}

export interface DailyUsageStat {
  date: string;
  count: number;
}

export interface UsageStats {
  total_runs: number;
  runs_24h: number;
  runs_7d: number;
  by_formation: FormationUsageStat[];
  daily: DailyUsageStat[];
  updated_at: string;
}

export interface DailyRevenueStat {
  date: string;
  usd: string;
}

export interface RevenueStats {
  deposits_usdg: string;
  settled_credits: string;
  settled_usd: string;
  deposits_daily: DailyRevenueStat[];
  updated_at: string;
}

export interface DailyBurnStat {
  date: string;
  tokens: string;
}

export interface BurnsStatsSection {
  total_tokens_burned: string;
  total_tokens_burned_raw: string;
  team_tokens_burned: string;
  team_tokens_burned_raw: string;
  epoch_tokens_burned: string;
  epoch_tokens_burned_raw: string;
  community_tokens_burned: string;
  community_tokens_burned_raw: string;
  decimals: number;
  total_supply: string;
  daily: DailyBurnStat[];
  updated_at: string;
}

export interface HolderTierUsageStat {
  tier: string;
  name: string;
  count: number;
}

export interface DailyHolderStat {
  date: string;
  count: number;
  subsidized_usd: string;
}

export interface HolderStatsSection {
  total_runs: number;
  runs_24h: number;
  runs_7d: number;
  subsidized_cost_usd: string;
  allocated_pool_usd: string;
  by_tier: HolderTierUsageStat[];
  daily: DailyHolderStat[];
  updated_at: string;
}

export interface StatsResponse {
  usage: UsageStats;
  revenue: RevenueStats;
  burns: BurnsStatsSection;
  contracts: ContractsStats;
  holders: HolderStatsSection;
}

/** 30 hari UTC berturut-turut hingga hari ini `YYYY-MM-DD`. */
export function getLast30DaysUtc(now = new Date()): string[] {
  const dates: string[] = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

/** Format integer USDG base units (6 desimal) ke string desimal. */
export function formatUsdgAmount(raw: bigint): string {
  const whole = raw / 1_000_000n;
  const frac = (raw % 1_000_000n).toString().padStart(6, "0");
  return `${whole}.${frac}`;
}

/** Parse string numeric USD (skala 8) ke bigint skala-8. */
function parseUsd8(val: string | null | undefined): bigint {
  if (!val) return 0n;
  const text = String(val).trim();
  if (!text || text === "0") return 0n;
  const parts = text.split(".");
  const whole = BigInt(parts[0] || "0");
  const fracStr = (parts[1] || "").slice(0, 8).padEnd(8, "0");
  const frac = BigInt(fracStr);
  return whole * 100_000_000n + frac;
}

function formatUsd8String(usd8: bigint): string {
  const negative = usd8 < 0n;
  const abs = negative ? -usd8 : usd8;
  const whole = abs / 100_000_000n;
  const frac = (abs % 100_000_000n).toString().padStart(8, "0");
  return `${negative ? "-" : ""}${whole}.${frac}`;
}

/**
 * Statistik pemakaian produk dari ledger runs.
 * Hanya run yang statusnya SETTLED yang dihitung.
 */
export async function getUsageStats(now = new Date()): Promise<UsageStats> {
  const time24hAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const time7dAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const time30dAgo = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 29));

  const [totalRow, row24h, row7d, formationRows, dailyRows] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(runs)
      .where(eq(runs.status, "SETTLED")),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(runs)
      .where(and(eq(runs.status, "SETTLED"), gte(runs.finishedAt, time24hAgo))),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(runs)
      .where(and(eq(runs.status, "SETTLED"), gte(runs.finishedAt, time7dAgo))),
    db
      .select({
        recipe: runs.recipeId,
        count: sql<number>`count(*)::int`,
      })
      .from(runs)
      .where(eq(runs.status, "SETTLED"))
      .groupBy(runs.recipeId)
      .orderBy(desc(sql`count(*)`)),
    db
      .select({
        day: sql<string>`date(${runs.finishedAt} at time zone 'UTC')`.as("day"),
        count: sql<number>`count(*)::int`.as("count"),
      })
      .from(runs)
      .where(and(eq(runs.status, "SETTLED"), gte(runs.finishedAt, time30dAgo)))
      .groupBy(sql`date(${runs.finishedAt} at time zone 'UTC')`),
  ]);

  const recipeMap = new Map<string, string>();
  try {
    for (const r of getConfig().recipes) {
      recipeMap.set(r.id, r.name);
    }
  } catch {
    // Fallback jika config tidak dapat diakses
  }

  const byFormation: FormationUsageStat[] = formationRows.map((row) => ({
    recipe: row.recipe,
    name: recipeMap.get(row.recipe) ?? row.recipe,
    count: Number(row.count) || 0,
  }));

  const dailyCountMap = new Map<string, number>();
  for (const row of dailyRows) {
    if (row.day) dailyCountMap.set(row.day, Number(row.count) || 0);
  }

  const thirtyDays = getLast30DaysUtc(now);
  const daily: DailyUsageStat[] = thirtyDays.map((date) => ({
    date,
    count: dailyCountMap.get(date) ?? 0,
  }));

  return {
    total_runs: Number(totalRow[0]?.count) || 0,
    runs_24h: Number(row24h[0]?.count) || 0,
    runs_7d: Number(row7d[0]?.count) || 0,
    by_formation: byFormation,
    daily,
    updated_at: now.toISOString(),
  };
}

/**
 * Statistik revenue: deposit USDG onchain + charged revenue settled.
 */
export async function getRevenueStats(now = new Date()): Promise<RevenueStats> {
  const time30dAgo = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 29));

  const [chargedRow, depositRows, dailyDepositRows] = await Promise.all([
    db
      .select({
        totalCharged: sql<string>`coalesce(sum(${runs.chargedMicro}), 0)`,
      })
      .from(runs)
      .where(eq(runs.status, "SETTLED")),
    db
      .select({
        amountRaw: deposits.amountRaw,
      })
      .from(deposits)
      .where(and(eq(deposits.status, "confirmed"), eq(deposits.source, "USDG"))),
    db
      .select({
        day: sql<string>`date(${deposits.createdAt} at time zone 'UTC')`.as("day"),
        usdSum: sql<string>`coalesce(sum(${deposits.usdValue}), 0)`.as("usd_sum"),
      })
      .from(deposits)
      .where(and(eq(deposits.status, "confirmed"), gte(deposits.createdAt, time30dAgo)))
      .groupBy(sql`date(${deposits.createdAt} at time zone 'UTC')`),
  ]);

  let totalUsdgRaw = 0n;
  for (const row of depositRows) {
    try {
      totalUsdgRaw += BigInt(row.amountRaw);
    } catch {
      // Abaikan baris invalid
    }
  }

  const chargedMicroRaw = chargedRow[0]?.totalCharged ?? "0";
  let chargedMicro: bigint;
  try {
    chargedMicro = BigInt(chargedMicroRaw);
  } catch {
    // Fallback untuk driver yang mengembalikan "123.000000".
    chargedMicro = BigInt(Math.trunc(Number(chargedMicroRaw) || 0));
  }
  const settledCredits = microToCreditsString(chargedMicro);
  const settledUsd = microToUsdString(chargedMicro);

  const dailyUsdMap = new Map<string, bigint>();
  for (const row of dailyDepositRows) {
    if (row.day) dailyUsdMap.set(row.day, parseUsd8(row.usdSum));
  }

  const thirtyDays = getLast30DaysUtc(now);
  const depositsDaily: DailyRevenueStat[] = thirtyDays.map((date) => ({
    date,
    usd: formatUsd8String(dailyUsdMap.get(date) ?? 0n),
  }));

  return {
    deposits_usdg: formatUsdgAmount(totalUsdgRaw),
    settled_credits: settledCredits,
    settled_usd: settledUsd,
    deposits_daily: depositsDaily,
    updated_at: now.toISOString(),
  };
}

/**
 * Statistik burn token GATTAI.
 * Menggunakan sumber kebenaran yang sama dengan /v1/public/burns (`getTokenBurnStats`).
 */
export async function getBurnStatsForStats(now = new Date()): Promise<BurnsStatsSection> {
  const decimals = env.burnTokenDecimals ?? MAINNET_CONTRACTS.tokenDecimals;
  const totalSupplyRaw = env.burnTokenTotalSupply;

  const [stats, dailyRows] = await Promise.all([
    getTokenBurnStats(),
    db
      .select({
        day: sql<string>`date(coalesce(${tokenBurns.blockTimestamp}, ${tokenBurns.createdAt}) at time zone 'UTC')`.as("day"),
        totalRaw: sql<string>`coalesce(sum(${tokenBurns.amountRaw}), 0)`.as("total_raw"),
      })
      .from(tokenBurns)
      .groupBy(sql`date(coalesce(${tokenBurns.blockTimestamp}, ${tokenBurns.createdAt}) at time zone 'UTC')`)
      .orderBy(sql`date(coalesce(${tokenBurns.blockTimestamp}, ${tokenBurns.createdAt}) at time zone 'UTC')`),
  ]);

  const daily: DailyBurnStat[] = dailyRows
    .filter((row): row is { day: string; totalRaw: string } => Boolean(row.day))
    .map((row) => ({
      date: row.day,
      tokens: formatTokenAmount(BigInt(row.totalRaw || "0"), decimals),
    }));

  return {
    total_tokens_burned: formatTokenAmount(stats.totalRaw, decimals),
    total_tokens_burned_raw: stats.totalRaw.toString(),
    team_tokens_burned: formatTokenAmount(stats.teamRaw, decimals),
    team_tokens_burned_raw: stats.teamRaw.toString(),
    epoch_tokens_burned: formatTokenAmount(stats.epochRaw, decimals),
    epoch_tokens_burned_raw: stats.epochRaw.toString(),
    community_tokens_burned: formatTokenAmount(stats.communityRaw, decimals),
    community_tokens_burned_raw: stats.communityRaw.toString(),
    decimals,
    total_supply: formatUnits(totalSupplyRaw, decimals),
    daily,
    updated_at: now.toISOString(),
  };
}

/**
 * Statistik penggunaan kuota holder gratis dan subsidi biaya protokol.
 *
 * Jumlah run diambil dari run `SETTLED` bertanda `isHolder = true`. Biaya
 * subsidi 30 hari diambil dari `holder_cost_ledger.created_at`; run gagal
 * sebelum settlement tidak memiliki baris ledger dan tidak dihitung.
 */
export async function getHolderStats(now = new Date()): Promise<HolderStatsSection> {
  const time24hAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const time7dAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const time30dAgo = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 29));

  const [totalRow, row24h, row7d, tierRows, dailyRows, poolSumRow] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(runs)
      .where(and(eq(runs.isHolder, true), eq(runs.status, "SETTLED"))),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(runs)
      .where(
        and(
          eq(runs.isHolder, true),
          eq(runs.status, "SETTLED"),
          gte(runs.finishedAt, time24hAgo),
        ),
      ),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(runs)
      .where(
        and(
          eq(runs.isHolder, true),
          eq(runs.status, "SETTLED"),
          gte(runs.finishedAt, time7dAgo),
        ),
      ),
    db
      .select({
        tier: runs.holderTier,
        count: sql<number>`count(*)::int`,
      })
      .from(runs)
      .where(and(eq(runs.isHolder, true), eq(runs.status, "SETTLED")))
      .groupBy(runs.holderTier),
    // Cost ledger ditulis atomik saat settlement. Memakai `created_at` ledger
    // membuat total 30 hari dan grafik harian berasal dari sumber yang sama.
    // Run gagal sebelum settlement tidak punya baris ledger dan tidak dihitung.
    db
      .select({
        day: sql<string>`date(${holderCostLedger.createdAt} at time zone 'UTC')`.as("day"),
        count: sql<number>`count(*)::int`.as("count"),
        costSum: sql<string>`coalesce(sum(${holderCostLedger.costUsd}), 0)`.as("cost_sum"),
      })
      .from(holderCostLedger)
      .where(gte(holderCostLedger.createdAt, time30dAgo))
      .groupBy(sql`date(${holderCostLedger.createdAt} at time zone 'UTC')`),
    db
      .select({
        totalPool: sql<string>`coalesce(sum(${holderFeeAllocations.amountUsd}), 0)`.as("total_pool"),
      })
      .from(holderFeeAllocations),
  ]);

  const tierConfigList = getConfig().params.holder.tiers ?? [];
  const tierCountMap = new Map<string, number>();
  for (const row of tierRows) {
    if (row.tier) tierCountMap.set(row.tier, Number(row.count) || 0);
  }

  const byTier: HolderTierUsageStat[] = tierConfigList.map((tierConfig) => ({
    tier: tierConfig.id,
    name: tierConfig.name,
    count: tierCountMap.get(tierConfig.id) ?? 0,
  }));

  for (const row of tierRows) {
    if (row.tier && !tierConfigList.some((t) => t.id === row.tier)) {
      byTier.push({
        tier: row.tier,
        name: row.tier,
        count: Number(row.count) || 0,
      });
    }
  }

  const dailyCountMap = new Map<string, number>();
  const dailyCostMap = new Map<string, bigint>();
  for (const row of dailyRows) {
    if (row.day) {
      dailyCountMap.set(row.day, Number(row.count) || 0);
      dailyCostMap.set(row.day, parseUsd8(row.costSum));
    }
  }

  const thirtyDays = getLast30DaysUtc(now);
  const daily: DailyHolderStat[] = thirtyDays.map((date) => ({
    date,
    count: dailyCountMap.get(date) ?? 0,
    subsidized_usd: formatUsd8String(dailyCostMap.get(date) ?? 0n),
  }));

  // Total sengaja dihitung dari peta harian, bukan query terpisah, supaya
  // `subsidized_cost_usd` selalu sama dengan jumlah `daily[].subsidized_usd`.
  let totalCostUsd8 = 0n;
  for (const cost of dailyCostMap.values()) totalCostUsd8 += cost;
  const totalPoolUsd8 = parseUsd8(poolSumRow[0]?.totalPool);

  return {
    total_runs: Number(totalRow[0]?.count) || 0,
    runs_24h: Number(row24h[0]?.count) || 0,
    runs_7d: Number(row7d[0]?.count) || 0,
    subsidized_cost_usd: formatUsd8String(totalCostUsd8),
    allocated_pool_usd: formatUsd8String(totalPoolUsd8),
    by_tier: byTier,
    daily,
    updated_at: now.toISOString(),
  };
}

/**
 * Agregasi lengkap untuk GET /v1/public/stats.
 */
export async function getStats(): Promise<StatsResponse> {
  const [usage, revenue, burns, contracts, holders] = await Promise.all([
    getUsageStats(),
    getRevenueStats(),
    getBurnStatsForStats(),
    getContractsStats(),
    getHolderStats(),
  ]);

  return {
    usage,
    revenue,
    burns,
    contracts,
    holders,
  };
}
