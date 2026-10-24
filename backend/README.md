# Backend GATTAI

API Hono + Drizzle ORM untuk produk GATTAI: orkestrasi recipe multi-model AI, billing credits, API key, autentikasi SIWE, deposit indexer onchain (Fase 2), serta epoch buyback & burn (Fase 3).

Referensi lengkap: [`docs/`](../docs/README.md).

## Menjalankan

```bash
cp backend/.env.example backend/.env   # isi DATABASE_URL, SESSION_SECRET, key provider
bun run --cwd backend db:create        # buat database bila belum ada
bun run --cwd backend db:migrate       # terapkan skema ke Postgres
bun run --cwd backend seed:dev         # (opsional) project + API key + 100 credits
bun run dev:backend                    # http://localhost:3000
```

Environment yang dibutuhkan ada di [`backend/.env.example`](./.env.example). Secret provider dibaca **lazy**, jadi server tetap start dan `/health` tetap jalan tanpa kredensial; error baru muncul saat provider dipanggil.

## Skrip

```bash
bun run --cwd backend dev              # server + watch
bun run --cwd backend typecheck        # tsc --noEmit
bun run --cwd backend lint             # eslint
bun run --cwd backend test             # bun test (butuh DATABASE_URL; pakai DB uji terpisah)
bun run --cwd backend build            # tsc + bundle
bun run --cwd backend db:create        # buat database dari DATABASE_URL
bun run --cwd backend db:generate      # buat migrasi dari schema
bun run --cwd backend db:migrate       # terapkan migrasi
bun run --cwd backend db:push          # langsung sinkron (dev)
bun run --cwd backend seed:dev         # seed project + API key + credits
bun run --cwd backend mock:providers   # server tiruan provider (tanpa API key asli)
bun run --cwd backend e2e:offline      # E2E penuh via mock provider
bun run --cwd backend indexer          # indexer deposit onchain (catch-up sekali)
bun run --cwd backend indexer --live   # indexer deposit (polling terus-menerus)
bun run --cwd backend indexer --from-block=12345
bun run --cwd backend burn             # worker epoch buyback & burn (dry-run; catat epoch `pending`)
bun run --cwd backend burn --live      # worker burn polling
bun run --cwd backend burn --mark-executed --period-start=<ISO> --tx=<hash> --tokens=<jumlah>
```

> Operasional worker: `indexer`/`burn` berjalan sebagai proses CLI terpisah
> (bukan di dalam server API). Di produksi jalankan `--live` via cron/scheduler
> (mis. Railway Cron) setelah kontrak ter-deploy; sebelum itu cukup manual
> per kebutuhan (catch-up + `--mark-executed`).

## Pengembangan tanpa API key (mock)

Karena API key provider mungkin belum tersedia, seluruh pipeline bisa dijalankan
lokal dengan mock server:

```bash
# terminal 1
bun run --cwd backend mock:providers   # http://localhost:4319

# terminal 2 — arahkan provider ke mock (lihat .env.example)
#   ANTHROPIC_API_URL=http://localhost:4319
#   OPENAI_API_URL=http://localhost:4319
#   PERPLEXITY_API_URL=http://localhost:4319
bun run --cwd backend e2e:offline      # atau `bun run dev:backend` + curl
```

## Deposit onchain (Fase 2)

Alur: user memanggil `DepositManager.deposit(projectId, token, amount)` di Robinhood
Chain → indexer membaca event `Deposited` → menunggu `DEPOSIT_CONFIRMATIONS` →
valuasi USD → buat `credit_lots` + entri ledger (idempotent per `(chain_tx, log_index)`).

```bash
# set ROBINHOOD_RPC_URL, DEPOSIT_MANAGER_ADDRESS, GATTAI_TOKEN_ADDRESS, USDG_TOKEN_ADDRESS,
# TREASURY_ADDRESS, CHAINLINK_ETH_USD_FEED di .env (lihat .env.example)
bun run --cwd backend indexer --from-block=<blok deploy DepositManager>   # catch-up
bun run --cwd backend indexer --live                                      # polling
```

Valuasi (fail-closed): ETH via Chainlink `latestRoundData`; USDG 1:1; GATTAI TWAP
(belum tersedia → deposit tetap `pending`, tidak dikreditkan). Cap maks per deposit
($1000) ditegakkan offchain → status `over_cap`. Diskon GATTAI 15% (config).
Harga manual `ETH_USD_PRICE`/`GATTAI_USD_PRICE` offchain **dimatikan default**.

**Fase 1 mainnet hanya USDG.** Set `DEPOSIT_ENABLED_SYMBOLS=USDG`; jangan isi
`GATTAI_TWAP_POOL`. `DepositManager.nativeAccepted` harus `false` sampai feed
ETH dan smoke test siap. `INDEXER_FROM_BLOCK` wajib block deploy, bukan 0/head.
Deposit `dust`/`over_cap`/`needs_review` dan dead-letter `unknown_project`
tidak dikreditkan; lihat antreannya dengan `bun run --cwd backend refund:queue`.

Batas biaya request: `MAX_REQUEST_CHARS`, `MAX_OUTPUT_TOKENS_PER_STEP`,
`MAX_PROVIDER_COST_USD_PER_RUN` (lihat `.env.example`).

`projectId` onchain = `keccak256(utf8(project.id))` (bytes32), disimpan di
`projects.onchain_id` dan di-backfill saat boot. Frontend bisa mengambilnya dari
`GET /v1/project`, dan konfigurasi top-up dari `GET /v1/public/deposits/config`.

## Buyback & burn (Fase 3)

Worker epoch menghitung **margin** per lot yang dikonsumsi dan mencatatnya di
`burn_epochs`:

```text
margin = max(0, charged − provider_cost)   # per run, lalu diatribusikan proporsional per lot
lot ETH/USDG → burn_budget += margin × BURN_SHARE_STABLE (30%)  → buyback Uniswap → burn
lot GATTAI   → burn_budget += margin × BURN_SHARE_TOKEN  (50%)  → burn langsung dari treasury
lot PROMO    → tidak menghasilkan margin
```

```bash
bun run --cwd backend burn                 # rencanakan semua epoch tertutup (dry-run → status `pending`)
bun run --cwd backend burn --live          # polling berkala
bun run --cwd backend burn --period-start=2026-09-01T00:00:00Z --period-end=2026-09-08T00:00:00Z
bun run --cwd backend burn --execute       # burn langsung via treasury EOA (butuh BURN_TREASURY_PRIVATE_KEY dll.)
bun run --cwd backend burn --mark-executed --period-start=<ISO> --tx=0x... --tokens=1234.5
```

Jendela epoch mingguan di-*tile* dari `BURN_GENESIS` (`BURN_EPOCH_HOURS`), idempotent
per `period_start`. **Default dry-run**: worker hanya merencanakan (epoch `pending`,
berisi budget USD + jumlah token terencana); eksekusi buyback/burn dilakukan treasury
(multisig), lalu dicatat dengan `--mark-executed`. Jalur otomatis `OnchainBurnExecutor`
(treasury EOA) hanya mendukung burn langsung; buyback Uniswap **fail-closed** (belum
diimplementasikan). Statistik publik: `GET /v1/public/burns`.

### Uji

`bun test` memakai database uji terpisah (`TEST_DATABASE_URL`, default
`DATABASE_URL` + sufiks `_test`), schema di-reset + migrasi otomatis tiap kali
test berjalan. Database **dev tidak tersentuh**.


## Struktur

```
backend/
├── config/                  # recipes.yaml, pricing.yaml, params.yaml (nilai bisnis)
├── scripts/                 # create-db, seed-dev, mock-providers, e2e-offline, index-deposits, burn
├── test/                    # bun test (setup preload + unit/E2E dengan mock provider)
└── src/
    ├── app.ts               # Hono app: CORS, logger, error handler
    ├── env.ts               # akses environment
    ├── auth/                # SIWE + sesi cookie
    ├── config/              # loader & validasi config (zod)
    ├── db/                  # koneksi + schema Drizzle + migrasi
    ├── lib/                 # id, money (micro-credits), crypto, http
    ├── middleware/          # auth (API key / sesi)
    ├── providers/           # adapter anthropic, openai, perplexity, higgsfield + http (retry)
    ├── billing/             # estimate + ledger (reserve/settle/release, FIFO lots)
    ├── orchestration/       # runner (state machine), interpreter, router, summarize, prompts, SSE
    ├── onchain/             # deposit indexer: client viem, event, valuasi harga, credits, ingest
    ├── burn/                # epoch buyback & burn: plan, epochs, executor, worker (Fase 3)
    ├── leaderboard/         # window mingguan UTC, agregasi cap 200/hari, exclusion, opt-out
    ├── routes/              # auth, runs, chat completions, balance, usage, keys, leaderboard, project, public, dev
    └── services/            # project (termasuk onchain_id)
```

## Konsep kunci

- **Uang = integer micro-credits** (1 credit = 1.000.000 micro = $0,01). Tidak pernah float.
- **Ledger append-only**: saldo = Σ `ledger_entries.amount_micro`. Setiap entri punya `idempotency_key` unik.
- **Config, bukan kode**: harga, markup, diskon, parameter burn ada di `config/*.yaml` (reload via `POST /v1/reload`).
- **Provider-agnostic**: recipe menunjuk `model_ref`; ganti model tanpa deploy.
- **Brief = data tidak tepercaya**: system prompt GATTAI immutable; brief interpreter advisory, request asli menang.

## Endpoint (Fase 1)

Auth (sesi SIWE):
```
GET  /auth/nonce
POST /auth/verify        { message, signature }
POST /auth/logout
GET  /auth/me
```

OpenAI-compatible (pakai API key `gtt_live_...`):
```
POST /v1/chat/completions   { model: "gattai/refine|research|code", messages, stream }
```

Native:
```
GET    /v1/recipes
POST   /v1/router/suggest
POST   /v1/runs              { recipe_id?, input, conversation_id? }
GET    /v1/runs/:id
GET    /v1/runs/:id/events   (SSE)
POST   /v1/runs/:id/confirm  (recipe media)
GET    /v1/balance
GET    /v1/usage
GET    /v1/project           (sesi/key; menyertakan onchain_id)
GET    /v1/public/deposits/config   (tanpa auth; konfigurasi top-up)
GET    /v1/public/stats             (tanpa auth; agregasi flywheel produk, revenue & burns)
GET    /v1/public/burns             (tanpa auth; statistik buyback & burn)
GET    /v1/public/leaderboard       (tanpa auth; peringkat mingguan top 20)
GET    /v1/leaderboard/me           (sesi/key; rank project yang login)
POST   /v1/leaderboard/opt-out      (sesi/key; opt-out idempotent)
POST   /v1/keys              (sesi)
DELETE /v1/keys/:id          (sesi)
POST   /v1/dev/credits       (hanya non-produksi; seed credits)
POST   /v1/reload
```

## Contoh cepat

```bash
# 1) seed credits (mode dev)
curl -X POST localhost:3000/v1/dev/credits \
  -H "Authorization: Bearer gtt_live_..." \
  -H "Content-Type: application/json" \
  -d '{"credits":10}'

# 2) jalankan recipe refine
curl -X POST localhost:3000/v1/runs \
  -H "Authorization: Bearer gtt_live_..." \
  -H "Idempotency-Key: demo-1" \
  -d '{"recipe_id":"refine","input":"Buat komponen React untuk toggle"}'

# 3) pantau progres (SSE)
curl -N localhost:3000/v1/runs/<run_id>/events -H "Authorization: Bearer gtt_live_..."
```

## Basis data

```bash
bun run --cwd backend db:generate   # buat migrasi dari schema
bun run --cwd backend db:migrate    # terapkan migrasi
bun run --cwd backend db:push       # langsung sinkron (dev)
```

## Catatan / batasan

- **Deposit onchain (Fase 2)** sudah ada: kontrak + indexer + valuasi. Kontrak sudah ter-deploy di testnet; **mainnet Fase 1 belum**. Credits dev tetap bisa lewat `POST /v1/dev/credits` / `seed:dev`. Lihat [`../DEPLOY-FASE-1-CHECKLIST.md`](../DEPLOY-FASE-1-CHECKLIST.md).
- **Harga GATTAI** (TWAP Uniswap) belum tersedia → deposit GATTAI fail-closed (tidak dikreditkan) sampai pool TWAP ada.
- Adapter Higgsfield bersifat best-effort (API masih baru). Endpoint dapat dikonfigurasi via `HIGGSFIELD_*` di `.env`; verifikasi sebelum produksi.
- Ringkas percakapan panjang berjalan **sinkron** sebelum run (bukan background job); biayanya dibebankan ke run.
- Integrasi **provider nyata** belum diverifikasi E2E (API key belum tersedia); verifikasi offline memakai mock server.
- **Buyback & burn (Fase 3)**: worker + pencatatan epoch + `/v1/public/burns` sudah ada & teruji lokal. Eksekusi buyback/burn **onchain nyata** belum: default dry-run, eksekusi via treasury multisig + `--mark-executed`. Buyback Uniswap otomatis fail-closed sampai pool/route tersedia.
