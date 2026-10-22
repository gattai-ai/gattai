import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useSession } from "@/lib/use-session";
import type { BalanceResponse } from "@/lib/types";

/** Saldo + lot credits project aktif. Auto-refresh ringan. */
export function useBalance() {
  const { session } = useSession();
  return useQuery({
    queryKey: ["balance", session?.projectId],
    queryFn: () => api<BalanceResponse>("/v1/balance"),
    enabled: Boolean(session),
    refetchInterval: 30_000,
  });
}
