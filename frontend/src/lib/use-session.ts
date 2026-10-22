import { useCallback, useContext, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { createSiweMessage } from "viem/siwe";
import { useConnection, useSignMessage } from "wagmi";
import { api } from "./api";
import { isUserRejection, walletErrorMessage } from "./wallet-error";
import { SESSION_KEY, SessionContext, type SessionContextValue } from "./session-store";

/** Hook sesi SIWE. */

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession must be used inside <SessionProvider>.");
  return value;
}

export interface LoginState {
  login: () => Promise<void>;
  isPending: boolean;
  error: string | null;
}

/** Login SIWE: ambil nonce → tanda tangani pesan → verifikasi ke backend. */
export function useLogin(): LoginState {
  const queryClient = useQueryClient();
  const { address, chainId } = useConnection();
  const { mutateAsync: signMessageAsync } = useSignMessage();
  const [isPending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const login = useCallback(async () => {
    setError(null);
    if (!address || chainId === undefined) {
      setError("Connect a wallet first.");
      return;
    }
    setPending(true);
    try {
      const { nonce } = await api<{ nonce: string }>("/auth/nonce");
      const message = createSiweMessage({
        address,
        chainId,
        domain: window.location.host,
        uri: window.location.origin,
        nonce,
        version: "1",
        statement: "Sign in to GATTAI with your wallet.",
        issuedAt: new Date(),
        // Batas waktu tanda tangan = TTL nonce server (5 menit). Server menolak
        // pesan kedaluwarsa, jadi tanda tangan yang bocor tidak bisa dipakai
        // ulang belakangan (selain nonce yang sudah sekali pakai).
        expirationTime: new Date(Date.now() + 5 * 60 * 1000),
      });
      const signature = await signMessageAsync({ message });
      await api("/auth/verify", { method: "POST", body: { message, signature } });
      await queryClient.invalidateQueries({ queryKey: SESSION_KEY });
    } catch (cause) {
      if (!isUserRejection(cause)) {
        setError(walletErrorMessage(cause, "Sign-in failed. Try again."));
      }
    } finally {
      setPending(false);
    }
  }, [address, chainId, signMessageAsync, queryClient]);

  return { login, isPending, error };
}

interface RevokeState {
  /** `true` bila server mengonfirmasi sesi ditutup; `false` bila tak terjangkau. */
  revoke: () => Promise<boolean>;
  isPending: boolean;
  error: string | null;
}

/**
 * Inti "tutup sesi di server, lalu pastikan state klien ikut kosong".
 *
 * Dipakai bersama `useLogout` dan `useLogoutAll` supaya keduanya tidak pernah
 * berbeda perilaku.
 *
 * Kerapuhan lama: kegagalan request ditelan `try/finally`, `["session"]` hanya
 * di-*invalidate* (bukan dibuang), dan cache data akun tidak disentuh — sehingga
 * UI bisa tampak "keluar" (karena `disconnect()` wallet) sementara sesi masih
 * hidup dan prompt masih bisa dikirim. Sekarang:
 *
 *  - request gagal → kembalikan `false` + pesan; state dibiarkan apa adanya
 *    supaya UI tidak berbohong (masih masuk = masih terlihat masuk);
 *  - request berhasil → cookie sudah hilang, jadi buang sesi lokal lebih dulu
 *    agar UI tidak menampilkan "masih masuk" walau `/auth/me` tak sempat dijawab;
 *  - sisa cache akun dibuang otomatis oleh efek di `SessionProvider` saat
 *    `projectId` berubah.
 */
function useSessionRevoke(path: string, failureMessage: string): RevokeState {
  const queryClient = useQueryClient();
  const [isPending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const revoke = useCallback(async (): Promise<boolean> => {
    setPending(true);
    setError(null);

    try {
      await api(path, { method: "POST" });
    } catch (cause) {
      setError(walletErrorMessage(cause, failureMessage));
      setPending(false);
      return false;
    }

    // Cookie sesi sudah dihapus server: buang sesi lokal lebih dulu supaya UI
    // langsung keluar, lalu biarkan query aktif mengambil /auth/me untuk konfirmasi.
    queryClient.removeQueries({ queryKey: SESSION_KEY });
    try {
      await queryClient.invalidateQueries({ queryKey: SESSION_KEY });
    } catch {
      // `/auth/me` tak terjangkau: sesi lokal sudah dibuang, query akan mencoba lagi.
    } finally {
      setPending(false);
    }
    return true;
  }, [path, failureMessage, queryClient]);

  return { revoke, isPending, error };
}

export interface LogoutState {
  /** `true` bila server mengonfirmasi sesi ditutup; `false` bila tak terjangkau. */
  logout: () => Promise<boolean>;
  isPending: boolean;
  error: string | null;
}

/** Logout perangkat ini saja (`POST /auth/logout`). */
export function useLogout(): LogoutState {
  const { revoke, isPending, error } = useSessionRevoke("/auth/logout", "Could not sign out. Try again.");
  return { logout: revoke, isPending, error };
}

export interface LogoutAllState {
  /** `true` bila semua sesi project dicabut (termasuk perangkat ini). */
  logoutAll: () => Promise<boolean>;
  isPending: boolean;
  error: string | null;
}

/**
 * "Sign out everywhere": cabut SEMUA sesi project, termasuk perangkat ini
 * (`POST /auth/logout-all`). Untuk kasus "wallet mungkin dipakai di perangkat
 * lain / sesi lama masih hidup".
 */
export function useLogoutAll(): LogoutAllState {
  const { revoke, isPending, error } = useSessionRevoke(
    "/auth/logout-all",
    "Could not sign out everywhere. Try again.",
  );
  return { logoutAll: revoke, isPending, error };
}
