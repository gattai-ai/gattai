import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { useConnection } from "wagmi";
import { clearStaleAccountQueries } from "./account-cache";
import { showToast } from "@/site/siteFx";
import { useLogout } from "./use-session";
import {
  SESSION_KEY,
  SessionContext,
  fetchSession,
  type SessionContextValue,
} from "./session-store";

/**
 * Menyediakan state sesi SIWE. Hook (useSession/useLogin/useLogout) ada di
 * ./use-session agar file ini hanya mengekspor komponen (Fast Refresh).
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const { address } = useConnection();
  const { logout, error: logoutError } = useLogout();
  const { data, isLoading } = useQuery({
    queryKey: SESSION_KEY,
    queryFn: fetchSession,
    // Error selain 401 (jaringan/5xx) hanya dicoba ulang sekali: kegagalan
    // sesaat tidak boleh langsung tampak seperti "belum login".
    retry: 1,
    staleTime: 30_000,
  });

  const projectId = data?.projectId;
  const sessionAddress = data?.address;

  // Identitas sesi berubah (logout, login wallet lain, ganti akun): buang sisa
  // cache akun lain supaya data wallet lama tidak pernah dirender atau dipakai.
  useEffect(() => {
    clearStaleAccountQueries(queryClient, projectId);
  }, [queryClient, projectId]);

  // Wallet yang terhubung harus sama dengan wallet pemilik sesi. Kalau pengguna
  // berganti akun di wallet-nya tanpa keluar, sesi lama tidak boleh terus dipakai
  // (kalau tidak, header menampilkan wallet baru sementara data memakai wallet lama).
  const reconciling = useRef(false);
  useEffect(() => {
    if (!sessionAddress || !address) return;
    if (sessionAddress.toLowerCase() === address.toLowerCase()) return;
    if (reconciling.current) return;
    reconciling.current = true;
    void logout().finally(() => {
      reconciling.current = false;
    });
  }, [sessionAddress, address, logout]);

  useEffect(() => {
    if (logoutError) showToast(logoutError);
  }, [logoutError]);

  const value = useMemo<SessionContextValue>(
    () => ({ session: data ?? null, isLoading }),
    [data, isLoading],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
