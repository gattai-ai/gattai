# GATTAI Frontend

Web app GATTAI: React + Vite + TypeScript, memakai wagmi v3 + viem v2
untuk wallet dan `@tanstack/react-query` untuk data server. Visual (CSS, font,
SVG, animasi) di-vendor 1:1 dari `gattai-site/` (folder sumber read-only, tidak
diubah); lapisan demo (`localStorage` berisi data acak, angka preview) diganti
data backend nyata.

> *Mesin-mesin terpisah. Satu formasi.* Satu key, model-model AI yang bekerja
> bersama menjadi satu hasil. Settlement di Robinhood Chain, ditenagai $GATTAI.

## Menjalankan (dev)

```bash
# 1) Backend (port 3000). Pastikan DATABASE_URL + migrasi sudah siap.
bun run dev:backend

# 2) Frontend (port 5173)
bun run dev:frontend
```

Frontend memanggil API lewat path relatif `/api`, yang **di-proxy Vite** ke
backend (lihat `vite.config.ts`, target default `http://localhost:3000`). Ini
membuat cookie sesi SIWE terkirim same-origin dan `EventSource` (SSE) tetap
terautentikasi: `EventSource` tidak bisa menyetel header `Authorization`.

### Login (SIWE)

Auth memakai SIWE (EIP-4361). Frontend menyusun pesan dengan
`domain = window.location.host`. Karena itu **daftar host di backend
(`SIWE_DOMAIN`) harus memuat host frontend**, mis.
`SIWE_DOMAIN=localhost:5173,localhost:5174` saat dev (boleh juga dikosongkan
supaya mengikuti `FRONTEND_URL` — lihat `backend/.env.example`). Beberapa host
boleh didaftarkan sekaligus, tetapi **tidak boleh `*`**: wildcard berarti domain
mana pun (termasuk milik penyerang) boleh memakai nonce kita. Tanda tangan hanya
untuk login, tanpa transaksi dan tanpa gas.

> Sesi disimpan pada cookie `__Host-` **tanpa atribut `Domain`**, jadi terikat
> ke satu host: login di `www.gattai.tech` tidak membuat Anda login di
> `gattai.tech`. Vercel mengarahkan apex `gattai.tech` → `www.gattai.tech`
> (308), dan `vercel.json` mengunci aturan yang sama, supaya hanya satu host
> yang melayani app; kalau kelak dua host benar-benar aktif, daftarkan keduanya
> di `SIWE_DOMAIN` + `FRONTEND_URL` (sesinya tetap terpisah per host).

## Struktur

```
src/
├── site/               # Port situs statis (visual 1:1, data nyata)
│   ├── site.css        # Gaya bersama (vendor gattai-site)
│   ├── landing.css / app.css / burns.css / docs.css / legal.css
│   ├── SiteDefs.tsx    # Definisi SVG global (logo, gradien, mecha)
│   ├── MarketingLayout.tsx  # Nav + ruler + footer (/, /burns, /docs, /legal)
│   ├── siteFx.ts       # Toast, copy, reveal, counter
│   ├── useSite.ts      # useSiteReveal, useDocumentTitle
│   ├── pages/          # LandingPage, BurnsPage, DocsPage, LegalPage
│   └── app/            # AppShell + Chat/Gallery/Balance/Keys/Usage + galleryStore + cap
├── features/
│   ├── chat/           # useRunStream (SSE) + useRecipes
│   └── balance/        # useBalance
├── lib/
│   ├── api.ts          # Klien fetch (credentials: include)
│   ├── router.tsx      # RouterProvider + Link
│   ├── router-context.ts  # useRouter + matchPath + resolveLegacy (tanpa komponen)
│   ├── session.tsx     # SessionProvider
│   ├── session-store.ts# Konteks + fetch sesi
│   ├── use-session.ts  # useSession / useLogin / useLogout
│   └── format.ts       # Pemformat credits/USD/alamat/tanggal
└── providers/
    └── Web3Provider.tsx # wagmi + react-query
```

Rute mengikuti situs statis: `/` landing, `/app/chat`, `/app/gallery`,
`/app/balance`, `/app/keys`, `/app/usage`, `/burns`, `/docs`, `/legal`.
Tautan legacy `*.html` dan hash (`app.html#keys`, `docs.html#burns`) di-redirect
otomatis oleh router. Halaman dipisah komponen vs hook agar Fast Refresh tetap
bekerja (`eslint-plugin-react-refresh`).

## Environment

Hanya variabel `VITE_*` yang boleh ditaruh di `.env` frontend, nilainya
terekspos di bundle browser. **Jangan** menaruh secret provider di sini.
Lihat `.env.example`.

| Variabel | Default | Keterangan |
|---|---|---|
| `VITE_API_URL` | `/api` | Base URL API. **Biarkan kosong** di produksi: rewrite same-origin yang dipakai. |
| `VITE_API_PROXY` | `http://localhost:3000` | Target proxy Vite saat dev. |

## Streaming chat

1. `POST /v1/runs` dengan `{ recipe_id, input, history? }`.
2. Bila `AWAITING_CONFIRMATION` (recipe media), tampilkan estimasi lalu
   `POST /v1/runs/{id}/confirm`.
3. Buka SSE `GET /v1/runs/{id}/events`: event `delta` (potongan teks),
   `step_pending`/`step_complete` (biaya per step), lalu `done`.
4. Setelah `done`, ambil `GET /v1/runs/{id}` untuk output final + biaya.

## Skrip

```bash
bun run --cwd frontend dev        # dev server
bun run --cwd frontend build      # typecheck + build produksi
bun run --cwd frontend typecheck
bun run --cwd frontend lint
```

## Deploy

Target produksi: **Vercel**, dengan Root Directory = `frontend/`. Konfigurasi
ada di `frontend/vercel.json` (satu-satunya `vercel.json` di repo ini):

- `/api/:path*` → backend Railway (rewrite), sehingga frontend dan API
  **same-origin**;
- sisanya (`/(.*)`) → `/index.html` (fallback SPA).

Same-origin bersifat wajib: cookie sesi SIWE dipasang `SameSite=Lax` sehingga
tidak terkirim bila frontend memanggil origin API langsung (cross-origin).
**Jangan** set `VITE_API_URL` ke origin API di produksi — biarkan relatif
(`/api`) agar rewrite yang bekerja. Backend mengenali host frontend lewat
`FRONTEND_URL`/`SIWE_DOMAIN`.

`public/_redirects` disediakan bila build statis (`dist/`) di-host di
Cloudflare Pages/Netlify (fallback SPA `/* /index.html 200`), tapi Vercel adalah
target utamanya.
