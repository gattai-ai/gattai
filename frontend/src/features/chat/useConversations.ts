import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api";
import { useSession } from "@/lib/use-session";
import type { ConversationDetailResponse, ConversationsResponse } from "@/lib/types";

/**
 * Riwayat percakapan project (hook tanpa komponen, ramah Fast Refresh).
 *
 * Daftar & transkrip dibaca dari backend; klien tidak menyimpan transkrip
 * sendiri, jadi membuka chat lama di perangkat/browser lain tetap utuh.
 */

/**
 * Daftar percakapan, urut aktivitas terbaru (backend yang mengurutkan).
 *
 * Berhalaman: backend hanya mengirim 30 baris sekali jalan, jadi halaman
 * berikutnya diambil lewat `next_cursor` (react-query yang menyatukan halaman).
 *
 * `search` (opsional) memfilter menurut judul atau isi prompt. Nilainya ikut
 * menjadi bagian query key, sehingga hasil pencarian di-cache terpisah dan
 * `keepPreviousData` menjaga daftar lama tetap tampil saat pencarian berubah.
 */
export function useConversations(search = "") {
  const { session } = useSession();
  const query = search.trim();
  return useInfiniteQuery({
    queryKey: ["conversations", session?.projectId, query],
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams();
      if (query) params.set("q", query);
      if (pageParam) params.set("cursor", pageParam);
      const suffix = params.toString();
      return api<ConversationsResponse>(`/v1/conversations${suffix ? `?${suffix}` : ""}`);
    },
    initialPageParam: null as string | null,
    // `null` dari server berarti sudah habis; react-query hanya mengenali
    // `undefined` sebagai "tidak ada halaman berikutnya".
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    enabled: Boolean(session),
    staleTime: 15_000,
    placeholderData: keepPreviousData,
  });
}

/** Transkrip satu percakapan. `id` null (chat baru) mematikan query. */
export function useConversation(id: string | null) {
  const { session } = useSession();
  return useQuery({
    queryKey: ["conversation", session?.projectId, id],
    queryFn: () => api<ConversationDetailResponse>(`/v1/conversations/${id}`),
    enabled: Boolean(session && id),
    staleTime: 15_000,
    // 404 berarti percakapan tidak ada / bukan milik project ini: mengulanginya
    // hanya membuang request, sedangkan error lain (jaringan) tetap layak dicoba.
    retry: (failureCount, error) =>
      !(error instanceof ApiError && error.status === 404) && failureCount < 1,
  });
}

/** Ganti judul percakapan (aksi di halaman History). */
export function useRenameConversation() {
  const client = useQueryClient();
  const { session } = useSession();
  return useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) =>
      api<{ conversation: { id: string; title: string | null } }>(`/v1/conversations/${id}`, {
        method: "PATCH",
        body: { title },
      }),
    onSuccess: (_result, variables) => {
      // Daftar menampilkan judul; transkrip menyimpannya juga (dipakai bila
      // ChatView kelak menampilkannya) sehingga cache-nya ikut disegarkan.
      void client.invalidateQueries({ queryKey: ["conversations"] });
      // Key transkrip memuat projectId, jadi prefix-nya harus ikut lengkap.
      void client.invalidateQueries({ queryKey: ["conversation", session?.projectId, variables.id] });
    },
  });
}

/** Hapus percakapan (aksi di halaman History, setelah konfirmasi). */
export function useDeleteConversation() {
  const client = useQueryClient();
  const { session } = useSession();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/v1/conversations/${id}`, { method: "DELETE" }),
    onSuccess: (_result, id) => {
      void client.invalidateQueries({ queryKey: ["conversations"] });
      // Transkrip yang sudah tidak ada tidak perlu menggantung di cache.
      client.removeQueries({ queryKey: ["conversation", session?.projectId, id] });
    },
  });
}
