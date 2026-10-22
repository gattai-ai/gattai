import { getConfig } from "../config";
import { isRecipeAvailable } from "./availability";

/**
 * Router ringan: menyarankan recipe berdasarkan prompt. Hasilnya hanya saran —
 * pengguna selalu bisa menggantinya, dan default tetap `refine`. Implementasi
 * heuristik dipilih agar tidak menambah biaya/panggilan model untuk routing.
 *
 * Hanya formasi yang siap jalan yang boleh disarankan: `auto` tidak boleh
 * mengarahkan pengguna ke formasi "coming soon" (provider belum dikonfigurasi),
 * karena `createRun` akan menolaknya dengan 503.
 */

interface Rule {
  recipe: string;
  keywords: string[];
  weight?: number;
}

const RULES: Rule[] = [
  { recipe: "video", keywords: ["video", "clip", "reel", "shot", "veo", "kling", "animasi", "b-roll"] },
  { recipe: "visual", keywords: ["gambar", "image", "logo", "banner", "ilustrasi", "illustration", "pfp", "poster", "thumbnail"] },
  { recipe: "launch_kit", keywords: ["launch kit", "launch", "thread", "one-pager", "bio", "go-to-market", "gtm", "peluncuran"] },
  { recipe: "research", keywords: ["riset", "research", "sumber", "sources", "sitasi", "citation", "laporan", "analisis pasar", "market analysis"] },
  { recipe: "code", keywords: ["kode", "code", "function", "fungsi", "bug", "refactor", "react", "typescript", "python", "api", "script", "komponen"] },
];

export function suggestRecipe(prompt: string): string {
  const text = prompt.toLowerCase();
  let best = "refine";
  let bestScore = 0;

  const available = new Set(
    getConfig()
      .recipes.filter(isRecipeAvailable)
      .map((recipe) => recipe.id),
  );

  for (const rule of RULES) {
    if (!available.has(rule.recipe)) continue;
    const score = rule.keywords.reduce(
      (acc, keyword) => (text.includes(keyword) ? acc + (rule.weight ?? 1) : acc),
      0,
    );
    if (score > bestScore) {
      bestScore = score;
      best = rule.recipe;
    }
  }

  return best;
}
