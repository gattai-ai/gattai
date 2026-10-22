/**
 * Tipe untuk modul burn (Fase 3).
 *
 * Burn didanai dari **margin** (bukan pendapatan kotor), dihitung per run yang
 * sudah settled, lalu diatribusikan ke tiap lot yang dikonsumsi oleh run itu
 * secara proporsional terhadap credits yang diambil dari lot tersebut.
 */

import type { PriceContext } from "../onchain/prices";

/** Jendela periode satu epoch: `[start, end)`. */
export interface BurnWindow {
  start: Date;
  end: Date;
}

/** Margin satu lot yang dikonsumsi dalam sebuah run. */
export interface LotMargin {
  lotId: string;
  source: "ETH" | "USDG" | "GATTAI" | "PROMO";
  /** Credits yang dikonsumsi dari lot ini (positif, micro-credits). */
  consumedMicro: number;
  /** Margin yang diatribusikan ke lot ini (USD skala-8). */
  marginUsd8: bigint;
}

/** Margin sebuah run beserta rincian per lot. */
export interface RunMargin {
  runId: string;
  chargedMicro: number;
  providerCostUsd8: bigint;
  /** `max(0, charged − provider_cost)` (USD skala-8). */
  marginUsd8: bigint;
  lots: LotMargin[];
}

/** Hasil perhitungan satu epoch. */
export interface BurnBreakdown {
  stableMarginUsd8: bigint;
  tokenMarginUsd8: bigint;
  stableBudgetUsd8: bigint;
  tokenBudgetUsd8: bigint;
  totalBudgetUsd8: bigint;
  /** Harga GATTAI (USD/token, skala 8), atau null bila tidak tersedia. */
  gattaiPrice8: bigint | null;
  /** GATTAI yang harus dibeli via buyback (18 desimal). */
  buybackTokens18: bigint;
  /** GATTAI yang di-burn langsung dari treasury (18 desimal). */
  directBurnTokens18: bigint;
  runs: RunMargin[];
}

/** Konfigurasi perhitungan burn. */
export interface BurnConfig {
  shareStable: number;
  shareToken: number;
  priceContext: PriceContext;
}

/** Hasil eksekusi oleh {@link BurnExecutor}. */
export interface BurnExecutionResult {
  tokensBurned18: bigint;
  txHashes: string[];
}

/**
 * Seam eksekusi. Implementasi default adalah dry-run (hanya merencanakan);
 * eksekusi onchain sebenarnya dilakukan treasury multisig (lihat `worker.ts`).
 */
export interface BurnExecutor {
  readonly kind: "dry-run" | "onchain";
  execute(plan: BurnBreakdown): Promise<BurnExecutionResult>;
}
