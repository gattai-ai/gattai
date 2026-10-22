import { and, eq, gte, inArray, isNotNull, lt } from "drizzle-orm";
import { db } from "../db";
import { creditLots, ledgerEntries, runs } from "../db/schema";
import { NATIVE_TOKEN } from "../onchain/types";
import { PriceUnavailableError, priceForToken } from "../onchain/prices";
import { decimalToUsd8, shareUsd8, usd8ToTokens18 } from "./money";
import type { BurnBreakdown, BurnConfig, BurnWindow, LotMargin, RunMargin } from "./types";

/** Sumber lot yang benar-benar mendanai burn (PROMO tidak menghasilkan margin nyata). */
type FundingSource = "ETH" | "USDG" | "GATTAI" | "PROMO";

export interface MarginRunInput {
  runId: string;
  chargedMicro: number;
  /** Nilai kolom `numeric` Postgres (USD, 8 desimal). */
  providerCostUsd: string;
}

export interface MarginSettlementInput {
  runId: string;
  lotId: string;
  source: FundingSource;
  /** Credits yang dikonsumsi dari lot (positif, micro-credits). */
  consumedMicro: number;
}

export interface PlanInput {
  runs: MarginRunInput[];
  settlements: MarginSettlementInput[];
  shareStable: number;
  shareToken: number;
  /** Harga GATTAI (USD/token, skala 8), atau null bila tidak tersedia. */
  gattaiPrice8: bigint | null;
}

/**
 * Hitung breakdown burn dari margin tiap run. Fungsi murni (tanpa I/O) agar
 * mudah diuji.
 *
 * `margin = max(0, charged − provider_cost)` per run; margin diatribusikan ke
 * tiap lot sebanding `consumed / charged`. Lot ETH/USDG masuk kantong stable
 * (buyback), lot GATTAI masuk kantong token (burn langsung).
 */
export function planFromMarginRows(input: PlanInput): BurnBreakdown {
  const settlementsByRun = new Map<string, MarginSettlementInput[]>();
  for (const settlement of input.settlements) {
    const list = settlementsByRun.get(settlement.runId);
    if (list) list.push(settlement);
    else settlementsByRun.set(settlement.runId, [settlement]);
  }

  const runMargins: RunMargin[] = [];
  let stableMarginUsd8 = 0n;
  let tokenMarginUsd8 = 0n;

  for (const run of input.runs) {
    const charged = BigInt(Math.max(0, run.chargedMicro));
    const providerCostUsd8 = decimalToUsd8(run.providerCostUsd);
    const marginUsd8 = charged > providerCostUsd8 ? charged - providerCostUsd8 : 0n;

    const runSettlements = settlementsByRun.get(run.runId) ?? [];
    const totalConsumed = runSettlements.reduce(
      (sum, item) => sum + BigInt(Math.max(0, item.consumedMicro)),
      0n,
    );
    const denom = charged > 0n ? charged : totalConsumed;

    const lots: LotMargin[] = [];
    for (const settlement of runSettlements) {
      const consumed = Math.max(0, settlement.consumedMicro);
      const attributed =
        denom > 0n ? (marginUsd8 * BigInt(consumed)) / denom : 0n;

      lots.push({
        lotId: settlement.lotId,
        source: settlement.source,
        consumedMicro: consumed,
        marginUsd8: attributed,
      });

      if (settlement.source === "ETH" || settlement.source === "USDG") {
        stableMarginUsd8 += attributed;
      } else if (settlement.source === "GATTAI") {
        tokenMarginUsd8 += attributed;
      }
    }

    runMargins.push({
      runId: run.runId,
      chargedMicro: run.chargedMicro,
      providerCostUsd8,
      marginUsd8,
      lots,
    });
  }

  const stableBudgetUsd8 = shareUsd8(stableMarginUsd8, input.shareStable);
  const tokenBudgetUsd8 = shareUsd8(tokenMarginUsd8, input.shareToken);
  const price = input.gattaiPrice8;

  return {
    stableMarginUsd8,
    tokenMarginUsd8,
    stableBudgetUsd8,
    tokenBudgetUsd8,
    totalBudgetUsd8: stableBudgetUsd8 + tokenBudgetUsd8,
    gattaiPrice8: price,
    buybackTokens18: price ? usd8ToTokens18(stableBudgetUsd8, price) : 0n,
    directBurnTokens18: price ? usd8ToTokens18(tokenBudgetUsd8, price) : 0n,
    runs: runMargins,
  };
}

export function emptyBreakdown(gattaiPrice8: bigint | null = null): BurnBreakdown {
  return {
    stableMarginUsd8: 0n,
    tokenMarginUsd8: 0n,
    stableBudgetUsd8: 0n,
    tokenBudgetUsd8: 0n,
    totalBudgetUsd8: 0n,
    gattaiPrice8,
    buybackTokens18: 0n,
    directBurnTokens18: 0n,
    runs: [],
  };
}

export interface EpochPlan {
  breakdown: BurnBreakdown;
  /** Jumlah run settled/released yang masuk epoch. */
  runsCount: number;
  priceSource: string | null;
  priceError: string | null;
}

/**
 * Hitung breakdown satu epoch dari database: baca run settled dalam jendela,
 * tarik konsumsi lot per run (entri ledger SETTLE), lalu valuasi.
 * Harga GATTAI mengikuti kebijakan fail-closed (lihat `onchain/prices.ts`).
 */
export async function computeEpochPlan(
  window: BurnWindow,
  config: BurnConfig,
): Promise<EpochPlan> {
  const runRows = await db
    .select({
      id: runs.id,
      chargedMicro: runs.chargedMicro,
      providerCostUsd: runs.providerCostUsd,
    })
    .from(runs)
    .where(
      and(
        inArray(runs.status, ["SETTLED", "RELEASED"]),
        isNotNull(runs.finishedAt),
        gte(runs.finishedAt, window.start),
        lt(runs.finishedAt, window.end),
      ),
    );

  if (runRows.length === 0) {
    return { breakdown: emptyBreakdown(), runsCount: 0, priceSource: null, priceError: null };
  }

  const runIds = runRows.map((row) => row.id);
  const settlementRows = await db
    .select({
      runId: ledgerEntries.runId,
      lotId: ledgerEntries.lotId,
      source: creditLots.source,
      amountMicro: ledgerEntries.amountMicro,
    })
    .from(ledgerEntries)
    .innerJoin(creditLots, eq(creditLots.id, ledgerEntries.lotId))
    .where(
      and(
        eq(ledgerEntries.type, "SETTLE"),
        isNotNull(ledgerEntries.lotId),
        inArray(ledgerEntries.runId, runIds),
      ),
    );

  const settlements: MarginSettlementInput[] = settlementRows
    .filter((row): row is typeof row & { runId: string; lotId: string } =>
      Boolean(row.runId && row.lotId),
    )
    .map((row) => ({
      runId: row.runId,
      lotId: row.lotId,
      source: row.source,
      consumedMicro: Math.abs(row.amountMicro),
    }));

  let gattaiPrice8: bigint | null = null;
  let priceSource: string | null = null;
  let priceError: string | null = null;
  try {
    const price = await priceForToken(
      { symbol: "GATTAI", address: NATIVE_TOKEN, decimals: 18 },
      config.priceContext,
    );
    gattaiPrice8 = price.price8;
    priceSource = price.source;
  } catch (error) {
    if (error instanceof PriceUnavailableError) {
      priceError = error.message;
    } else {
      throw error;
    }
  }

  const breakdown = planFromMarginRows({
    runs: runRows.map((row) => ({
      runId: row.id,
      chargedMicro: row.chargedMicro,
      providerCostUsd: row.providerCostUsd,
    })),
    settlements,
    shareStable: config.shareStable,
    shareToken: config.shareToken,
    gattaiPrice8,
  });

  return { breakdown, runsCount: runRows.length, priceSource, priceError };
}
