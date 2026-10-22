import { QueryClient } from "@tanstack/react-query";

/**
 * QueryClient default untuk aplikasi.
 *
 * Catatan: jangan pernah masukkan data sensitif (private key, seed phrase,
 * tanda tangan) ke cache react-query, karena cache ini terkirim ke browser.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Data on-chain berubah setelah transaksi dikonfirmasi, jadi refetch
      // saat window difokuskan ulang berguna.
      refetchOnWindowFocus: true,
      retry: 1,
    },
  },
});
