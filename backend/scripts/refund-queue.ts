/**
 * Antrean peninjauan manual untuk deposit yang tidak dikreditkan.
 *
 * Kasus yang masuk antrean:
 * - `dust` / `over_cap`: dana sudah diteruskan kontrak ke treasury, tetapi
 *   tidak dibuatkan lot. Kontrak tidak punya fungsi refund.
 * - `needs_review`: token tidak dikenal atau poison pill.
 * - `reorged`: tx keluar dari rantai kanonik; kredit sudah ditarik. Bila tx
 *   tidak kembali, dana perlu ditinjau/refund.
 * - `pending` lebih dari 1 jam: biasanya harga belum tersedia. Retry worker
 *   mencoba ulang otomatis, tetapi baris ini tetap ditampilkan agar operator
 *   tahu ada deposit yang belum terkredit.
 * - dead-letter `unknown_project`: project id onchain tidak terdaftar; dana
 *   sudah masuk treasury dan tidak bisa dikreditkan.
 *
 * Skrip ini HANYA membaca DB dan mencetak data yang dibutuhkan untuk membuat
 * transaksi refund. Tidak memegang private key dan tidak mengirim transaksi.
 * Refund dilakukan manual dari treasury (Safe) setelah verifikasi onchain.
 *
 * Pemakaian:
 *   bun run refund:queue
 *   bun run refund:queue --json
 */

import "dotenv/config";
import { and, desc, eq, inArray, lt, or } from "drizzle-orm";
import { db, pool } from "../src/db";
import { depositDeadLetters, deposits } from "../src/db/schema";

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

async function main(): Promise<void> {
  const rows = await db
    .select({
      id: deposits.id,
      projectId: deposits.projectId,
      chainTx: deposits.chainTx,
      logIndex: deposits.logIndex,
      payer: deposits.payer,
      token: deposits.token,
      source: deposits.source,
      amountRaw: deposits.amountRaw,
      usdValue: deposits.usdValue,
      status: deposits.status,
      createdAt: deposits.createdAt,
    })
    .from(deposits)
    .where(
      or(
        inArray(deposits.status, ["dust", "over_cap", "needs_review", "reorged"]),
        and(
          eq(deposits.status, "pending"),
          lt(deposits.createdAt, new Date(Date.now() - 3600_000)),
        ),
      ),
    )
    .orderBy(desc(deposits.createdAt))
    .limit(1000);

  const deadLetters = await db
    .select({
      id: depositDeadLetters.id,
      chainTx: depositDeadLetters.chainTx,
      logIndex: depositDeadLetters.logIndex,
      projectId: depositDeadLetters.projectId,
      payer: depositDeadLetters.payer,
      token: depositDeadLetters.token,
      amountRaw: depositDeadLetters.amountRaw,
      error: depositDeadLetters.error,
      attempts: depositDeadLetters.attempts,
      createdAt: depositDeadLetters.createdAt,
    })
    .from(depositDeadLetters)
    .orderBy(desc(depositDeadLetters.createdAt))
    .limit(1000);

  if (hasFlag("--json")) {
    console.log(JSON.stringify({ deposits: rows, deadLetters }, null, 2));
    return;
  }

  if (rows.length === 0 && deadLetters.length === 0) {
    console.log("Tidak ada deposit yang menunggu peninjauan/refund.");
    return;
  }

  if (rows.length > 0) {
    console.log(`${rows.length} deposit menunggu keputusan refund/peninjauan:\n`);
    for (const row of rows) {
      console.log(
        [
          `${row.status.toUpperCase()}  ${row.id}`,
          `  tx/log     : ${row.chainTx} #${row.logIndex}`,
          `  project    : ${row.projectId}`,
          `  payer      : ${row.payer ?? "(tidak tersedia)"}`,
          `  token      : ${row.source ?? "?"} ${row.token}`,
          `  amount raw : ${row.amountRaw}`,
          `  USD value  : ${row.usdValue ?? "?"}`,
          `  created    : ${row.createdAt.toISOString()}`,
        ].join("\n"),
      );
    }
  }

  if (deadLetters.length > 0) {
    console.log(`\n${deadLetters.length} dead-letter (perlu peninjauan manual):\n`);
    for (const row of deadLetters) {
      console.log(
        [
          `DEAD LETTER  ${row.id}`,
          `  tx/log     : ${row.chainTx} #${row.logIndex}`,
          `  project    : ${row.projectId ?? "(tidak diketahui)"}`,
          `  payer      : ${row.payer ?? "(tidak tersedia)"}`,
          `  token      : ${row.token ?? "?"}`,
          `  amount raw : ${row.amountRaw ?? "?"}`,
          `  error      : ${row.error} (attempts ${row.attempts})`,
          `  created    : ${row.createdAt.toISOString()}`,
        ].join("\n"),
      );
    }
  }

  console.log(
    "\nRefund dilakukan manual dari treasury (Safe). Verifikasi alamat payer, token, dan tx onchain sebelum mengirim.",
  );
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
