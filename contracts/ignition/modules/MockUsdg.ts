import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/**
 * Modul deploy MockUSDG — **khusus testnet/dev**.
 *
 * Stablecoin USDG sungguhan (Global Dollar) tidak di-deploy lewat repo ini;
 * di mainnet alamatnya diisi lewat `USDG_TOKEN_ADDRESS` ke alamat token nyata.
 * Kontrak ini hanya untuk menguji alur top-up stablecoin 1:1 di testnet.
 *
 * Parameter:
 * - `minter`: alamat yang boleh memanggil `mint`. Gunakan alamat nol
 *   (`0x000...000`) agar `faucet()`/`mint()` terbuka. Jangan pernah deploy
 *   kontrak ini di mainnet.
 */
const MockUsdgModule = buildModule("MockUsdgModule", (m) => {
  // `m.getParameter` mengembalikan runtime value, bukan string. Jangan
  // memakai `String()`/perbandingan JS di sini; teruskan langsung ke kontrak.
  const minter = m.getParameter<string>(
    "minter",
    "0x0000000000000000000000000000000000000000",
  );

  const usdg = m.contract("MockUSDG", [minter]);

  return { usdg };
});

export default MockUsdgModule;