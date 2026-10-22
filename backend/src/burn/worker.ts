import { BurnUnavailableError } from "./executor";
import { computeEpochPlan } from "./plan";
import {
  enumerateWindows,
  findEpochByPeriodStart,
  recordEpoch,
  type EpochStatus,
} from "./epochs";
import type { BurnConfig, BurnExecutor, BurnWindow } from "./types";

/**
 * Worker epoch buyback & burn.
 *
 * Untuk setiap jendela epoch yang sudah tertutup: hitung margin per lot,
 * susun budget, (opsional) eksekusi lewat {@link BurnExecutor}, lalu catat di
 * `burn_epochs`. Jendela tanpa margin dilewati. Idempotent per `period_start`
 * sehingga aman dijalankan berulang (catch-up).
 */

export interface BurnCycleOptions {
  executor: BurnExecutor;
  config: BurnConfig;
  genesis: Date;
  durationMs: number;
  now?: Date;
  /** Bila diisi, hanya proses jendela ini (tanpa enumerasi). */
  window?: BurnWindow;
  onEpoch?: (outcome: EpochOutcome) => void;
}

export interface EpochOutcome {
  window: BurnWindow;
  skipped: boolean;
  skipReason?: string;
  epochId?: string;
  created?: boolean;
  status?: EpochStatus;
  runsCount: number;
  totalBudgetUsd8: bigint;
  tokensBurned18: bigint;
  priceSource: string | null;
  priceError: string | null;
  executionError?: string | null;
}

async function processWindow(
  window: BurnWindow,
  options: BurnCycleOptions,
): Promise<EpochOutcome> {
  const plan = await computeEpochPlan(window, options.config);
  const base = {
    window,
    runsCount: plan.runsCount,
    totalBudgetUsd8: plan.breakdown.totalBudgetUsd8,
    priceSource: plan.priceSource,
    priceError: plan.priceError,
  };

  if (plan.runsCount === 0 || plan.breakdown.totalBudgetUsd8 <= 0n) {
    return { ...base, skipped: true, skipReason: "no margin", tokensBurned18: 0n };
  }

  // Jangan eksekusi ulang epoch yang sudah tercatat `executed`.
  const existing = await findEpochByPeriodStart(window.start);
  if (existing[0]?.status === "executed") {
    return { ...base, skipped: true, skipReason: "already executed", tokensBurned18: 0n };
  }

  if (options.executor.kind === "dry-run") {
    const recorded = await recordEpoch({
      window,
      breakdown: plan.breakdown,
      status: "pending",
      tokensBurned18: 0n,
      txHashes: [],
      priceSource: plan.priceSource,
      priceError: plan.priceError,
      mode: "dry-run",
      runsCount: plan.runsCount,
    });
    return {
      ...base,
      skipped: false,
      epochId: recorded.id,
      created: recorded.created,
      status: recorded.status,
      tokensBurned18: 0n,
    };
  }

  try {
    const result = await options.executor.execute(plan.breakdown);
    // Epoch tidak boleh ditandai `executed` bila executor tidak benar-benar
    // membakar token. Biarkan `pending` untuk peninjauan operator.
    if (result.tokensBurned18 <= 0n) {
      throw new BurnUnavailableError(
        "Executor melaporkan 0 token terbakar; epoch dibiarkan pending untuk peninjauan.",
      );
    }
    if (result.txHashes.length === 0) {
      throw new BurnUnavailableError(
        "Executor tidak menghasilkan tx hash; epoch dibiarkan pending untuk peninjauan.",
      );
    }
    const recorded = await recordEpoch({
      window,
      breakdown: plan.breakdown,
      status: "executed",
      tokensBurned18: result.tokensBurned18,
      txHashes: result.txHashes,
      priceSource: plan.priceSource,
      priceError: plan.priceError,
      executionError: null,
      mode: "onchain",
      runsCount: plan.runsCount,
    });
    return {
      ...base,
      skipped: false,
      epochId: recorded.id,
      created: recorded.created,
      status: recorded.status,
      tokensBurned18: result.tokensBurned18,
    };
  } catch (error) {
    if (!(error instanceof BurnUnavailableError)) throw error;
    // Eksekusi belum bisa otomatis (mis. buyback belum ada) → tetap `pending`
    // agar bisa dieksekusi operator treasury lalu dicatat dengan --mark-executed.
    const executionError = error.message;
    const recorded = await recordEpoch({
      window,
      breakdown: plan.breakdown,
      status: "pending",
      tokensBurned18: 0n,
      txHashes: [],
      priceSource: plan.priceSource,
      priceError: plan.priceError,
      executionError,
      mode: "onchain",
      runsCount: plan.runsCount,
    });
    return {
      ...base,
      skipped: false,
      epochId: recorded.id,
      created: recorded.created,
      status: recorded.status,
      tokensBurned18: 0n,
      executionError,
    };
  }
}

/** Jalankan satu siklus: proses semua jendela tertutup (atau satu jendela). */
export async function runBurnCycle(options: BurnCycleOptions): Promise<EpochOutcome[]> {
  const now = options.now ?? new Date();
  const windows = options.window
    ? [options.window]
    : enumerateWindows(options.genesis, now, options.durationMs);

  const outcomes: EpochOutcome[] = [];
  for (const window of windows) {
    const outcome = await processWindow(window, options);
    options.onEpoch?.(outcome);
    outcomes.push(outcome);
  }
  return outcomes;
}
