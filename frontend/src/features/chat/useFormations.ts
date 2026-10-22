import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { FormationsResponse } from "@/lib/types";

/**
 * Ketersediaan formasi dari endpoint publik (`/v1/public/formations`).
 *
 * Dipakai landing page: pengunjung anonim tidak memuat `/v1/recipes` (butuh
 * sesi), padahal kartu formasi perlu tahu mana yang "coming soon". Backend tetap
 * sumber kebenaran tunggal (aturan yang sama dipakai `POST /v1/runs`), jadi
 * begitu provider media tersambung, badge itu hilang sendiri tanpa deploy
 * frontend — dan sebaliknya, formasi yang belum siap tidak bisa ditembus.
 */
export function useFormationAvailability() {
  return useQuery({
    queryKey: ["formations-availability"],
    queryFn: () => api<FormationsResponse>("/v1/public/formations"),
    staleTime: 5 * 60_000,
  });
}
