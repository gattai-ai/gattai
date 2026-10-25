import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { formatUnits, parseAbiItem, parseUnits } from "viem";
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
import { microToUsdString, usdStringToMicroUsd, usdToMicroUsd } from "../lib/money";
import { withTimeout } from "../lib/timeout";
import { createRobinhoodClient } from "../onchain/client";
import type { Tx } from "../billing/ledger";
import { getHolderTierMinGapHours } from "./config";

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

export type HolderSnapshotStatus = "ok" | "pending" | "stale" | "unavailable";

export interface HolderStatusResponse {
  tier: HolderTierInfo | null;
  snapshot: HolderSnapshotInfo | null;
  /** Kesehatan data snapshot; mencegah UI menyimpulkan "bukan holder" saat RPC/worker bermasalah. */
  snapshot_status: HolderSnapshotStatus;
  snapshot_stale: boolean;
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
 * Status kesehatan snapshot untuk UI. Dipisah sebagai fungsi murni agar
 * perilaku stale/pending/unavailable bisa diuji tanpa RPC atau waktu nyata.
 */
export function deriveSnapshotStatus(input: {
  snapshotCount: number;
  latestTakenAt: Date | null;
  unavailable: boolean;
  consecutiveRequired: number;
  intervalHours: number;
  now?: Date;
}): HolderSnapshotStatus {
  if (input.unavailable || input.snapshotCount === 0 || !input.latestTakenAt) {
    return "unavailable";
  }
  const ageMs = (input.now ?? new Date()).getTime() - input.latestTakenAt.getTime();
  const staleAfterMs = input.intervalHours * 2 * 60 * 60 * 1000;
  if (ageMs > staleAfterMs) return "stale";
  if (input.snapshotCount < input.consecutiveRequired) return "pending";
  return "ok";
}

/**
 * Cek budget holder dengan reservasi konservatif untuk run in-flight.
 * Cost ledger baru terisi saat settle, jadi run yang sedang berjalan dihitung
 * sebesar plafon biaya provider per run.
 */
export function isHolderBudgetExhausted(input: {
  spentMicro: bigint;
  inFlightRuns: number;
  maxProviderCostUsd: number;
  dailyBudgetUsd: number;
}): boolean {
  const inFlight = BigInt(Math.max(0, Math.trunc(input.inFlightRuns)));
  const reservedMicro = inFlight * usdToMicroUsd(input.maxProviderCostUsd);
  return input.spentMicro + reservedMicro >= usdToMicroUsd(input.dailyBudgetUsd);
}

/**
 * Format base-unit token ke string desimal dengan skala tetap, tanpa float.
 * Nilai dipotong (bukan dibulatkan) agar ambang tier tidak pernah naik
 * akibat pembulatan ke atas.
 */
export function formatUnitsToScale(raw: bigint, decimals: number, scale: number): string {
  const full = formatUnits(raw, decimals);
  const [whole, fraction = ""] = full.split(".");
  return `${whole}.${(fraction + "0".repeat(scale)).slice(0, scale)}`;
}

/** Ubah jumlah token desimal (mis. "10000") menjadi base unit bigint. */
function tokensToRaw(amount: string, decimals = 18): bigint | null {
  try {
    return parseUnits(amount, decimals);
  } catch {
    return null;
  }
}

/** Ambil saldo base-unit dari snapshot, dengan fallback ke balanceTokens. */
function parseSnapshotRaw(snap: { balanceRaw: string; balanceTokens: string }): bigint {
  try {
    return BigInt(snap.balanceRaw);
  } catch {
    return tokensToRaw(snap.balanceTokens) ?? 0n;
  }
}

/**
 * Catat hasil snapshot saldo wallet ke database.
 *
 * Idempotent per `(wallet, block_number)`: pemanggilan berulang pada block yang
 * sama tidak membuat baris baru.
 */
export async function recordSnapshot(
  wallet: string,
  balanceRaw: bigint,
  blockNumber: bigint | number,
  blockHash?: string,
  takenAt?: Date,
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
  const tokensFormatted = formatUnitsToScale(balanceRaw, 18, 4);
  const blockNum = Number(blockNumber);
  const id = newId("snp");

  const inserted = await db
    .insert(holderSnapshots)
    .values({
      id,
      wallet: normWallet,
      balanceRaw: rawStr,
      balanceTokens: tokensFormatted,
      blockNumber: blockNum,
      blockHash: blockHash ?? null,
      takenAt: takenAt ?? new Date(),
    })
    .onConflictDoNothing({
      target: [holderSnapshots.wallet, holderSnapshots.blockNumber],
    })
    .returning();

  if (inserted[0]) return inserted[0];

  // Baris sudah ada (retry/dua request paralel): kembalikan yang menang.
  const [existing] = await db
    .select()
    .from(holderSnapshots)
    .where(
      and(
        eq(holderSnapshots.wallet, normWallet),
        eq(holderSnapshots.blockNumber, blockNum),
      ),
    )
    .limit(1);

  if (!existing) {
    throw new Error(`Snapshot ${normWallet}#${blockNum} gagal disimpan`);
  }
  return existing;
}

export interface HolderConfirmedBlock {
  number: bigint;
  hash: string;
  timestamp: bigint;
}

/**
 * Hitung block yang sudah cukup dalam dari head.
 *
 * Nilai `latest - confirmations` dipakai agar snapshot tidak berubah karena
 * reorg pendek. Bila chain belum cukup tinggi, pakai genesis (0).
 */
export function confirmedBlockNumber(latest: bigint, confirmations: number): bigint {
  const safeConfirmations = Number.isFinite(confirmations)
    ? Math.max(0, Math.trunc(confirmations))
    : 0;
  const depth = BigInt(safeConfirmations);
  return latest > depth ? latest - depth : 0n;
}

/**
 * Ambil satu block terkonfirmasi untuk dipakai bersama oleh semua wallet dalam
 * satu siklus. Mengembalikan null bila RPC tidak tersedia/gagal.
 */
export async function fetchHolderConfirmedBlock(): Promise<HolderConfirmedBlock | null> {
  try {
    if (!env.robinhoodRpcUrl) return null;
    const client = createRobinhoodClient();
    const latest = await withTimeout(
      client.getBlock({ blockTag: "latest" }),
      env.holderRpcTimeoutMs,
      "holder getBlock latest",
    );
    const target = confirmedBlockNumber(latest.number, env.holderSnapshotConfirmations);
    const block =
      target === latest.number
        ? latest
        : await withTimeout(
            client.getBlock({ blockNumber: target }),
            env.holderRpcTimeoutMs,
            "holder getBlock confirmed",
          );

    if (!block.hash) return null;
    return {
      number: block.number,
      hash: block.hash,
      timestamp: block.timestamp,
    };
  } catch {
    return null;
  }
}

/**
 * Ambil saldo onchain dari Robinhood Chain via RPC.
 *
 * Pembacaan dipin ke block terkonfirmasi yang sama dengan metadata snapshot.
 * `confirmedBlock` boleh dioper dari worker agar satu siklus cukup mengambil
 * satu block; `null` berarti block gagal diambil dan wallet dilewati.
 * Mengembalikan null bila RPC tidak terkonfigurasi atau query gagal.
 */
export async function fetchOnchainTokenBalance(
  wallet: string,
  confirmedBlock?: HolderConfirmedBlock | null,
): Promise<{
  balanceRaw: bigint;
  blockNumber: bigint;
  blockHash: string;
  blockTimestamp: bigint;
} | null> {
  try {
    if (!env.robinhoodRpcUrl) return null;
    const block =
      confirmedBlock === undefined ? await fetchHolderConfirmedBlock() : confirmedBlock;
    if (!block) return null;

    const client = createRobinhoodClient();
    const tokenAddress = env.holderTokenAddress as `0x${string}`;
    const balanceRaw = await withTimeout(
      client.readContract({
        address: tokenAddress,
        abi: ERC20_BALANCE_ABI,
        functionName: "balanceOf",
        args: [wallet.toLowerCase() as `0x${string}`],
        blockNumber: block.number,
      }),
      env.holderRpcTimeoutMs,
      "holder balanceOf",
    );

    return {
      balanceRaw,
      blockNumber: block.number,
      blockHash: block.hash,
      blockTimestamp: block.timestamp,
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
  minGapHours = 12,
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
  // Urutkan berdasarkan ambang dalam base unit, bukan float.
  const sortedTiers = [...tiers].sort((a, b) => {
    const aRaw = tokensToRaw(a.min_tokens) ?? 0n;
    const bRaw = tokensToRaw(b.min_tokens) ?? 0n;
    return aRaw < bRaw ? -1 : aRaw > bRaw ? 1 : 0;
  });

  if (snaps.length === 0) {
    return {
      activeTier: null,
      pendingTier: null,
      effectiveTokens: 0,
      latestSnapshot: null,
    };
  }

  const latest = snaps[0];
  const latestRaw = parseSnapshotRaw(latest);
  const latestSnapshotInfo: HolderSnapshotInfo = {
    balance: latest.balanceTokens,
    balance_raw: latest.balanceRaw,
    block_number: latest.blockNumber,
    taken_at: latest.takenAt.toISOString(),
    explorer_url: explorerBlockUrl(latest.blockNumber),
  };

  // Helper mencari tier yang cocok untuk saldo base-unit tertentu.
  function findTier(rawAmount: bigint): HolderTierConfig | null {
    let match: HolderTierConfig | null = null;
    for (const t of sortedTiers) {
      const min = tokensToRaw(t.min_tokens);
      if (min !== null && rawAmount >= min) {
        match = t;
      }
    }
    return match;
  }

  const prev = snaps[1];
  const gapMs = prev ? latest.takenAt.getTime() - prev.takenAt.getTime() : 0;
  const minGapMs = minGapHours * 60 * 60 * 1000;

  // Butuh jumlah snapshot yang cukup DAN jarak waktu minimum. Jarak ini
  // mencegah dua snapshot pada block/beberapa detik berurutan dipakai untuk
  // melewati aturan anti-flash-loan.
  if (snaps.length < consecutiveRequired || gapMs < minGapMs) {
    return {
      activeTier: null,
      pendingTier: findTier(latestRaw),
      effectiveTokens: 0,
      latestSnapshot: latestSnapshotInfo,
    };
  }

  // Ada minimal 2 snapshot berjarak cukup: ambil min dari keduanya.
  const prevRaw = parseSnapshotRaw(prev);
  const effectiveRaw = latestRaw < prevRaw ? latestRaw : prevRaw;
  // Nilai ini hanya untuk progress bar/presentasi, bukan keputusan tier.
  const effectiveTokens = Number(formatUnits(effectiveRaw, 18));

  const activeTier = findTier(effectiveRaw);
  const potentialTier = findTier(latestRaw);

  // Jika snapshot terakhir memenuhi tier yang lebih tinggi dari saldo efektif, status pending
  let pendingTier: HolderTierConfig | null = null;
  if (potentialTier) {
    const potentialMin = tokensToRaw(potentialTier.min_tokens) ?? 0n;
    const activeMin = activeTier ? (tokensToRaw(activeTier.min_tokens) ?? 0n) : 0n;
    if (!activeTier || potentialMin > activeMin) {
      pendingTier = potentialTier;
    }
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
 *
 * Kuota memakai `createdAt` (saat konsumsi dimulai), bukan `finishedAt`, agar
 * run yang melewati tengah malam tetap dihitung ke hari saat ia dimulai.
 * Hanya status yang benar-benar memakai sumber daya yang dihitung: run gagal
 * (`RELEASED`/`INSUFFICIENT_BALANCE`) tidak menghanguskan kuota.
 */
export async function getHolderTodayRuns(
  projectId: string,
  startOfTodayUtc: Date,
  tx?: Tx,
): Promise<{
  runs: HolderTodayRunItem[];
  usedTextCount: number;
  usedMediaCount: number;
}> {
  const conn = tx ?? db;
  const endOfTodayUtc = new Date(startOfTodayUtc.getTime() + 24 * 60 * 60 * 1000);
  const rows = await conn
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
        lt(runs.createdAt, endOfTodayUtc),
      ),
    )
    .orderBy(desc(runs.createdAt));

  let usedTextCount = 0;
  let usedMediaCount = 0;

  const items: HolderTodayRunItem[] = rows.map((r) => {
    // Status in-flight ikut dihitung agar kuota tidak bisa di-oversubscribe,
    // sedangkan run yang gagal/dibatalkan tidak memotong kuota.
    const consumesQuota = r.status !== "RELEASED" && r.status !== "INSUFFICIENT_BALANCE";
    if (consumesQuota) {
      if (r.mode === "streaming") {
        usedTextCount += 1;
      } else {
        usedMediaCount += 1;
      }
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
 * Hitung pengeluaran subsidi holder platform hari ini (micro-USD) dari tabel
 * `holder_cost_ledger`. Aritmetika bigint menghindari pembulatan float saat
 * membandingkan dengan plafon anggaran.
 */
export async function getPlatformHolderSpentToday(
  startOfTodayUtc: Date,
  tx?: Tx,
): Promise<bigint> {
  const conn = tx ?? db;
  const [row] = await conn
    .select({
      totalCost: sql<string>`coalesce(sum(${holderCostLedger.costUsd}), 0)::text`,
    })
    .from(holderCostLedger)
    .where(gte(holderCostLedger.createdAt, startOfTodayUtc));

  return usdStringToMicroUsd(row?.totalCost ?? "0");
}

/**
 * Jumlah run holder yang masih berjalan dan belum masuk cost ledger.
 *
 * Tidak dibatasi tanggal: run yang mulai kemarin tetapi settle hari ini tetap
 * memakai budget hari ini. Reaper akan melepas run yatim, jadi reservasi tidak
 * menggantung permanen.
 */
export async function countInFlightHolderRuns(tx?: Tx): Promise<number> {
  const conn = tx ?? db;
  const [row] = await conn
    .select({ count: sql<number>`count(*)::int` })
    .from(runs)
    .where(
      and(
        eq(runs.isHolder, true),
        inArray(runs.status, ["CREATED", "RESERVED", "RUNNING", "AWAITING_CONFIRMATION"]),
      ),
    );
  return row?.count ?? 0;
}

/**
 * Ringkasan tier read-only untuk endpoint lain (mis. leaderboard).
 *
 * Tidak mengambil snapshot baru dan tidak memanggil RPC: GET harus tetap
 * cepat dan bebas side-effect. Pengambilan snapshot adalah tugas worker dan
 * endpoint `/v1/holder/status`.
 */
export async function getHolderTierSummary(
  wallet: string,
): Promise<{ tier: HolderTierConfig | null }> {
  const normWallet = wallet.toLowerCase();
  const holderConfig = getParams().holder;
  const snaps = await db
    .select({
      balanceTokens: holderSnapshots.balanceTokens,
      balanceRaw: holderSnapshots.balanceRaw,
      blockNumber: holderSnapshots.blockNumber,
      takenAt: holderSnapshots.takenAt,
    })
    .from(holderSnapshots)
    .where(eq(holderSnapshots.wallet, normWallet))
    .orderBy(desc(holderSnapshots.takenAt), desc(holderSnapshots.blockNumber))
    .limit(holderConfig.consecutive_snapshots_required);

  const { activeTier } = evaluateTierFromSnapshots(
    snaps,
    holderConfig.tiers,
    holderConfig.consecutive_snapshots_required,
    getHolderTierMinGapHours(),
  );

  return { tier: activeTier };
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
  let snapshotUnavailable = false;
  let snaps = await db
    .select({
      balanceTokens: holderSnapshots.balanceTokens,
      balanceRaw: holderSnapshots.balanceRaw,
      blockNumber: holderSnapshots.blockNumber,
      takenAt: holderSnapshots.takenAt,
    })
    .from(holderSnapshots)
    .where(eq(holderSnapshots.wallet, normWallet))
    .orderBy(desc(holderSnapshots.takenAt), desc(holderSnapshots.blockNumber))
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
        new Date(Number(onchain.blockTimestamp) * 1000),
      );
      snaps = [
        {
          balanceTokens: recorded.balanceTokens,
          balanceRaw: recorded.balanceRaw,
          blockNumber: recorded.blockNumber,
          takenAt: recorded.takenAt,
        },
      ];
    } else {
      // RPC tidak terkonfigurasi, timeout, atau gagal. Jangan tampilkan state
      // "bukan holder" yang menyesatkan; tandai data snapshot tidak tersedia.
      snapshotUnavailable = true;
    }
  }

  // 2. Evaluasi active & pending tier
  const { activeTier, pendingTier, effectiveTokens, latestSnapshot } =
    evaluateTierFromSnapshots(
      snaps,
      holderConfig.tiers,
      holderConfig.consecutive_snapshots_required,
      getHolderTierMinGapHours(),
    );

  // Status kesehatan snapshot: data lama/worker mati tidak boleh terlihat
  // seperti "belum pernah scan". Ambang stale = 2x interval snapshot.
  const snapshotStatus = deriveSnapshotStatus({
    snapshotCount: snaps.length,
    latestTakenAt: snaps[0]?.takenAt ?? null,
    unavailable: snapshotUnavailable,
    consecutiveRequired: holderConfig.consecutive_snapshots_required,
    intervalHours: holderConfig.snapshot_interval_hours,
  });

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

  // 6. Anggaran harian platform (dibandingkan dalam micro-USD, bukan float).
  // Reservasi run in-flight ikut dihitung agar banner UI konsisten dengan
  // keputusan createRun.
  const spentToday = await getPlatformHolderSpentToday(startOfTodayUtc);
  const dailyBudgetMicro = usdToMicroUsd(holderConfig.daily_budget_usd);
  const inFlightCount = await countInFlightHolderRuns();
  const isBudgetExhausted = isHolderBudgetExhausted({
    spentMicro: spentToday,
    inFlightRuns: inFlightCount,
    maxProviderCostUsd: env.maxProviderCostUsdPerRun,
    dailyBudgetUsd: holderConfig.daily_budget_usd,
  });

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
    snapshot_status: snapshotStatus,
    snapshot_stale: snapshotStatus === "stale",
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
      daily_budget_usd: microToUsdString(dailyBudgetMicro),
      spent_today_usd: microToUsdString(spentToday),
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
  tx?: Tx,
): Promise<{ eligible: boolean; tierId: string | null; reason?: string }> {
  const normWallet = wallet.toLowerCase();
  const params = getParams();
  const holderConfig = params.holder;

  if (!holderConfig.enabled) {
    return { eligible: false, tierId: null, reason: "HOLDER_RUNS_PAUSED" };
  }

  const conn = tx ?? db;
  const startOfTodayUtc = getStartOfTodayUtc();

  // Serialisasi pemeriksaan budget lintas project. Tanpa lock ini, dua project
  // bisa sama-sama melihat sisa budget dan lolos bersamaan. Lock hanya
  // diambil bila pemanggil menyediakan transaksi; createRun selalu begitu.
  if (tx) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('holder-budget'))`);
  }

  // Reservasi konservatif untuk run holder yang masih in-flight. Cost ledger
  // baru terisi saat settle, jadi tanpa ini budget bisa overshoot oleh run
  // yang sedang berjalan. `maxProviderCostUsdPerRun` adalah plafon per run.
  const spentToday = await getPlatformHolderSpentToday(startOfTodayUtc, tx);
  const inFlightCount = await countInFlightHolderRuns(tx);
  if (
    isHolderBudgetExhausted({
      spentMicro: spentToday,
      inFlightRuns: inFlightCount,
      maxProviderCostUsd: env.maxProviderCostUsdPerRun,
      dailyBudgetUsd: holderConfig.daily_budget_usd,
    })
  ) {
    return { eligible: false, tierId: null, reason: "HOLDER_BUDGET_EXHAUSTED" };
  }

  const snaps = await conn
    .select({
      balanceTokens: holderSnapshots.balanceTokens,
      balanceRaw: holderSnapshots.balanceRaw,
      blockNumber: holderSnapshots.blockNumber,
      takenAt: holderSnapshots.takenAt,
    })
    .from(holderSnapshots)
    .where(eq(holderSnapshots.wallet, normWallet))
    .orderBy(desc(holderSnapshots.takenAt), desc(holderSnapshots.blockNumber))
    .limit(holderConfig.consecutive_snapshots_required);

  const { activeTier } = evaluateTierFromSnapshots(
    snaps,
    holderConfig.tiers,
    holderConfig.consecutive_snapshots_required,
    getHolderTierMinGapHours(),
  );

  if (!activeTier) {
    return { eligible: false, tierId: null, reason: "NO_ACTIVE_TIER" };
  }

  const { usedTextCount, usedMediaCount } = await getHolderTodayRuns(
    projectId,
    startOfTodayUtc,
    tx,
  );

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
  await db
    .insert(holderCostLedger)
    .values({
      id: newId("hcl"),
      runId,
      projectId,
      wallet: wallet.toLowerCase(),
      tier,
      costUsd,
    })
    .onConflictDoNothing({ target: holderCostLedger.runId });
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
