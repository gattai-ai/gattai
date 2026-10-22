import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/**
 * Deploy HANYA token $GATTAI, tanpa DepositManager baru.
 *
 * Dipakai untuk fase token setelah Fase 1 mainnet sudah live: DepositManager
 * Fase 1 tetap menjadi satu-satunya alamat deposit, lalu Safe memanggil
 * `setTokenAccepted(token, true)` pada kontrak itu. Ini menghindari deploy
 * DepositManager kedua, pergantian alamat backend, dan migrasi indexer.
 *
 * Parameter (`--parameters`):
 * - `treasury`: Safe penerima seluruh supply awal.
 * - `initialSupply` (opsional): supply dalam wei token (18 desimal).
 */
const GattaiTokenModule = buildModule("GattaiTokenModule", (m) => {
  const treasury = m.getParameter<string>("treasury");
  const initialSupply = m.getParameter<bigint>(
    "initialSupply",
    1_000_000_000n * 10n ** 18n,
  );

  const token = m.contract("GattaiToken", [treasury, initialSupply]);

  return { token };
});

export default GattaiTokenModule;
