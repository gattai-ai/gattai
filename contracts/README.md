# Kontrak (Hardhat 3)

Proyek [Hardhat 3](https://hardhat.org) berbasis TypeScript, memakai
`@nomicfoundation/hardhat-toolbox-viem` (Node test runner + viem).

## Layout

```
contracts/        file .sol (sumber) dan unit test Solidity (*.t.sol)
test/             integration test TypeScript (node:test)
ignition/modules/ modul deploy Ignition
scripts/          skrip mandiri (hardhat run)
hardhat.config.ts
```

## Perintah

Semua perintah dijalankan dari folder `contracts`, atau lewat script di root:

```bash
bun run contracts:build              # hardhat build
bun run contracts:test               # hardhat test
bun run contracts:test:fork          # fork mainnet: DepositManager + Safe + USDG asli
bun run contracts:deploy             # deploy ke jaringan simulasi (chain id 31337)
bun run contracts:deploy:testnet     # deploy ke Robinhood Chain testnet
bun run --cwd contracts deploy:phase1:testnet  # DepositManager saja (testnet)
bun run --cwd contracts deploy:phase1:mainnet  # mentah; jangan dipakai langsung
bun run --cwd contracts deploy:phase1:mainnet:guarded  # preflight + konfirmasi eksplisit
bun run --cwd contracts deploy:token:mainnet   # token saja (fase token, pakai DepositManager yang sudah ada)
bun run --cwd contracts deploy:full:mainnet    # token + DepositManager baru (hanya untuk deploy fresh)
bun run --cwd contracts import:safe:mainnet     # verifikasi/import Safe web app mainnet
bun run --cwd contracts preflight:mainnet      # cek read-only sebelum deploy mainnet
bun run --cwd contracts manifest:mainnet       # tulis manifest deploy dari journal Ignition
bun run --cwd contracts manifest:testnet       # manifest untuk chain 46630
bun run --cwd contracts typecheck    # build + tsc --noEmit
```

> **Fase 1 mainnet** hanya memakai jalur `deploy:phase1:mainnet:guarded`.
> Jangan memakai `deploy:phase1:mainnet` mentah atau `deploy:full:mainnet`
> sebelum token diaudit dan likuiditas siap.

`contracts:test:fork` menjalankan fork test read-only di mainnet: membuat Safe
2-of-3, deploy `DepositManager`, memakai USDG asli, lalu menguji deposit, cap,
rescue, pause/unpause lewat Safe, dan ownership. Jangan pin
`FORK_BLOCK_NUMBER` kecuali RPC yang dipakai archive; RPC publik bisa gagal
untuk historical state.

`bun run contracts:build` melakukan compile Solidity sekaligus menghasilkan tipe
TypeScript dari ABI. Selalu build sebelum `typecheck`.

## Kontrak GATTAI

| Kontrak | Peran |
|---|---|
| `GattaiToken.sol` | ERC-20 `$GATTAI`, supply tetap (mint sekali ke treasury), **tanpa mint**, `burn`/`burnFrom`, ownership di-renounce (`owner() == address(0)`). |
| `DepositManager.sol` | `deposit(projectId, token, amount)` — ETH (`token == address(0)`), USDG/GATTAI (allowlist). Emit `Deposited`; dana langsung ke treasury; tanpa withdraw user; `Ownable`+`Pausable`+`ReentrancyGuard`. |

`Counter.sol` dipertahankan sementara (dipakai frontend starter) dan akan dihapus di Fase 4.

## Deploy

Modul Ignition: `ignition/modules/Gattai.ts`. Parameter wajib di file `--parameters`:

```json
{ "GattaiModule": { "treasury": "0x…", "initialSupply": "1000000000000000000000000000" } }
```

- `treasury` — alamat treasury (Safe multisig 2-of-3 di testnet dan mainnet). Token memakai alamat ini sebagai penerima supply awal; `DepositManager` memakainya sebagai penerima dana + owner akhir.
- `initialSupply` — supply awal dalam wei token (default 1 miliar × 1e18).
- `nativeAccepted` — `false` mematikan deposit ETH onchain. Gunakan `false`
  untuk Fase 1.

File parameter: `ignition/parameters/local.json` (chain 31337),
`ignition/parameters/testnet.json`, dan `ignition/parameters/mainnet.json`
(mainnet; treasury masih placeholder dan wajib diisi Safe).

```bash
bun run contracts:deploy           # lokal (hardhatMainnet, parameter local.json)
bun run contracts:deploy:testnet   # Robinhood Chain testnet (parameter testnet.json)

# Fase 1: rehearsal di testnet, lalu mainnet.
# Hanya DepositManager, USDG allowlisted, ETH mati.
bun run --cwd contracts deploy:phase1:testnet

# Mainnet: jalur guarded mewajibkan preflight GO dan konfirmasi eksplisit.
$env:CONFIRM_MAINNET_DEPLOY = "4663"   # PowerShell
bun run --cwd contracts deploy:phase1:mainnet:guarded
```

Untuk mainnet, Hardhat memakai `MAINNET_DEPLOYER_PRIVATE_KEY` (sengaja berbeda
dari key testnet). Lihat [`../docs/DEPLOY-FASE-1-CHECKLIST.md`](../docs/DEPLOY-FASE-1-CHECKLIST.md)
untuk urutan lengkap.

Buat wallet burner khusus testnet, isi saldonya dari faucet
`faucet.testnet.chain.robinhood.com`, lalu simpan private key-nya di keystore
Hardhat (dienkripsi):

```bash
cd contracts
npx hardhat keystore set DEPLOYER_PRIVATE_KEY
```

Private key **tidak boleh** masuk ke file yang di-commit. Untuk testnet, key
burner boleh disimpan di `contracts/.env` lokal yang sudah di-.gitignore:
salin `contracts/.env.example` menjadi `contracts/.env`, lalu isi. `bun run`
memuat `.env` otomatis, tetapi Hardhat 3 gagal untuk HTTP network saat
dijalankan lewat Bun (undici interop). Untuk deploy ke testnet/mainnet,
jalankan Hardhat lewat Node:

```bash
cd contracts
node --env-file=.env ../node_modules/hardhat/dist/src/cli.js <command>
```

`npx hardhat` juga memakai Node, tetapi tidak memuat `.env` otomatis. Untuk
mainnet, gunakan keystore Hardhat, bukan `.env`.

### Safe testnet 2-of-3

Buat Safe testnet (hanya sekali):

```bash
bun run --cwd contracts create:safe:testnet
```

Drill 2-of-3 sebelum Safe dipakai sebagai treasury:

```bash
# 1. Siapkan transaksi no-op dan catat safeTxHash.
bun run --cwd contracts safe:drill:prepare

# 2. Owner pertama approve (key hanya di shell, jangan di .env/commit).
$env:OWNER_PRIVATE_KEY = "0x..."; bun run --cwd contracts safe:drill:approve
Remove-Item Env:OWNER_PRIVATE_KEY

# 3. Owner kedua approve dengan key owner yang berbeda.
$env:OWNER_PRIVATE_KEY = "0x..."; bun run --cwd contracts safe:drill:approve
Remove-Item Env:OWNER_PRIVATE_KEY

# 4. Deployer mengeksekusi setelah 2 approval.
bun run --cwd contracts safe:drill:execute
```

Hasil drill ditulis ke `ignition/deployments/chain-46630/safe-drill.json`.
Drill Fase 1 sudah berhasil (safeTxHash
`0xa6f818451157457245d424644f436ee52aa21ee7f6eced8bb85965f79e0a13a0`,
tx `0x103cf880fecc8c983a38e71577e16d076d2f86389a18c6c4936301c0a070206d`).
Safe juga sudah menjalankan pause
(`0x86f11c7a9884e5eecfef4137320ced4ede0e6afe4a7b390637d00b7b9273730a`)
dan unpause
(`0x2e2d55fb2882626ec850a991887420df87231c4539ac240f35d7bcabfd5fe84a`).
Safe `nonce` sekarang `3`.

### Transaksi Safe generik (pause/unpause/allowlist)

Setelah ownership pindah ke Safe, perubahan admin tidak bisa dikirim dari
deployer. Gunakan tool generik `safe:tx:*`. Tool ini menyimpan record terpisah
per `SAFE_TX_ID` dan mendukung target kontrak + calldata apa pun (CALL saja).

```bash
# 1. Siapkan. SAFE_TX_DATA adalah calldata fungsi yang dipanggil Safe.
$env:SAFE_TX_ID = "pause"
$env:SAFE_TX_TO = "0x85052C5Add70D53c49C17519873dB5ECDaED1864"
$env:SAFE_TX_DATA = "0x8456cb59"   # pause()
$env:SAFE_TX_DESCRIPTION = "Pause DepositManager testnet"
bun run --cwd contracts safe:tx:prepare

# 2. Minimal 2 owner berbeda approve hash yang dicetak.
$env:SAFE_TX_ID = "pause"
$env:OWNER_PRIVATE_KEY = "0x..."
bun run --cwd contracts safe:tx:approve
Remove-Item Env:OWNER_PRIVATE_KEY

# 3. Deployer mengeksekusi.
$env:SAFE_TX_ID = "pause"
bun run --cwd contracts safe:tx:execute
```

Record ditulis ke `ignition/deployments/chain-46630/safe-tx-<id>.json`.
Jangan memakai `SAFE_TX_ID` yang sama untuk transaksi berbeda; pakai id baru
seperti `unpause` atau `set-max-usdg`.

### Safe mainnet via Safe web app

Safe treasury mainnet dibuat lewat Safe web app pada chain **4663**, bukan
lewat script pembuat Safe testnet. Setelah Safe jadi, verifikasi dan tulis
record lokal:

```bash
$env:SAFE_ADDRESS = "0x..."
bun run --cwd contracts import:safe:mainnet
```

Script ini tidak membuat Safe dan tidak mengirim transaksi. Ia memeriksa
bytecode, singleton, 3 owner, threshold 2, version, dan nonce, lalu menulis
`ignition/deployments/chain-4663/safe.json`. Jalankan dengan
`SAFE_IMPORT_DRY_RUN=1` untuk verifikasi tanpa menulis record.

Sebelum deploy mainnet, jalankan preflight read-only:

```bash
MAINNET_DEPLOYER_PRIVATE_KEY=0x... bun run --cwd contracts preflight:mainnet
```

Preflight memeriksa chain ID, saldo deployer, Safe treasury, USDG decimals, cap,
parameter Fase 1, dan status working tree. Script tidak mengirim transaksi dan
keluar dengan kode non-zero jika ada item yang gagal. Batas saldo default
`0.001 ETH` (bisa dioverride lewat `PREFLIGHT_MIN_BALANCE_ETH`), karena gas
Robinhood Chain jauh lebih murah daripada Ethereum mainnet.

Setelah deploy berhasil, folder `ignition/deployments/chain-<chainId>/` berisi
alamat kontrak. Folder itu **wajib di-commit** karena
`scripts/sync-contracts.mjs` membacanya untuk menyalin alamat ke `shared/`.
Jalankan `manifest:mainnet` atau `manifest:testnet` untuk menulis
`deploy-manifest.json` berisi alamat, tx hash, block deployment, commit, dan
detail compiler/EVM.

### Status testnet Fase 1 (chain 46630)

| Item | Nilai |
|---|---|
| DepositManager | `0x85052C5Add70D53c49C17519873dB5ECDaED1864` |
| Deployment tx | `0x22db4fff05236dc33c51349c5de4aa7e0b982911d8f290d00b7c96e07f12af4b` |
| Deployment block | `139795489` |
| Treasury / owner | Safe `0xAeE68Aaa6315959D145Edd2D25877871362907bb` |
| MockUSDG | `0x9960A800CA3d007cd25b6756151bda71e5aEA936` |
| Cap USDG | `1000000` (1 USDG, 6 desimal) |
| `acceptedToken(USDG)` | `true` |
| ETH rail / `nativeAccepted` | `false` |
| `paused()` | `false` |
| Pause tx | `0x86f11c7a9884e5eecfef4137320ced4ede0e6afe4a7b390637d00b7b9273730a` |
| Unpause tx | `0x2e2d55fb2882626ec850a991887420df87231c4539ac240f35d7bcabfd5fe84a` |
| Rehearsal deposit | 2 x 1 USDG -> 201 credits (termasuk 1 promo) |

DepositManager lama `0xb1f5C1D5C3017782Ab7D15FB7660a12CB1Fcd2BA` gagal saat
menjalankan dua call `setMaxAmount` (ownership sudah pindah lebih dulu). Kontrak
itu tidak dipakai, tidak punya saldo, dan tidak ada di manifest/sync.

## Menambah chain

1. Daftarkan di `shared/chains/index.ts` (dipakai frontend).
2. Tambahkan entri `networks` di `hardhat.config.ts` (dipakai Hardhat).
3. Deploy, lalu jalankan `bun run sync <NamaKontrak>` dari root.
