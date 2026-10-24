import { env } from "../env";

/**
 * Wallet yang tidak boleh masuk peringkat publik.
 *
 * Tim/treasury sudah dikonfigurasi untuk klasifikasi burn, jadi dipakai ulang.
 * `LEADERBOARD_EXCLUDED_WALLETS` menampung alamat tambahan (mis. kontrak
 * internal) tanpa harus mengubah kode.
 */
export function leaderboardExcludedWallets(): Set<string> {
  const wallets = new Set<string>();
  for (const wallet of env.teamBurnWallets) wallets.add(wallet.toLowerCase());
  if (env.treasuryAddress) wallets.add(env.treasuryAddress.toLowerCase());
  for (const wallet of env.leaderboardExcludedWallets) wallets.add(wallet.toLowerCase());
  return wallets;
}
