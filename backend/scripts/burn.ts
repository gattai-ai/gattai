/**
 * Worker epoch buyback & burn (Fase 3).
 *
 * Menghitung margin per lot yang dikonsumsi, menyusun budget burn, lalu
 * mencatatnya di `burn_epochs`. Default **dry-run**: hanya merencanakan
 * (epoch ditulis `pending`). Eksekusi onchain sebenarnya dilakukan treasury
 * (multisig), lalu dicatat lewat `--mark-executed`.
 *
 * Pemakaian:
 *   bun run burn                                   # rencanakan semua epoch tertutup
 *   bun run burn --live                            # polling berkala
 *   bun run burn --period-start=2026-09-01T00:00:00Z --period-end=2026-09-08T00:00:00Z
 *   bun run burn --execute                         # burn langsung via treasury EOA (gated)
 *   bun run burn --mark-executed --period-start=2026-09-01T00:00:00Z \
 *     --tx=0xabc... --tx=0xdef... --tokens=1234.5
 *
 * Env: DATABASE_URL (wajib), BURN_EPOCH_HOURS, BURN_GENESIS, BURN_POLL_INTERVAL_MS,
 *      BURN_EXECUTE, BURN_TREASURY_PRIVATE_KEY, ROBINHOOD_RPC_URL, CHAIN_ID,
 *      GATTAI_TOKEN_ADDRESS, TREASURY_ADDRESS, GATTAI_USD_PRICE, ALLOW_MANUAL_PRICES.
 */

import "dotenv/config";
import { pool } from "../src/db";
import { env } from "../src/env";
import { buildBurnConfig } from "../src/burn/config";
import {
  alignDown,
  decimalToTokens18,
  markEpochExecuted,
  runBurnCycle,
  type BurnExecutor,
  type BurnWindow,
} from "../src/burn";
import {
  DryRunExecutor,
  OnchainBurnExecutor,
  createRobinhoodWalletClient,
} from "../src/burn/executor";
import { createRobinhoodClient } from "../src/onchain/client";
import type { ContractReader } from "../src/onchain/prices";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/;

function argValues(flag: string): string[] {
  const prefix = `${flag}=`;
  return process.argv
    .filter((arg) => arg.startsWith(prefix))
    .map((arg) => arg.slice(prefix.length));
}

function argValue(flag: string): string | undefined {
  return argValues(flag)[0];
}

function parseDateArg(value: string | undefined, label: string): Date | undefined {
  if (value === undefined) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${label} bukan tanggal valid: ${value}`);
  return date;
}

function buildExecutor(wantExecute: boolean): BurnExecutor {
  if (!wantExecute) return new DryRunExecutor();

  const privateKey = env.burnTreasuryPrivateKey;
  const rpcUrl = env.robinhoodRpcUrl;
  const gattaiToken = env.gattaiTokenAddress;
  const treasury = env.treasuryAddress;

  if (!privateKey || !PRIVATE_KEY_RE.test(privateKey)) {
    throw new Error("BURN_TREASURY_PRIVATE_KEY wajib (32-byte hex) untuk --execute.");
  }
  if (!rpcUrl) throw new Error("ROBINHOOD_RPC_URL wajib untuk --execute.");
  if (!gattaiToken || !ADDRESS_RE.test(gattaiToken)) {
    throw new Error("GATTAI_TOKEN_ADDRESS wajib (sah) untuk --execute.");
  }
  if (!treasury || !ADDRESS_RE.test(treasury)) {
    throw new Error("TREASURY_ADDRESS wajib (sah) untuk --execute.");
  }

  return new OnchainBurnExecutor({
    wallet: createRobinhoodWalletClient({
      privateKey: privateKey as `0x${string}`,
      rpcUrl,
      chainId: env.chainId,
    }),
    gattaiToken: gattaiToken as `0x${string}`,
    from: treasury as `0x${string}`,
  });
}

async function main(): Promise<void> {
  const markExecuted = process.argv.includes("--mark-executed");
  const live = process.argv.includes("--live");
  const periodStart = parseDateArg(argValue("--period-start"), "--period-start");
  const periodEnd = parseDateArg(argValue("--period-end"), "--period-end");

  if (markExecuted) {
    if (!periodStart) throw new Error("--mark-executed butuh --period-start=ISO.");
    const txHashes = argValues("--tx");
    const tokens = argValue("--tokens");
    if (!tokens) throw new Error("--mark-executed butuh --tokens=<jumlah GATTAI>.");
    const ok = await markEpochExecuted({
      periodStart,
      txHashes,
      tokensBurned18: decimalToTokens18(tokens),
    });
    if (!ok) {
      throw new Error(`Epoch dengan period_start ${periodStart.toISOString()} tidak ditemukan.`);
    }
    console.log(
      `[burn] epoch ${periodStart.toISOString()} ditandai executed: ${tokens} GATTAI, ${txHashes.length} tx.`,
    );
    return;
  }

  const durationMs = env.burnEpochHours * 3_600_000;
  const genesis = alignDown(env.burnGenesis, durationMs);
  const reader = env.robinhoodRpcUrl
    ? (createRobinhoodClient() as unknown as ContractReader)
    : undefined;

  let window: BurnWindow | undefined;
  if (periodStart && periodEnd) {
    window = { start: periodStart, end: periodEnd };
  } else if (periodStart || periodEnd) {
    throw new Error("Berikan --period-start dan --period-end sekaligus.");
  }

  const options = {
    executor: buildExecutor(process.argv.includes("--execute") || env.burnExecute),
    config: buildBurnConfig(reader),
    genesis,
    durationMs,
    window,
    onEpoch: (outcome: {
      window: BurnWindow;
      skipped: boolean;
      skipReason?: string;
      status?: string;
      runsCount: number;
      totalBudgetUsd8: bigint;
      tokensBurned18: bigint;
      priceSource: string | null;
      priceError: string | null;
    }) => {
      const period = `${outcome.window.start.toISOString()} → ${outcome.window.end.toISOString()}`;
      if (outcome.skipped) {
        console.log(`[burn] ${period}: dilewati (${outcome.skipReason}).`);
        return;
      }
      console.log(
        `[burn] ${period}: status=${outcome.status} runs=${outcome.runsCount} ` +
          `budget=$${formatUsd(outcome.totalBudgetUsd8)} burned=${outcome.tokensBurned18} ` +
          `price=${outcome.priceSource ?? outcome.priceError ?? "n/a"}`,
      );
    },
  };

  if (!live) {
    const outcomes = await runBurnCycle(options);
    const recorded = outcomes.filter((outcome) => !outcome.skipped).length;
    console.log(`[burn] selesai: ${outcomes.length} jendela diperiksa, ${recorded} epoch dicatat.`);
    if (options.executor.kind === "dry-run") {
      console.log(
        "[burn] mode dry-run: epoch dicatat `pending`. Eksekusi via treasury lalu `bun run burn --mark-executed ...`.",
      );
    }
    return;
  }

  console.log(`[burn] live mode: poll tiap ${env.burnPollIntervalMs} ms (${options.executor.kind}).`);
  const timer = setInterval(() => {
    runBurnCycle(options).catch((error) =>
      console.error("[burn] error:", error instanceof Error ? error.message : error),
    );
  }, env.burnPollIntervalMs);
  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => {
      clearInterval(timer);
      resolve();
    });
  });
}

function formatUsd(usd8: bigint): string {
  const whole = usd8 / 100_000_000n;
  const fraction = (usd8 % 100_000_000n).toString().padStart(8, "0");
  return `${whole}.${fraction}`;
}

main()
  .then(() => pool.end())
  .then(() => process.exit(0))
  .catch(async (error) => {
    console.error("burn gagal:", error instanceof Error ? error.message : error);
    await pool.end().catch(() => {});
    process.exit(1);
  });
