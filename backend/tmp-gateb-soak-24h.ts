import { writeFile } from "node:fs/promises";
import { pool } from "./src/db";
import { getHolderStatus } from "./src/holder/service";
import { runHolderSnapshotCycle, startHolderSnapshotWorker } from "./src/holder/snapshot-worker";

const DURATION_MS = 24 * 60 * 60 * 1000;
const INTERVAL_MS = 12 * 60 * 60 * 1000;
const wallet = "0x000000000000000000000000000000000000dEaD";
const projectId = "prj_gateb_dead";
const summaryPath = process.env.GATEB_SUMMARY_PATH;

type CycleLog = {
  at: string;
  scanned: number;
  recorded: number;
  skipped: number;
  skippedByLock: boolean;
};

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("/gattai_gateb")) {
    throw new Error("Refusing to run Gate B 24h soak outside gattai_gateb");
  }
  if (!summaryPath) {
    throw new Error("GATEB_SUMMARY_PATH is required");
  }

  const startedAt = new Date().toISOString();
  const cycles: CycleLog[] = [];
  const errors: string[] = [];
  console.log(`[soak] start ${startedAt}; interval=${INTERVAL_MS}ms; duration=${DURATION_MS}ms`);

  const worker = startHolderSnapshotWorker({
    intervalMs: INTERVAL_MS,
    runOnStart: true,
    runCycle: () => runHolderSnapshotCycle(),
    onCycle: (result) => {
      const entry = { at: new Date().toISOString(), ...result };
      cycles.push(entry);
      console.log("[soak] cycle", JSON.stringify(entry));
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${new Date().toISOString()} ${message}`);
      console.error("[soak] error", message);
    },
  });

  await new Promise((resolve) => setTimeout(resolve, DURATION_MS));
  worker.stop();
  // Beri kesempatan siklus terakhir selesai.
  await new Promise((resolve) => setTimeout(resolve, 10_000));

  const countResult = await pool.query<{ count: number }>(
    "select count(*)::int as count from holder_snapshots where wallet = $1",
    [wallet.toLowerCase()],
  );
  const duplicateResult = await pool.query<{ count: number }>(
    "select count(*)::int as count from (select wallet, block_number from holder_snapshots group by 1, 2 having count(*) > 1) d",
  );
  const ledgerDuplicateResult = await pool.query<{ count: number }>(
    "select count(*)::int as count from (select run_id from holder_cost_ledger group by 1 having count(*) > 1) d",
  );
  const status = await getHolderStatus(wallet, projectId);

  const summary = {
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    duration_ms: DURATION_MS,
    interval_ms: INTERVAL_MS,
    cycles,
    errors,
    wallet_snapshot_count: countResult.rows[0]?.count ?? null,
    duplicate_wallet_block_groups: duplicateResult.rows[0]?.count ?? null,
    duplicate_ledger_run_groups: ledgerDuplicateResult.rows[0]?.count ?? null,
    tier: status.tier,
    snapshot_status: status.snapshot_status,
    snapshot_stale: status.snapshot_stale,
    free_runs: status.free_runs,
  };

  await writeFile(summaryPath, JSON.stringify(summary, null, 2), "utf8");
  console.log("[soak] summary", JSON.stringify(summary, null, 2));
  if (errors.length > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error("[soak] fatal", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
