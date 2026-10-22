/**
 * Pembatalan manual satu deposit (ops).
 *
 * Dipakai bila operator sudah memastikan sebuah tx deposit tidak lagi ada di
 * rantai kanonik (reorg). Reconciler **tidak** membatalkan otomatis — lihat
 * `src/onchain/reorg.ts` untuk alasannya. Skrip ini memberi jalur pembatalan
 * yang eksplisit, idempotent, dan dapat diaudit.
 *
 * Pemakaian:
 *   bun run deposit:reverse --tx=0x<64 hex> [--log-index=0] [--dry-run]
 */

import "dotenv/config";
import { and, eq } from "drizzle-orm";
import { reverseCredit } from "../src/billing/ledger";
import { db, pool } from "../src/db";
import { deposits } from "../src/db/schema";

function argValue(flag: string): string | undefined {
  const prefix = `${flag}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found?.slice(prefix.length);
}

async function main(): Promise<void> {
  const tx = argValue("--tx");
  if (!tx || !/^0x[0-9a-fA-F]{64}$/.test(tx)) {
    throw new Error("Wajib: --tx=0x<64 hex>");
  }
  const logIndexArg = argValue("--log-index");
  const dryRun = process.argv.includes("--dry-run");

  const rows = await db
    .select()
    .from(deposits)
    .where(
      logIndexArg !== undefined
        ? and(eq(deposits.chainTx, tx), eq(deposits.logIndex, Number(logIndexArg)))
        : eq(deposits.chainTx, tx),
    );

  if (rows.length === 0) throw new Error(`Deposit tidak ditemukan untuk tx ${tx}.`);
  if (rows.length > 1) {
    console.error(`Ditemukan ${rows.length} log untuk tx ini; pakai --log-index=<n>.`);
    for (const row of rows) {
      console.error(
        `  logIndex=${row.logIndex} status=${row.status} credits=${row.creditsMicro}`,
      );
    }
    process.exitCode = 1;
    return;
  }

  const deposit = rows[0];
  console.log(
    `[reverse] deposit ${deposit.id} tx=${deposit.chainTx}#${deposit.logIndex} status=${deposit.status} credits=${deposit.creditsMicro} lot=${deposit.lotId ?? "-"}`,
  );

  if (dryRun) {
    console.log("[reverse] dry-run: tidak ada perubahan.");
    return;
  }
  if (deposit.status !== "confirmed") {
    throw new Error(
      `Hanya deposit berstatus 'confirmed' yang bisa dibatalkan (sekarang: ${deposit.status}).`,
    );
  }

  const { applied } = await reverseCredit({
    projectId: deposit.projectId,
    lotId: deposit.lotId,
    amountMicro: Number(deposit.creditsMicro),
    idempotencyKey: `reorg:${deposit.chainTx}:${deposit.logIndex}`,
  });
  await db.update(deposits).set({ status: "reorged" }).where(eq(deposits.id, deposit.id));
  console.log(
    applied
      ? `[reverse] selesai: -${deposit.creditsMicro} micro, status=reorged.`
      : "[reverse] idempotent: pembatalan sudah pernah dicatat; status di-set reorged.",
  );
}

main()
  .then(() => pool.end())
  .catch(async (error) => {
    console.error("[reverse] gagal:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
    await pool.end();
  });
