import { serve } from "@hono/node-server";
import "dotenv/config";
import app from "./app";
import { getParams } from "./config";
import { assertProductionConfig, env, missingProviderKeys } from "./env";
import { syncRecipes } from "./orchestration/create-run";
import { startReaper } from "./orchestration/reap";
import { startBurnIndexer } from "./burn/indexer";
import { getHolderSnapshotIntervalMs } from "./holder/config";
import { startHolderSnapshotWorker } from "./holder/snapshot-worker";
import { startDepositReconciler } from "./onchain/reconciler";
import { ensureProjectOnchainIds } from "./services/projects";

const port = Number(process.env.PORT ?? 3000);

// Konfigurasi yang harus valid SEBELUM menerima trafik. Di produksi, preflight
// menolak chain testnet, alamat testnet, USDG non-kanonik, konfirmasi terlalu
// rendah, dan aset yang belum punya sumber harga. Lebih baik gagal boot
// daripada menerima uang user dengan konfigurasi yang salah.
assertProductionConfig();

// Daftar host SIWE yang diizinkan. Di produksi nilai kosong/wildcard melempar
// di sini — gagal saat boot, bukan saat user mencoba login.
const siweDomains = env.siweDomains;

serve({ fetch: app.fetch, port, hostname: "0.0.0.0" });
console.log(`Server berjalan di http://localhost:${port}`);
console.log(`[startup] domain SIWE: ${siweDomains.join(", ")}`);
// Region MIMO melekat pada base URL; log host membuat salah region (CN vs SGP)
// langsung kelihatan tanpa membocorkan API key.
console.log(`[startup] MIMO endpoint: ${env.mimoApiUrl} (model ${env.mimoModel})`);

// Peringatan dini: key provider yang kosong membuat formasi terkait gagal saat
// dijalankan (pesan ke user tetap generik). Nama variabel hanya untuk log.
const missingKeys = missingProviderKeys();
if (missingKeys.length > 0) {
  console.warn(`[startup] provider key belum diisi: ${missingKeys.join(", ")}`);
}

if (!process.env.DATABASE_URL) {
  console.log(
    "DATABASE_URL belum diisi. Endpoint database tidak aktif; /health tetap jalan.",
  );
} else {
  // Seed recipe dari config ke DB (idempoten). Non-fatal agar server tetap
  // hidup walau migrasi belum dijalankan.
  syncRecipes()
    .then((count) => console.log(`[startup] ${count} recipe disinkronkan ke database`))
    .catch((error) =>
      console.warn(
        "[startup] gagal menyinkronkan recipe:",
        error instanceof Error ? error.message : error,
      ),
    );

  // Reap run yatim yang macet non-terminal (mis. restart saat eksekusi) dan
  // estimasi media yang tak kunjung dikonfirmasi — sekali saat startup lalu
  // berkala, supaya server yang hidup lama tidak menahan reservasi sampai restart.
  // Non-fatal; SSE untuk run tersebut langsung selesai setelah status terminal.
  startReaper({
    staleAfterMs: env.runStaleAfterMs,
    confirmExpiryMs: env.runConfirmExpiryMs,
    intervalMs: env.reapIntervalMs,
  });

  // Backfill `onchain_id` untuk project lama (idempoten, Fase 2).
  ensureProjectOnchainIds()
    .then((count) => {
      if (count > 0) console.log(`[startup] onchain_id diisi untuk ${count} project`);
    })
    .catch((error) =>
      console.warn(
        "[startup] gagal mengisi onchain_id:",
        error instanceof Error ? error.message : error,
      ),
    );

  // Reconciler deposit (Fase 2): kredit deposit yang lolos jalur confirm instan
  // (user menutup tab / confirm gagal sesaat). Non-fatal.
  let depositIndexer: { stop: () => void } | null = null;
  let burnIndexer: { stop: () => void } | null = null;
  let holderSnapshotWorker: { stop: () => void } | null = null;

  startDepositReconciler()
    .then((indexer) => {
      depositIndexer = indexer;
    })
    .catch((error) =>
      console.warn(
        "[startup] gagal memulai deposit reconciler:",
        error instanceof Error ? error.message : error,
      ),
    );

  // Burn indexer (Fase 1): transfer token GATTAI ke dead address.
  startBurnIndexer()
    .then((indexer) => {
      burnIndexer = indexer;
    })
    .catch((error) =>
      console.warn(
        "[startup] gagal memulai burn indexer:",
        error instanceof Error ? error.message : error,
      ),
    );

  // Holder snapshot worker: syarat utama agar tier holder bisa aktif.
  // Tanpa siklus berkala, aturan dua snapshot berturut-turut tidak pernah
  // terpenuhi. Worker memakai advisory lock sehingga aman di multi-instance.
  if (!getParams().holder.enabled) {
    console.log("[startup] holder snapshot worker dilewati: HOLDER_RUNS_ENABLED=false");
  } else if (env.robinhoodRpcUrl) {
    holderSnapshotWorker = startHolderSnapshotWorker({
      intervalMs: getHolderSnapshotIntervalMs(),
      runOnStart: true,
      onCycle: (result) => {
        if (result.skippedByLock) return;
        if (result.scanned > 0) {
          console.log(
            `[holder-snapshot] ${result.recorded}/${result.scanned} wallet tercatat, ${result.skipped} dilewati`,
          );
        }
        if (result.pruned > 0) {
          console.log(`[holder-snapshot] ${result.pruned} snapshot lama dipangkas`);
        }
        if (result.pruneError) {
          console.warn("[holder-snapshot] retensi snapshot gagal:", result.pruneError);
        }
      },
      onError: (error) =>
        console.warn(
          "[holder-snapshot] siklus gagal:",
          error instanceof Error ? error.message : error,
        ),
    });
  } else {
    console.log("[startup] holder snapshot worker dilewati: RPC URL belum diisi");
  }

  const shutdown = () => {
    depositIndexer?.stop();
    burnIndexer?.stop();
    holderSnapshotWorker?.stop();
    process.exit(0);
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
