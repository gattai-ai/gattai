import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

const NATIVE = "0x0000000000000000000000000000000000000000";

/**
 * Modul deploy GATTAI: token $GATTAI (supply tetap) + DepositManager.
 *
 * Parameter yang wajib disuplai lewat file `--parameters`:
 * - `treasury`: alamat treasury (EOA di testnet, Safe multisig di mainnet).
 *   Token memakai alamat ini sebagai penerima seluruh supply awal, dan
 *   DepositManager memakainya sebagai penerima dana + owner akhir.
 * - `initialSupply` (opsional): supply awal dalam wei token (18 desimal).
 * - `nativeAccepted` (opsional, default `true`): set `false` untuk fase
 *   USDG-first tanpa jalur ETH.
 * - `usdgToken` (opsional, default kosong): alamat USDG yang ikut
 *   di-allowlist. Isi untuk mainnet; jangan isi alamat mainnet di testnet.
 * - `usdgMaxAmount` / `gattaiMaxAmount` / `nativeMaxAmount` (opsional, default
 *   `0`): batas jumlah per deposit dalam satuan token. `0` = tanpa batas.
 */
const GattaiModule = buildModule("GattaiModule", (m) => {
  const treasury = m.getParameter<string>("treasury");
  const initialSupply = m.getParameter<bigint>(
    "initialSupply",
    1_000_000_000n * 10n ** 18n,
  );
  const nativeAccepted = m.getParameter<boolean>("nativeAccepted", true);
  const usdgToken = m.getParameter<string>("usdgToken", "");
  const usdgMaxAmount = m.getParameter<bigint>("usdgMaxAmount", 0n);
  const gattaiMaxAmount = m.getParameter<bigint>("gattaiMaxAmount", 0n);
  const nativeMaxAmount = m.getParameter<bigint>("nativeMaxAmount", 0n);

  const token = m.contract("GattaiToken", [treasury, initialSupply]);
  const depositManager = m.contract("DepositManager", [treasury]);

  // Allowlist token $GATTAI + USDG sebelum serah terima ownership. Tanpa USDG,
  // DepositManager baru hanya menerima GATTAI dan merusak jalur stablecoin.
  m.call(depositManager, "setTokenAccepted", [token, true]);
  m.call(depositManager, "setMaxAmount", [token, gattaiMaxAmount]);
  if (usdgToken) {
    m.call(depositManager, "setTokenAccepted", [usdgToken, true]);
    m.call(depositManager, "setMaxAmount", [usdgToken, usdgMaxAmount]);
  }
  m.call(depositManager, "setNativeAccepted", [nativeAccepted]);
  m.call(depositManager, "setMaxAmount", [NATIVE, nativeMaxAmount]);

  // Serahkan kepemilikan DepositManager ke treasury (multisig di mainnet).
  m.call(depositManager, "transferOwnership", [treasury]);

  return { token, depositManager };
});

export default GattaiModule;
