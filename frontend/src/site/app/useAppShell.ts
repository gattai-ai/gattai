import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useSession } from "@/lib/use-session";
import { useRouter, matchPath } from "@/lib/router-context";
import type { ApiKeyListResponse, ProjectInfo } from "@/lib/types";
import { useGalleryEntries } from "./galleryStore";

/** Hook khusus shell aplikasi (file tanpa komponen, ramah Fast Refresh). */

const VIEWS = ["chat", "history", "gallery", "balance", "keys", "usage"] as const;

export type AppViewId = (typeof VIEWS)[number];

export function useAppView(): AppViewId {
  const { location } = useRouter();
  for (const view of VIEWS) {
    if (matchPath(location, `/app/${view}`)) return view;
  }
  return "chat";
}

export function useProjectName(): string {
  const { session } = useSession();
  const { data } = useQuery({
    queryKey: ["project", session?.projectId],
    queryFn: () => api<ProjectInfo>("/v1/project"),
    enabled: Boolean(session),
    staleTime: 60_000,
  });
  // Tanpa sesi tidak ada project: jangan pernah menampilkan sisa cache akun lain.
  return (session ? data?.name : undefined) ?? "my-first-formation";
}

/**
 * Sisa kuota prompt gratis milik wallet.
 * `null` berarti belum termuat atau backend tidak mengirim blok `trial`.
 * Query key sama dengan `useProjectName`, jadi tidak menambah request.
 */
export function useTrialQuota(): {
  remaining: number;
  limit: number;
  mediaLeft: number | null;
  /** Sisa percobaan (termasuk yang gagal) sebelum batas anti-abuse menutup jalur gratis. */
  attemptsLeft: number;
} | null {
  const { session } = useSession();
  const { data } = useQuery({
    queryKey: ["project", session?.projectId],
    queryFn: () => api<ProjectInfo>("/v1/project"),
    enabled: Boolean(session),
    staleTime: 60_000,
  });
  const trial = session ? data?.trial : undefined;
  if (!trial) return null;
  const mediaLeft =
    trial.media_limit != null && trial.media_used != null
      ? Math.max(0, trial.media_limit - trial.media_used)
      : null;
  return {
    remaining: trial.remaining,
    limit: trial.limit,
    mediaLeft,
    attemptsLeft: Math.max(0, trial.attempts_limit - trial.attempts_used),
  };
}

export function useKeysCount(): number {
  const { session } = useSession();
  const { data } = useQuery({
    queryKey: ["keys", session?.projectId],
    queryFn: () => api<ApiKeyListResponse>("/v1/keys"),
    enabled: Boolean(session),
    staleTime: 30_000,
  });
  if (!session) return 0;
  return data?.keys.filter((key) => !key.revoked_at).length ?? 0;
}

export function useGalleryCount(): number {
  const { session } = useSession();
  const entries = useGalleryEntries();
  return session ? entries.length : 0;
}
