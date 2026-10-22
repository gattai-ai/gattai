import hardhatToolboxViemPlugin from "@nomicfoundation/hardhat-toolbox-viem";
import { configVariable, defineConfig } from "hardhat/config";

export default defineConfig({
  plugins: [hardhatToolboxViemPlugin],
  solidity: {
    version: "0.8.34",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      // Robinhood Chain adalah Arbitrum Orbit (ArbOS 61). Kontrak yang
      // terverifikasi di explorer-nya memakai target `cancun`; jangan biarkan
      // Hardhat memakai default `osaka` yang belum tentu didukung chain.
      evmVersion: "cancun",
    },
  },
  networks: {
    hardhatMainnet: {
      type: "edr-simulated",
      chainType: "l1",
    },
    hardhatOp: {
      type: "edr-simulated",
      chainType: "op",
    },
    // Robinhood Chain testnet (chain id 46630).
    // chainType "generic": Robinhood Chain adalah Arbitrum Orbit L2, jadi bukan "l1"
    // dan bukan "op". URL RPC resmi adalah default. Di beberapa jaringan
    // (mis. Indonesia) host resmi bisa DNS-blocked; untuk environment seperti
    // itu set ROBINHOOD_RPC_URL ke fallback yang sudah diverifikasi, mis.
    // https://robinhood-sepolia-rpc.publicnode.com. Jangan memakai fallback
    // untuk mainnet. Private key TIDAK boleh ditulis di file mana pun.
    robinhoodTestnet: {
      type: "http",
      chainType: "generic",
      url: process.env.ROBINHOOD_RPC_URL ?? "https://rpc.testnet.chain.robinhood.com",
      accounts: [configVariable("DEPLOYER_PRIVATE_KEY")],
    },
    // Robinhood Chain mainnet (chain id 4663).
    // Sengaja memakai env key BERBEDA dari testnet supaya private key testnet
    // tidak pernah terpakai untuk transaksi uang nyata.
    robinhood: {
      type: "http",
      chainType: "generic",
      url: process.env.ROBINHOOD_MAINNET_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com",
      accounts: [configVariable("MAINNET_DEPLOYER_PRIVATE_KEY")],
    },
    // Fork read-only mainnet untuk uji DepositManager + Safe + USDG asli.
    // Jalankan lewat `bun run --cwd contracts test:fork`; jangan dipakai untuk
    // deploy. Pin `FORK_BLOCK_NUMBER` agar hasilnya reproducible.
    robinhoodFork: {
      type: "edr-simulated",
      chainType: "generic",
      chainId: 4663,
      forking: {
        url: process.env.ROBINHOOD_MAINNET_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com",
        blockNumber: process.env.FORK_BLOCK_NUMBER
          ? Number(process.env.FORK_BLOCK_NUMBER)
          : undefined,
      },
    },
  },
});
