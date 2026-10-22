import { createWalletClient, http, parseAbi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { robinhood, robinhoodTestnet } from "viem/chains";
import type { BurnBreakdown, BurnExecutionResult, BurnExecutor } from "./types";

/**
 * Eksekusi burn.
 *
 * Default produksi: treasury adalah **multisig**, jadi eksekusi aktual
 * (swap buyback + `burn()`) dilakukan oleh operator treasury, lalu dicatat
 * lewat `markEpochExecuted` (lihat `scripts/burn.ts --mark-executed`).
 *
 * {@link DryRunExecutor} hanya merencanakan (epoch ditulis `pending`).
 * {@link OnchainBurnExecutor} adalah jalur otomatis opsional untuk treasury
 * EOA: saat ini hanya mendukung **burn langsung** GATTAI; buyback Uniswap
 * sengaja fail-closed (belum diimplementasikan) agar tidak memakai swap yang
 * belum teruji.
 */

export class BurnUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BurnUnavailableError";
  }
}

/** ABI minimal `GattaiToken.burn` (ERC20Burnable). */
export const GATTAI_BURN_ABI = parseAbi(["function burn(uint256 amount)"]);

/** Klien wallet minimal; kompatibel dengan viem `WalletClient`. */
export interface BurnWalletClient {
  writeContract(args: {
    address: Hex;
    abi: readonly unknown[];
    functionName: string;
    args?: readonly unknown[];
    account?: Hex;
  }): Promise<Hex>;
}

/** Executor dry-run: tidak mengirim transaksi apa pun. */
export class DryRunExecutor implements BurnExecutor {
  readonly kind = "dry-run" as const;

  async execute(): Promise<BurnExecutionResult> {
    return { tokensBurned18: 0n, txHashes: [] };
  }
}

/** Executor onchain untuk treasury EOA (burn langsung saja). */
export class OnchainBurnExecutor implements BurnExecutor {
  readonly kind = "onchain" as const;

  constructor(
    private readonly deps: {
      wallet: BurnWalletClient;
      gattaiToken: Hex;
      /** Alamat treasury penandatangan (pemegang token). */
      from: Hex;
    },
  ) {}

  async execute(plan: BurnBreakdown): Promise<BurnExecutionResult> {
    if (plan.buybackTokens18 > 0n) {
      throw new BurnUnavailableError(
        "Uniswap buyback is not implemented yet; run the buyback via the treasury multisig and record it with --mark-executed.",
      );
    }
    if (plan.directBurnTokens18 <= 0n) {
      return { tokensBurned18: 0n, txHashes: [] };
    }

    const hash = await this.deps.wallet.writeContract({
      address: this.deps.gattaiToken,
      abi: GATTAI_BURN_ABI,
      functionName: "burn",
      args: [plan.directBurnTokens18],
      account: this.deps.from,
    });

    return { tokensBurned18: plan.directBurnTokens18, txHashes: [hash] };
  }
}

/** Buat wallet client viem (treasury EOA) untuk Robinhood Chain. */
export function createRobinhoodWalletClient(options: {
  privateKey: Hex;
  rpcUrl: string;
  chainId: number;
}): BurnWalletClient {
  const chain = options.chainId === robinhood.id ? robinhood : robinhoodTestnet;
  const account = privateKeyToAccount(options.privateKey);
  return createWalletClient({
    account,
    chain,
    transport: http(options.rpcUrl),
  }) as unknown as BurnWalletClient;
}
