/**
 * Backfill tautan percakapan lama (`runs.conversation_id`).
 *
 * Run yang dibuat sebelum fase C tidak punya `conversation_id`, sehingga
 * percakapannya tidak muncul di halaman History. Skrip ini memulihkan tautan
 * dari `messages` (lihat `src/services/backfill.ts`) secara idempoten.
 *
 * PENTING (urutan operasional): `messages` adalah satu-satunya sumber tautan,
 * dan ringkasan rolling memangkasnya. Jalankan backfill SEBELUM percakapan lama
 * dijalankan lagi (yang memicu pemangkasan). Lihat docs/10-runbook.md.
 *
 * Pemakaian:
 *   bun run backfill:conversations [--dry-run|--apply] [--batch=500]
 *                                  [--project=prj_...] [--report=file.json]
 *
 * Default = dry-run (tidak menulis). Beri `--apply` untuk benar-benar menulis.
 * Exit code 1 bila ada konflik lintas project atau kegagalan.
 */

import "dotenv/config";
import { writeFile } from "node:fs/promises";
import { backfillConversations } from "../src/services/backfill";
import { pool } from "../src/db";

function argValue(flag: string): string | undefined {
  const prefix = `${flag}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found?.slice(prefix.length);
}

async function main(): Promise<void> {
  const dryRun = !process.argv.includes("--apply");

  const batchArg = argValue("--batch");
  const batchSize = batchArg === undefined ? undefined : Number(batchArg);
  if (batchSize !== undefined && (!Number.isInteger(batchSize) || batchSize <= 0)) {
    throw new Error("--batch harus bilangan bulat positif.");
  }

  const projectId = argValue("--project");

  const report = await backfillConversations({ dryRun, batchSize, projectId });

  console.log(
    `[backfill] mode=${report.dryRun ? "dry-run" : "apply"} kandidat=${report.linked} batch=${report.batches} konflik=${report.conflicts}`,
  );
  for (const sample of report.conflictSamples) {
    console.error(`[backfill] konflik (tidak ditautkan): ${sample}`);
  }

  if (report.dryRun) {
    console.log("[backfill] dry-run: tidak ada perubahan. Ulangi dengan --apply untuk menulis.");
  } else {
    console.log(`[backfill] selesai: ${report.linked} run ditautkan ke percakapannya.`);
  }

  const reportPath = argValue("--report");
  if (reportPath) {
    await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
    console.log(`[backfill] laporan ditulis ke ${reportPath}`);
  }

  // Konflik = data yang butuh peninjauan manual → sinyalkan lewat exit code.
  if (report.conflicts > 0) process.exitCode = 1;
}

main()
  .then(() => pool.end())
  .catch(async (error) => {
    console.error("[backfill] gagal:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
    await pool.end();
  });
