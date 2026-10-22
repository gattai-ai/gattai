import { createContext } from "react";
import { ApiError, api } from "./api";
import type { SessionResponse } from "./types";

/** State sesi SIWE (bagian non-komponen). */

export interface Session {
  projectId: string;
  address: string;
}

export const SESSION_KEY = ["session"] as const;

/**
 * Ambil identitas sesi saat ini.
 *
 * Hanya 401 yang berarti "belum login". Error lain (jaringan/5xx) dilempar
 * supaya react-query mempertahankan sesi terakhir yang diketahui dan mencoba
 * ulang — bukan menyimpulkan pengguna sudah keluar hanya karena backend hiccup.
 */
export async function fetchSession(): Promise<Session | null> {
  try {
    const data = await api<SessionResponse>("/auth/me");
    return { projectId: data.project.id, address: data.project.address };
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
}

export interface SessionContextValue {
  session: Session | null;
  isLoading: boolean;
}

export const SessionContext = createContext<SessionContextValue | null>(null);
