import { and, eq } from "drizzle-orm";
import { getConfig, getParams, getRecipe, type RecipeConfig } from "../config";
import { db } from "../db";
import { recipes, runs } from "../db/schema";
import { currentBalance, lockProject } from "../billing/ledger";
import { estimateRecipe, type RecipeEstimate } from "../billing/estimate";
import { readTrialState } from "../billing/trial";
import { checkHolderEligibility } from "../holder/service";
import { newId } from "../lib/id";
import { ApiError } from "../lib/http";
import {
  FORMATION_UNAVAILABLE_MESSAGE,
  isRecipeAvailable,
} from "./availability";
import { ensureConversation } from "../services/conversations";
import { getProjectById } from "../services/projects";

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
  /** Run ini dibiayai kuota holder tier, bukan credit berbayar. */
  isHolder: boolean;
  /** ID tier holder yang membiayai run ini, bila ada. */
  holderTier: string | null;
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
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Sinkronkan definisi recipe dari YAML ke tabel `recipes` (idempotent).
 *
 * Bila config berbeda dari versi aktif di DB, insert versi baru (version + 1)
 * dan nonaktifkan versi lama. Run lama tetap menunjuk versi lama yang
 * memproduksinya, sehingga riwayat tetap bisa direproduksi.
 */
export async function syncRecipes(): Promise<void> {
  const fileRecipes = getConfig().recipes;
  for (const recipe of fileRecipes) {
    const existing = await db
      .select()
      .from(recipes)
      .where(and(eq(recipes.id, recipe.id), eq(recipes.active, true)))
      .limit(1);

    const current = existing[0];
    const canonicalNew = stableStringify(recipe);
    const canonicalOld = current ? stableStringify(current.configJson) : null;

    if (!current) {
      await db.insert(recipes).values({
        id: recipe.id,
        version: 1,
        configJson: recipe,
        active: true,
      });
      continue;
    }

    if (canonicalNew !== canonicalOld) {
      const nextVersion = current.version + 1;
      await db.transaction(async (tx) => {
        await tx
          .update(recipes)
          .set({ active: false })
          .where(and(eq(recipes.id, recipe.id), eq(recipes.version, current.version)));
        await tx.insert(recipes).values({
          id: recipe.id,
          version: nextVersion,
          configJson: recipe,
          active: true,
        });
      });
    }
  }
}

/** Ambil versi aktif sebuah recipe dari DB. */
export async function getActiveRecipeVersion(recipeId: string): Promise<number> {
  const row = await db
    .select({ version: recipes.version })
    .from(recipes)
    .where(and(eq(recipes.id, recipeId), eq(recipes.active, true)))
    .limit(1);
  return row[0]?.version ?? 1;
}

/**
 * Buat run baru di DB (status CREATED atau AWAITING_CONFIRMATION).
 *
 * Idempotency dijamin oleh index `(project_id, idempotency_key)`: bila key sudah
 * pernah dipakai di project ini dengan body yang sama, baris lama dikembalikan
 * apa adanya (`replayed: true`), tanpa menagih atau mengeksekusi ulang.
 *
 * Bila saldo kurang dari `min(deposit_minimum, estimasi_maksimal)`, run
 * DITOLAK di sini (402 PAYMENT_REQUIRED) sebelum menyentuh runner — tidak ada
 * run CREATED yang sengaja dibuat untuk langsung gagal.
 */
export async function createRun(input: CreateRunInput): Promise<CreatedRun> {
  const recipe = getRecipe(input.recipeId);
  if (!recipe) {
    throw new ApiError(404, "RECIPE_NOT_FOUND", `Recipe not found: ${input.recipeId}`);
  }

  // Guard: tolak pembuatan run untuk formasi yang provider-nya belum siap.
  // Pesan dibedakan antara formasi teks vs media supaya transparan ke user.
  if (!isRecipeAvailable(recipe)) {
    throw new ApiError(503, "FORMATION_UNAVAILABLE", FORMATION_UNAVAILABLE_MESSAGE);
  }

  const estimate = estimateRecipe(recipe);
  const version = await getActiveRecipeVersion(recipe.id);
  const status = recipe.pricing.requires_confirmation ? "AWAITING_CONFIRMATION" : "CREATED";

  // Ambil project SEBELUM transaksi. ownerWallet tidak berubah, dan memakai
  // koneksi pool kedua di dalam transaksi yang sudah memegang row lock bisa
  // menyebabkan pool exhaustion saat banyak request bersamaan.
  const project = await getProjectById(input.projectId);

  try {
    return await db.transaction(async (tx) => {
      // Kunci project selama pemeriksaan saldo + pembuatan run; dengan begitu
      // dua request bersamaan tidak bisa saling mendahului membaca saldo lama.
      await lockProject(tx, input.projectId);
      const balance = await currentBalance(tx, input.projectId);
      const params = getParams();
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
      let isHolder = false;
      let holderTier: string | null = null;
      let holderReason: string | null = null;

      if (trialAvailable) {
        isTrial = true;
      } else {
        // Cek kelayakan tier holder jika trial sudah habis. Pemeriksaan memakai
        // transaksi yang sama dengan pembuatan run sehingga kuota dibaca
        // konsisten dengan baris run yang akan dibuat.
        if (project) {
          const holderCheck = await checkHolderEligibility(
            project.ownerWallet,
            input.projectId,
            isMedia,
            tx,
          );
          holderReason = holderCheck.reason ?? null;
          if (holderCheck.eligible && holderCheck.tierId) {
            isHolder = true;
            holderTier = holderCheck.tierId;
          }
        }
      }

      if (!isTrial && !isHolder && balance < estimate.reserveMicro) {
        const topup = { topup_url: "/app/balance", trial };

        // Pesan harus mencerminkan alasan sebenarnya. User holder yang kuota
        // atau anggaran hariannya habis tidak boleh diberi pesan "trial habis".
        if (holderReason === "HOLDER_BUDGET_EXHAUSTED") {
          throw new ApiError(
            402,
            "HOLDER_BUDGET_EXHAUSTED",
            "Holder free runs are paused for today. Top up to continue.",
            topup,
          );
        }
        if (
          holderReason === "HOLDER_TEXT_QUOTA_EXHAUSTED" ||
          holderReason === "HOLDER_MEDIA_QUOTA_EXHAUSTED"
        ) {
          throw new ApiError(
            402,
            "HOLDER_QUOTA_EXHAUSTED",
            "Daily holder free-run quota used up. Top up to continue.",
            topup,
          );
        }
        if (holderReason === "HOLDER_RUNS_PAUSED") {
          throw new ApiError(
            402,
            "HOLDER_RUNS_PAUSED",
            "Holder free runs are temporarily paused. Top up to continue.",
            topup,
          );
        }

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
        throw new ApiError(402, code, message, topup);
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
          isHolder,
          holderTier,
          idempotencyKey: input.idempotencyKey ?? newId("idem"),
        })
        .returning();

      return {
        run: inserted[0],
        recipe,
        estimate,
        isTrial,
        isHolder,
        holderTier,
        conversationId,
        replayed: false,
      };
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
    isHolder: row.isHolder,
    holderTier: row.holderTier,
    conversationId: row.conversationId,
    replayed: true,
  };
}

export function getRun(runId: string): Promise<RunRow | undefined> {
  return db.select().from(runs).where(eq(runs.id, runId)).limit(1).then((rows) => rows[0]);
}
