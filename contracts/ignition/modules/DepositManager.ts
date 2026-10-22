import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

const NATIVE = "0x0000000000000000000000000000000000000000";

/**
 * Deploy HANYA DepositManager — dipakai untuk peluncuran bertahap (Fase 1:
 * USDG-first) tanpa menerbitkan token $GATTAI.
 *
 * Parameter wajib (`--parameters`):
 * - `treasury`: Safe multisig (bukan EOA).
 * - `usdgToken`: alamat token USDG yang langsung di-allowlist.
 *
 * Parameter opsional:
 * - `nativeAccepted` (default `false`): biarkan ETH mati sampai feed harga
 *   dan proses treasury siap.
 * - `usdgMaxAmount` / `nativeMaxAmount` (default `0`): batas jumlah per
 *   deposit dalam satuan token. `0` berarti tanpa batas.
 *
 * Fase 1 sengaja tidak menerima GATTAI. Setelah token GATTAI diaudit dan
 * di-deploy, allowlist ditambahkan lewat Safe (bukan dengan mengubah modul ini
 * atau men-deploy DepositManager kedua).
 *
 * Catatan Ignition: `m.getParameter` mengembalikan runtime value, bukan nilai
 * string. Jangan memakai `if (param)` atau `String(param)` di module builder;
 * teruskan runtime value langsung ke `m.contract`/`m.call`.
 *
 * Setelah deploy, `INDEXER_FROM_BLOCK` WAJIB diisi dengan block number
 * deployment ini (lihat output Ignition), bukan head chain.
 */
const DepositManagerModule = buildModule("DepositManagerModule", (m) => {
  const treasury = m.getParameter<string>("treasury");
  const nativeAccepted = m.getParameter<boolean>("nativeAccepted", false);
  const usdgToken = m.getParameter<string>("usdgToken");
  const usdgMaxAmount = m.getParameter<bigint>("usdgMaxAmount", 0n);
  const nativeMaxAmount = m.getParameter<bigint>("nativeMaxAmount", 0n);

  const depositManager = m.contract("DepositManager", [treasury]);

  // Kontrak default-nya menerima ETH; panggilan ini WAJIB ada agar parameter
  // `nativeAccepted: false` benar-benar mematikan jalur ETH.
  const setNativeAccepted = m.call(depositManager, "setNativeAccepted", [
    nativeAccepted,
  ]);
  const setNativeMaxAmount = m.call(
    depositManager,
    "setMaxAmount",
    [NATIVE, nativeMaxAmount],
    { id: "setNativeMaxAmount" },
  );

  // Fase 1: USDG wajib. Jangan pernah deploy dengan `usdgToken` kosong.
  const setTokenAccepted = m.call(depositManager, "setTokenAccepted", [
    usdgToken,
    true,
  ]);
  const setUsdgMaxAmount = m.call(
    depositManager,
    "setMaxAmount",
    [usdgToken, usdgMaxAmount],
    { id: "setUsdgMaxAmount" },
  );

  // Ownership diserahkan ke treasury (Safe) PALING AKHIR. Tanpa `after`,
  // Ignition bisa mengeksekusi transfer lebih dulu, lalu call owner berikutnya
  // revert dengan OwnableUnauthorizedAccount.
  m.call(depositManager, "transferOwnership", [treasury], {
    after: [
      setNativeAccepted,
      setNativeMaxAmount,
      setTokenAccepted,
      setUsdgMaxAmount,
    ],
  });

  return { depositManager };
});

export default DepositManagerModule;
