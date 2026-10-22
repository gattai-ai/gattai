import { and, eq } from "drizzle-orm";
import { getConfig, getParams, getRecipe, type RecipeConfig } from "../config";
import { db } from "../db";
import { recipes, runs } from "../db/schema";
import { currentBalance, lockProject } from "../billing/ledger";
import { estimateRecipe, type RecipeEstimate } from "../billing/estimate";
import { readTrialState } from "../billing/trial";
import { newId } from "../lib/id";
import { ApiError } from "../lib/http";
import {
  FORMATION_UNAVAILABLE_MESSAGE,
  isRecipeAvailable,
} from "./availability";
import { ensureConversation } from "../services/conversations";

export type RunRow = typeof runs.$inferSelect;

export interface CreateRunInput {
  projectId: string;
  recipeId: string;
  input: string;
  conversationId?: string | null;
  idempotencyKey?: string;
  /**
   * Buka percakapan untuk run ini (default `true`). Jalur API murni
   * (`POST /v1/chat/completions`) mengirim `false`: kliennya sudah mengirim
   * konteks penuh di setiap request, jadi membuka percakapan hanya menumpuk
   * entri satu-turn di riwayat web **dan** memicu ringkasan berbiaya provider
   * yang tidak dipakai siapa pun.
   */
  openConversation?: boolean;
}

export interface CreatedRun {
  run: RunRow;
  recipe: RecipeConfig;
  estimate: RecipeEstimate;
  /** Run ini dibiayai kuota trial, bukan credit berbayar. */
  isTrial: boolean;
  /**
   * Percakapan pemilik run. Dibuat server bila pemanggil tidak menyebutkannya.
   * `null` berarti run sengaja dibuat tanpa percakapan (`openConversation: false`
   * di jalur API) atau run lama yang diputar ulang lewat `Idempotency-Key`.
   */
  conversationId: string | null;
  /**
   * Run ini adalah hasil replay `Idempotency-Key` (bukan yang baru dibuat).
   * Pemanggil TIDAK boleh mengeksekusinya lagi: pemilik key yang asli sudah
   * menjalankannya, dan eksekusi kedua menagih biaya provider dua kali serta
   * menduplikasi pesan percakapan.
   */
  replayed: boolean;
}

/** Stringify kanonis (kunci terurut rekursif) untuk membandingkan config. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Simpan/segarkan definisi recipe ke tabel `recipes` (versioning sederhana). */
async function ensureRecipeRow(recipe: RecipeConfig): Promise<number> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const existing = await db
      .select()
      .from(recipes)
      .where(eq(recipes.id, recipe.id))
      .orderBy(recipes.version);
    const latest = existing[existing.length - 1];

    // Reuse jika config aktif identik (hindari bump versi tiap run).
    // Perbandingan memakai stringify kanonis karena round-trip jsonb
    // mengurutkan ulang kunci objek.
    if (latest && latest.active && stableStringify(latest.configJson) === stableStringify(recipe)) {
      return latest.version;
    }

    const version = latest ? latest.version + 1 : 1;
    try {
      await db
        .update(recipes)
        .set({ active: false })
        .where(eq(recipes.id, recipe.id));

      await db.insert(recipes).values({
        id: recipe.id,
        version,
        configJson: recipe,
        active: true,
      });
      return version;
    } catch {
      // Balapan dengan worker lain (index unik id+version): baca ulang
      // dan coba lagi dengan versi berikutnya.
    }
  }
  throw new ApiError(500, "RECIPE_SYNC_FAILED", "Failed to sync recipes. Try again.");
}

/**
 * Sinkronkan seluruh recipe dari config ke tabel `recipes` (seed idempoten).
 * Dipanggil saat startup & oleh skrip seed. Aman dijalankan berkali-kali.
 */
export async function syncRecipes(): Promise<number> {
  const config = getConfig();
  for (const recipe of config.recipes) {
    await ensureRecipeRow(recipe);
  }
  return config.recipes.length;
}

/**
 * Membuat run baru. Idempotent bila `idempotencyKey` sama:
 * - key dipakai ulang dengan body identik → kembalikan run yang ada;
 * - key dipakai ulang dengan body berbeda → 409 IDempotency conflict;
 * - balapan insert konkuren → yang kalah membaca ulang baris pemenang
 *   (bukan error 500), karena `idempotency_key` UNIQUE di database.
 * Recipe media (requires_confirmation) berhenti di AWAITING_CONFIRMATION.
 *
 * Kuota trial (params.trial) dipakai LEBIH DULU untuk semua wallet, apa pun
 * saldonya. Teks dan media memakai anggaran terpisah (`free_runs` untuk run
 * `streaming`, `free_media_attempts` untuk formasi media) karena biaya provider
 * media jauh di atas teks. Bila anggaran habis dan saldo tidak cukup, run
 * ditolak 402. Klaim kuota + insert run berada di satu transaksi, sehingga insert
 * yang gagal tidak menghanguskan percobaan.
 */
export async function createRun(input: CreateRunInput): Promise<CreatedRun> {
  const recipe = getRecipe(input.recipeId);
  if (!recipe) {
    throw new ApiError(404, "RECIPE_NOT_FOUND", `Recipe not found: ${input.recipeId}`);
  }

  // Replay idempotent dicek SEBELUM klaim kuota: retry dengan
  // `Idempotency-Key` yang sama tidak boleh menambah percobaan trial.
  if (input.idempotencyKey) {
    const replay = await replayRun(input.projectId, input.idempotencyKey, recipe, input.input);
    if (replay) return replay;
  }

  // Guard ketersediaan: formasi yang provider-nya belum dikonfigurasi ditolak
  // di depan (tanpa charge, tanpa baris run) alih-alih dibiarkan gagal di tengah
  // jalan. Ditaruh setelah replay idempotent supaya retry run lama tetap
  // mengembalikan run itu, dan sebelum transaksi supaya tidak ada efek samping.
  if (!isRecipeAvailable(recipe)) {
    throw new ApiError(503, "FORMATION_UNAVAILABLE", FORMATION_UNAVAILABLE_MESSAGE);
  }

  const estimate = estimateRecipe(recipe);
  const params = getParams();

  // Sinkronisasi recipe memakai koneksi global (bukan `tx`), jadi dijalankan di
  // luar transaksi klaim.
  const version = await ensureRecipeRow(recipe);
  const status = recipe.pricing.requires_confirmation ? "AWAITING_CONFIRMATION" : "CREATED";

  try {
    return await db.transaction(async (tx) => {
      // Kunci baris project: menutup balapan antar-request bersamaan saat
      // menghitung kuota (pola sama seperti reservasi di billing/ledger.ts).
      await lockProject(tx, input.projectId);
      const balance = await currentBalance(tx, input.projectId);

      const trial = await readTrialState(
        tx,
        input.projectId,
        params.trial.free_runs,
        params.trial.max_attempts,
      );

      // Kuota gratis dipakai LEBIH DULU untuk semua wallet, apa pun saldonya.
      // Batas `max_attempts` adalah penjaga biaya platform, jadi ia hanya boleh
      // menutup jalur GRATIS — wallet bersaldo harus tetap bisa membelanjakan
      // credit-nya sendiri.
      //
      // Teks dan media adalah DUA anggaran mandiri (§2): formasi media tidak ikut
      // memakan kuota teks, sehingga menghabiskan 10 prompt teks tidak membuat
      // jatah media menjadi stok mati.
      const isMedia = recipe.mode !== "streaming";
      const mediaSlotLeft = !isMedia || trial.mediaAttempts < params.trial.free_media_attempts;
      const textSlotLeft = trial.textUsed < trial.limit;
      const trialAvailable =
        trial.attempts < trial.maxAttempts && (isMedia ? mediaSlotLeft : textSlotLeft);

      let isTrial = false;
      if (trialAvailable) {
        isTrial = true;
      } else if (balance < estimate.reserveMicro) {
        // Tolak sinkron bila saldo di bawah reservasi estimasi (brief §9.2):
        // 402 + link top-up, sebelum run dibuat. Pemeriksaan async di runner
        // tetap menjadi otoritas akhir bila saldo berubah di tengah jalan.
        //
        // `TRIAL_MEDIA_EXHAUSTED` HANYA dipakai saat jatah media habis tapi kuota
        // teks masih ada: hanya pada kasus itu klaim "text prompts are still free"
        // benar. Kalau keduanya habis, `TRIAL_EXHAUSTED` yang jujur.
        let code = "TRIAL_EXHAUSTED";
        if (trial.attempts >= trial.maxAttempts) {
          code = "TRIAL_ATTEMPTS_EXHAUSTED";
        } else if (isMedia && !mediaSlotLeft && textSlotLeft) {
          code = "TRIAL_MEDIA_EXHAUSTED";
        }
        const message =
          code === "TRIAL_ATTEMPTS_EXHAUSTED"
            ? "Free trial attempts used up. Top up to continue."
            : code === "TRIAL_EXHAUSTED"
              ? "Free prompts used up. Top up to continue."
              : "Free media allowance used up. Text prompts are still free — top up to run this formation.";
        throw new ApiError(402, code, message, { topup_url: "/app/balance", trial });
      }

      // Percakapan dibuka DI SINI, bukan menunggu runner: dengan begitu chat
      // langsung terdaftar di riwayat walau run berhenti di AWAITING_CONFIRMATION
      // atau gagal sebelum settle. Id dibuat server bila pemanggil tidak
      // mengirimnya, sehingga klien tidak perlu (dan tidak bisa) menebak id.
      const conversationId =
        input.conversationId ?? (input.openConversation === false ? null : newId("conv"));
      if (conversationId) {
        await ensureConversation(input.projectId, conversationId, input.input, tx);
      }

      const inserted = await tx
        .insert(runs)
        .values({
          id: newId("run"),
          projectId: input.projectId,
          recipeId: recipe.id,
          recipeVersion: version,
          status,
          mode: recipe.mode,
          conversationId,
          input: input.input,
          isTrial,
          idempotencyKey: input.idempotencyKey ?? newId("idem"),
        })
        .returning();

      return { run: inserted[0], recipe, estimate, isTrial, conversationId, replayed: false };
    });
  } catch (error) {
    // Penolakan kuota (402) harus diteruskan apa adanya.
    if (error instanceof ApiError) throw error;
    // Balapan dengan request lain yang memakai key sama: baca ulang pemenang.
    // Bila baris tetap tidak ada, lempar ulang error asli.
    if (input.idempotencyKey) {
      const replay = await replayRun(input.projectId, input.idempotencyKey, recipe, input.input);
      if (replay) return replay;
    }
    throw new ApiError(500, "RUN_CREATE_FAILED", "Failed to create the run. Try again.");
  }
}

/** Samakan body idempotency dengan baris yang sudah ada (409 bila konflik). */
async function replayRun(
  projectId: string,
  idempotencyKey: string,
  recipe: RecipeConfig,
  input: string,
): Promise<CreatedRun | null> {
  const existing = await db
    .select()
    .from(runs)
    .where(and(eq(runs.projectId, projectId), eq(runs.idempotencyKey, idempotencyKey)))
    .limit(1);
  const row = existing[0];
  if (!row) return null;
  if (row.recipeId !== recipe.id || row.input !== input) {
    throw new ApiError(
      409,
      "IDEMPOTENCY_CONFLICT",
      "Idempotency-Key was already used with a different request body.",
    );
  }
  return {
    run: row,
    recipe,
    estimate: estimateRecipe(recipe),
    isTrial: row.isTrial,
    conversationId: row.conversationId,
    replayed: true,
  };
}

export function getRun(runId: string): Promise<RunRow | undefined> {
  return db.select().from(runs).where(eq(runs.id, runId)).limit(1).then((rows) => rows[0]);
}
