# Shared Layer

Workspace ini berisi kode yang dibagikan antara **frontend**, **backend**, dan skrip utilitas.

Di sinilah semua alamat kontrak dan data chain diletakkan agar proyek memiliki *single source of truth*.

## Struktur

- `chains/index.ts` - Daftar jaringan (EVM) yang didukung. Diimpor oleh frontend wagmi.
- `contracts/abis/` - ABI TypeScript (dihasilkan otomatis oleh skrip sinkronisasi).
- `contracts/addresses.ts` - Alamat kontrak per chain ID (dihasilkan otomatis).
- `types/` - Tipe TypeScript yang dibagikan frontend & backend.

Jangan edit file di dalam `contracts/` secara manual. File-file tersebut ditimpa setiap kali Anda menjalankan `bun run sync`.
