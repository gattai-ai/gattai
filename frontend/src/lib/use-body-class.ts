import { useEffect } from "react";

/**
 * Pasang kelas pada `<body>` selama `active` bernilai benar, dan selalu
 * membuangnya saat komponen unmount atau `active` berubah.
 *
 * Ini menutup bug scroll: `AppShell` dulu memanggil
 * `body.classList.toggle("chatmode", ...)` tanpa cleanup. Saat berpindah dari
 * `/app/chat` ke halaman lain, `AppShell` unmount tetapi kelas `chatmode`
 * tertinggal; CSS `body.chatmode{height:100vh;overflow:hidden}` membuat halaman
 * tujuan tidak bisa di-scroll sampai reload.
 */
export function useBodyClass(name: string, active: boolean): void {
  useEffect(() => {
    if (!active) return;
    document.body.classList.add(name);
    return () => document.body.classList.remove(name);
  }, [name, active]);
}
