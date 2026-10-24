import { and, desc, eq, gte, sql } from "drizzle-orm";
import { formatUnits, parseAbiItem } from "viem";
import { MAINNET_CONTRACTS } from "@web3-starter/shared";
import { getParams, getRecipe, type HolderTierConfig } from "../config";
import { db } from "../db";
import {
  holderCostLedger,
  holderSnapshots,
  runs,
  runShares,
} from "../db/schema";
import { env } from "../env";
import { newId } from "../lib/id";
import { createRobinhoodClient } from "../onchain/client";

const ERC20_BALANCE_ABI = [
  parseAbiItem("function balanceOf(address account) view returns (uint256)"),
] as const;

export interface HolderTierInfo {
  id: string;
  name: string;
  min_tokens: string;
  free_runs_per_day: number;
  free_media_per_day: number;
  badge: "bronze" | "silver" | "gold";
  perks: string[];
}

export interface HolderSnapshotInfo {
  balance: string;
  balance_raw: string;
  block_number: number;
  taken_at: string;
  explorer_url: string;
}

export interface HolderQuotaInfo {
  limit: number;
  used: number;
  remaining: number;
  media_limit: number;
  media_used: number;
  media_remaining: number;
  resets_at: string;
}

export interface NextTierInfo {
  id: string;
  name: string;
  min_tokens: string;
  tokens_needed: string;
  progress_pct: number;
}

export interface PendingTierInfo {
  target_tier: string | null;
  message: string | null;
  next_snapshot_at: string | null;
}

export interface HolderTodayRunItem {
  id: string;
  recipe_id: string;
  formation_name: string;
  created_at: string;
  status: string;
  share_slug: string | null;
}

export interface HolderBudgetInfo {
  exhausted: boolean;
  daily_budget_usd: string;
  spent_today_usd: string;
  resets_at: string;
}

export interface HolderStatusResponse {
  tier: HolderTierInfo | null;
  snapshot: HolderSnapshotInfo | null;
  free_runs: HolderQuotaInfo;
  next_tier: NextTierInfo | null;
  pending: PendingTierInfo;
  today_runs: HolderTodayRunItem[];
  budget: HolderBudgetInfo;
  kill_switch: boolean;
}

export function getStartOfTodayUtc(referenceDate = new Date()): Date {
  return new Date(
    Date.UTC(
      referenceDate.getUTCFullYear(),
      referenceDate.getUTCMonth(),
      referenceDate.getUTCDate(),
      0,
      0,
      0,
      0,
    ),
  );
}

export function getStartOfTomorrowUtc(referenceDate = new Date()): Date {
  return new Date(
    Date.UTC(
      referenceDate.getUTCFullYear(),
      referenceDate.getUTCMonth(),
      referenceDate.getUTCDate() + 1,
      0,
      0,
      0,
      0,
    ),
  );
}

export function explorerBlockUrl(blockNumber: number | bigint): string {
  return `${MAINNET_CONTRACTS.explorer}/block/${blockNumber}`;
}

/**
 * Catat hasil snapshot saldo wallet ke database.
 */
export async function recordSnapshot(
  wallet: string,
  balanceRaw: bigint,
  blockNumber: bigint | number,
  blockHash?: string,
): Promise<{
  id: string;
  wallet: string;
  balanceRaw: string;
  balanceTokens: string;
  blockNumber: number;
  blockHash: string | null;
  takenAt: Date;
}> {
  const normWallet = wallet.toLowerCase();
  const rawStr = balanceRaw.toString();
  const tokensDecimal = Number(formatUnits(balanceRaw, 18));
  const tokensFormatted = tokensDecimal.toFixed(4);
  const blockNum = Number(blockNumber);
  const id = newId("snp");

  const [row] = await db
    .insert(holderSnapshots)
    .values({
      id,
      wallet: normWallet,
      balanceRaw: rawStr,
      balanceTokens: tokensFormatted,
      blockNumber: blockNum,
      blockHash: blockHash ?? null,
    })
    .returning();

  return row;
}

/**
 * Ambil saldo onchain terkini dari Robinhood Chain via RPC.
 * Mengembalikan null bila RPC tidak terkonfigurasi atau query gagal.
 */
export async function fetchOnchainTokenBalance(
  wallet: string,
): Promise<{ balanceRaw: bigint; blockNumber: bigint; blockHash: string } | null> {
  try {
    if (!env.robinhoodRpcUrl) return null;
    const client = createRobinhoodClient();
    const tokenAddress = (env.burnTokenAddress ?? MAINNET_CONTRACTS.token) as `0x${string}`;

    const [balanceRaw, block] = await Promise.all([
      client.readContract({
        address: tokenAddress,
        abi: ERC20_BALANCE_ABI,
        functionName: "balanceOf",
        args: [wallet.toLowerCase() as `0x${string}`],
      }),
      client.getBlock({ blockTag: "latest" }),
    ]);

    return {
      balanceRaw,
      blockNumber: block.number,
      blockHash: block.hash ?? "",
    };
  } catch {
    return null;
  }
}

/**
 * Hitung active tier & pending tier berdasarkan dua snapshot berturut-turut.
 */
export function evaluateTierFromSnapshots(
  snaps: Array<{ balanceTokens: string; balanceRaw: string; blockNumber: number; takenAt: Date }>,
  tiers: HolderTierConfig[],
  consecutiveRequired = 2,
): {
  activeTier: HolderTierConfig | null;
  pendingTier: HolderTierConfig | null;
  effectiveTokens: number;
  latestSnapshot: {
    balance: string;
    balance_raw: string;
    block_number: number;
    taken_at: string;
    explorer_url: string;
  } | null;
} {
  const sortedTiers = [...tiers].sort((a, b) => Number(a.min_tokens) - Number(b.min_tokens));

  if (snaps.length === 0) {
    return {
      activeTier: null,
      pendingTier: null,
      effectiveTokens: 0,
      latestSnapshot: null,
    };
  }

  const latest = snaps[0];
  const latestTokens = Number(latest.balanceTokens);
  const latestSnapshotInfo: HolderSnapshotInfo = {
    balance: latest.balanceTokens,
    balance_raw: latest.balanceRaw,
    block_number: latest.blockNumber,
    taken_at: latest.takenAt.toISOString(),
    explorer_url: explorerBlockUrl(latest.blockNumber),
  };

  // Helper mencari tier yang cocok untuk saldo tertentu
  function findTier(tokenAmount: number): HolderTierConfig | null {
    let match: HolderTierConfig | null = null;
    for (const t of sortedTiers) {
      if (tokenAmount >= Number(t.min_tokens)) {
        match = t;
      }
    }
    return match;
  }

  if (snaps.length < consecutiveRequired) {
    // Baru 1 snapshot: tier belum aktif, menunggu snapshot berikutnya
    const pending = findTier(latestTokens);
    return {
      activeTier: null,
      pendingTier: pending,
      effectiveTokens: 0,
      latestSnapshot: latestSnapshotInfo,
    };
  }

  // Ada minimal 2 snapshot: ambil min dari 2 snapshot terakhir
  const prev = snaps[1];
  const prevTokens = Number(prev.balanceTokens);
  const effectiveTokens = Math.min(latestTokens, prevTokens);

  const activeTier = findTier(effectiveTokens);
  const potentialTier = findTier(latestTokens);

  // Jika snapshot terakhir memenuhi tier yang lebih tinggi dari saldo efektif, status pending
  let pendingTier: HolderTierConfig | null = null;
  if (potentialTier && (!activeTier || Number(potentialTier.min_tokens) > Number(activeTier.min_tokens))) {
    pendingTier = potentialTier;
  }

  return {
    activeTier,
    pendingTier,
    effectiveTokens,
    latestSnapshot: latestSnapshotInfo,
  };
}

/**
 * Hitung estimasi jam tersisa ke jadwal snapshot berikutnya (default interval 24h).
 */
export function estimateNextSnapshotHours(lastSnapshotAt: Date, intervalHours = 24): number {
  const nextTarget = new Date(lastSnapshotAt.getTime() + intervalHours * 60 * 60 * 1000);
  const diffMs = nextTarget.getTime() - Date.now();
  if (diffMs <= 0) return 1;
  return Math.max(1, Math.round(diffMs / (60 * 60 * 1000)));
}

/**
 * Hitung kemajuan ke tier berikutnya (progress bar & tokens needed).
 */
export function calculateNextTierProgress(
  activeTier: HolderTierConfig | null,
  effectiveTokens: number,
  tiers: HolderTierConfig[],
): NextTierInfo | null {
  const sortedTiers = [...tiers].sort((a, b) => Number(a.min_tokens) - Number(b.min_tokens));

  if (!activeTier) {
    const firstTier = sortedTiers[0];
    if (!firstTier) return null;
    const minNeeded = Number(firstTier.min_tokens);
    const needed = Math.max(0, minNeeded - effectiveTokens);
    const pct = Math.min(100, Math.max(0, Math.floor((effectiveTokens / minNeeded) * 100)));
    return {
      id: firstTier.id,
      name: firstTier.name,
      min_tokens: firstTier.min_tokens,
      tokens_needed: needed.toFixed(4),
      progress_pct: pct,
    };
  }

  const currentIndex = sortedTiers.findIndex((t) => t.id === activeTier.id);
  if (currentIndex === -1 || currentIndex === sortedTiers.length - 1) {
    // Sudah tier tertinggi
    return null;
  }

  const nextTier = sortedTiers[currentIndex + 1];
  const currentMin = Number(activeTier.min_tokens);
  const nextMin = Number(nextTier.min_tokens);
  const range = nextMin - currentMin;
  const progressInTier = Math.max(0, effectiveTokens - currentMin);
  const pct = Math.min(100, Math.max(0, Math.floor((progressInTier / range) * 100)));
  const needed = Math.max(0, nextMin - effectiveTokens);

  return {
    id: nextTier.id,
    name: nextTier.name,
    min_tokens: nextTier.min_tokens,
    tokens_needed: needed.toFixed(4),
    progress_pct: pct,
  };
}

/**
 * Ambil daftar pemakaian run holder hari ini (UTC) untuk project tertentu.
 */
export async function getHolderTodayRuns(
  projectId: string,
  startOfTodayUtc: Date,
): Promise<{
  runs: HolderTodayRunItem[];
  usedTextCount: number;
  usedMediaCount: number;
}> {
  const rows = await db
    .select({
      id: runs.id,
      recipeId: runs.recipeId,
      mode: runs.mode,
      createdAt: runs.createdAt,
      status: runs.status,
      shareSlug: runShares.slug,
    })
    .from(runs)
    .leftJoin(runShares, eq(runs.id, runShares.runId))
    .where(
      and(
        eq(runs.projectId, projectId),
        eq(runs.isHolder, true),
        gte(runs.createdAt, startOfTodayUtc),
      ),
    )
    .orderBy(desc(runs.createdAt));

  let usedTextCount = 0;
  let usedMediaCount = 0;

  const items: HolderTodayRunItem[] = rows.map((r) => {
    if (r.mode === "streaming") {
      usedTextCount += 1;
    } else {
      usedMediaCount += 1;
    }
    const recipe = getRecipe(r.recipeId);
    return {
      id: r.id,
      recipe_id: r.recipeId,
      formation_name: recipe?.name ?? r.recipeId,
      created_at: r.createdAt.toISOString(),
      status: r.status,
      share_slug: r.shareSlug,
    };
  });

  return {
    runs: items,
    usedTextCount,
    usedMediaCount,
  };
}

/**
 * Hitung pengeluaran subsidi holder platform hari ini (USD) dari tabel `holder_cost_ledger`.
 */
export async function getPlatformHolderSpentToday(startOfTodayUtc: Date): Promise<number> {
  const [row] = await db
    .select({
      totalCost: sql<string>`coalesce(sum(${holderCostLedger.costUsd}), 0)::text`,
    })
    .from(holderCostLedger)
    .where(gte(holderCostLedger.createdAt, startOfTodayUtc));

  return parseFloat(row?.totalCost ?? "0");
}

/**
 * Status lengkap holder untuk endpoint `/v1/holder/status`.
 */
export async function getHolderStatus(
  wallet: string,
  projectId: string,
): Promise<HolderStatusResponse> {
  const normWallet = wallet.toLowerCase();
  const params = getParams();
  const holderConfig = params.holder;
  const startOfTodayUtc = getStartOfTodayUtc();
  const startOfTomorrowUtc = getStartOfTomorrowUtc();

  // 1. Ambil snapshot riwayat (2 terakhir)
  let snaps = await db
    .select({
      balanceTokens: holderSnapshots.balanceTokens,
      balanceRaw: holderSnapshots.balanceRaw,
      blockNumber: holderSnapshots.blockNumber,
      takenAt: holderSnapshots.takenAt,
    })
    .from(holderSnapshots)
    .where(eq(holderSnapshots.wallet, normWallet))
    .orderBy(desc(holderSnapshots.takenAt))
    .limit(holderConfig.consecutive_snapshots_required);

  // Jika belum ada snapshot sama sekali, coba ambil onchain snapshot pertama
  if (snaps.length === 0) {
    const onchain = await fetchOnchainTokenBalance(normWallet);
    if (onchain) {
      const recorded = await recordSnapshot(
        normWallet,
        onchain.balanceRaw,
        onchain.blockNumber,
        onchain.blockHash,
      );
      snaps = [
        {
          balanceTokens: recorded.balanceTokens,
          balanceRaw: recorded.balanceRaw,
          blockNumber: recorded.blockNumber,
          takenAt: recorded.takenAt,
        },
      ];
    }
  }

  // 2. Evaluasi active & pending tier
  const { activeTier, pendingTier, effectiveTokens, latestSnapshot } =
    evaluateTierFromSnapshots(snaps, holderConfig.tiers, holderConfig.consecutive_snapshots_required);

  // 3. Hitung progress ke tier berikutnya
  const nextTier = calculateNextTierProgress(activeTier, effectiveTokens, holderConfig.tiers);

  // 4. Pending message bila ada
  let pendingMessage: string | null = null;
  let nextSnapshotAt: string | null = null;
  if (pendingTier && snaps.length > 0) {
    const hours = estimateNextSnapshotHours(snaps[0].takenAt, holderConfig.snapshot_interval_hours);
    pendingMessage = `${pendingTier.name} unlocks after the next snapshot (~${hours}h)`;
    nextSnapshotAt = new Date(
      snaps[0].takenAt.getTime() + holderConfig.snapshot_interval_hours * 60 * 60 * 1000,
    ).toISOString();
  }

  // 5. Kuota dan pemakaian hari ini
  const { runs: todayRunItems, usedTextCount, usedMediaCount } = await getHolderTodayRuns(
    projectId,
    startOfTodayUtc,
  );

  const textLimit = activeTier?.free_runs_per_day ?? 0;
  const mediaLimit = activeTier?.free_media_per_day ?? 0;
  const textRemaining = Math.max(0, textLimit - usedTextCount);
  const mediaRemaining = Math.max(0, mediaLimit - usedMediaCount);

  // 6. Anggaran harian platform
  const spentToday = await getPlatformHolderSpentToday(startOfTodayUtc);
  const dailyBudget = holderConfig.daily_budget_usd;
  const isBudgetExhausted = spentToday >= dailyBudget;

  const killSwitch = !holderConfig.enabled;

  return {
    tier: activeTier
      ? {
          id: activeTier.id,
          name: activeTier.name,
          min_tokens: activeTier.min_tokens,
          free_runs_per_day: activeTier.free_runs_per_day,
          free_media_per_day: activeTier.free_media_per_day,
          badge: activeTier.badge,
          perks: activeTier.perks,
        }
      : null,
    snapshot: latestSnapshot,
    free_runs: {
      limit: textLimit,
      used: usedTextCount,
      remaining: textRemaining,
      media_limit: mediaLimit,
      media_used: usedMediaCount,
      media_remaining: mediaRemaining,
      resets_at: startOfTomorrowUtc.toISOString(),
    },
    next_tier: nextTier,
    pending: {
      target_tier: pendingTier ? pendingTier.name : null,
      message: pendingMessage,
      next_snapshot_at: nextSnapshotAt,
    },
    today_runs: todayRunItems,
    budget: {
      exhausted: isBudgetExhausted,
      daily_budget_usd: dailyBudget.toFixed(2),
      spent_today_usd: spentToday.toFixed(2),
      resets_at: startOfTomorrowUtc.toISOString(),
    },
    kill_switch: killSwitch,
  };
}

/**
 * Cek kelayakan pengguna untuk menjalankan satu run sebagai Holder Free Run.
 */
export async function checkHolderEligibility(
  wallet: string,
  projectId: string,
  isMedia: boolean,
): Promise<{ eligible: boolean; tierId: string | null; reason?: string }> {
  const normWallet = wallet.toLowerCase();
  const params = getParams();
  const holderConfig = params.holder;

  if (!holderConfig.enabled) {
    return { eligible: false, tierId: null, reason: "HOLDER_RUNS_PAUSED" };
  }

  const startOfTodayUtc = getStartOfTodayUtc();
  const spentToday = await getPlatformHolderSpentToday(startOfTodayUtc);
  if (spentToday >= holderConfig.daily_budget_usd) {
    return { eligible: false, tierId: null, reason: "HOLDER_BUDGET_EXHAUSTED" };
  }

  const snaps = await db
    .select({
      balanceTokens: holderSnapshots.balanceTokens,
      balanceRaw: holderSnapshots.balanceRaw,
      blockNumber: holderSnapshots.blockNumber,
      takenAt: holderSnapshots.takenAt,
    })
    .from(holderSnapshots)
    .where(eq(holderSnapshots.wallet, normWallet))
    .orderBy(desc(holderSnapshots.takenAt))
    .limit(holderConfig.consecutive_snapshots_required);

  const { activeTier } = evaluateTierFromSnapshots(
    snaps,
    holderConfig.tiers,
    holderConfig.consecutive_snapshots_required,
  );

  if (!activeTier) {
    return { eligible: false, tierId: null, reason: "NO_ACTIVE_TIER" };
  }

  const { usedTextCount, usedMediaCount } = await getHolderTodayRuns(projectId, startOfTodayUtc);

  if (isMedia) {
    if (usedMediaCount >= activeTier.free_media_per_day) {
      return { eligible: false, tierId: activeTier.id, reason: "HOLDER_MEDIA_QUOTA_EXHAUSTED" };
    }
  } else {
    if (usedTextCount >= activeTier.free_runs_per_day) {
      return { eligible: false, tierId: activeTier.id, reason: "HOLDER_TEXT_QUOTA_EXHAUSTED" };
    }
  }

  return { eligible: true, tierId: activeTier.id };
}

/**
 * Catat audit biaya riil provider untuk run holder ke tabel `holder_cost_ledger`.
 */
export async function recordHolderCost(
  runId: string,
  projectId: string,
  wallet: string,
  tier: string,
  costUsd: string,
): Promise<void> {
  await db.insert(holderCostLedger).values({
    id: newId("hcl"),
    runId,
    projectId,
    wallet: wallet.toLowerCase(),
    tier,
    costUsd,
  });
}

/**
 * Ambil daftar publik tier untuk endpoint `/v1/public/holder/tiers`.
 */
export function getPublicHolderTiers() {
  const params = getParams();
  return {
    tiers: params.holder.tiers.map((t) => ({
      id: t.id,
      name: t.name,
      min_tokens: t.min_tokens,
      free_runs_per_day: t.free_runs_per_day,
      free_media_per_day: t.free_media_per_day,
      badge: t.badge,
      perks: t.perks,
    })),
    rules: {
      snapshot_interval_hours: params.holder.snapshot_interval_hours,
      consecutive_snapshots_required: params.holder.consecutive_snapshots_required,
      reset_time_utc: "00:00",
      daily_budget_usd: params.holder.daily_budget_usd.toFixed(2),
      enabled: params.holder.enabled,
    },
  };
}
