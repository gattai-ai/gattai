import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { RecipesResponse } from "@/lib/types";

/**
 * Daftar recipe + estimasi harga dari backend (config-driven).
 *
 * `enabled` dipakai pemanggil untuk menahan query selama belum login:
 * `/v1/recipes` butuh sesi (`requireProject` pada route). Tanpa penahan, query
 * menembak saat belum login, gagal 401, dan hasil kosong itu ikut ter-cache —
 * inilah sebab formasi baru muncul setelah refresh, bukan langsung setelah
 * login (bug "formasi hilang setelah login").
 */
export function useRecipes(enabled = true) {
  return useQuery({
    queryKey: ["recipes"],
    queryFn: () => api<RecipesResponse>("/v1/recipes"),
    staleTime: 5 * 60_000,
    enabled,
  });
}
