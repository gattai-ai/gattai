import type { Hex, TokenSpec } from "./types";

/**
 * Valuasi USD untuk token deposit.
 *
 * Kebijakan (sesuai keputusan Fase 2): **fail-closed**. Bila sumber harga
 * tidak tersedia, `PriceUnavailableError` dilempar dan deposit dibiarkan
 * `pending` (tidak otomatis dikreditkan). Harga "manual" hanya boleh dipakai
 * bila diizinkan secara eksplisit (non-produksi atau ALLOW_MANUAL_PRICES).
 */

export class PriceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PriceUnavailableError";
  }
}

export interface PriceResult {
  /** Harga USD per 1 token penuh, skala 8 desimal. */
  price8: bigint;
  /** Asal harga, untuk audit (`chainlink:0x…`, `usdg:1:1`, `manual:ETH_USD_PRICE`). */
  source: string;
}

/** Pembaca kontrak minimal; kompatibel dengan viem `PublicClient`. */
export interface ContractReader {
  readContract(args: {
    address: Hex;
    abi: readonly unknown[];
    functionName: string;
    args?: readonly unknown[];
  }): Promise<unknown>;
}

export interface PriceContext {
  reader?: ContractReader;
  /** Feed Chainlink ETH/USD (bila ada di chain). */
  ethFeedAddress?: Hex;
  /** Pool Uniswap V3 GATTAI/WETH untuk TWAP (bila ada). */
  gattaiTwapPool?: Hex;
  /** Harga manual USD (hanya dipakai bila `manualAllowed`). */
  ethUsdOverride?: number;
  gattaiUsdOverride?: number;
  manualAllowed: boolean;
  /** Umur maksimum data feed (detik). 0 = lewati pemeriksaan umur. */
  maxAgeSeconds?: number;
}

const CHAINLINK_AGGREGATOR_ABI = [
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
  {
    type: "function",
    name: "latestRoundData",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { type: "uint80" },
      { type: "int256" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint80" },
    ],
  },
] as const;

/** Ambil harga USD (skala 8) untuk token, atau lempar `PriceUnavailableError`. */
export async function priceForToken(
  spec: TokenSpec,
  ctx: PriceContext,
): Promise<PriceResult> {
  switch (spec.symbol) {
    case "USDG":
      return { price8: 100_000_000n, source: "usdg:1:1" };
    case "ETH":
      return ethPrice(ctx);
    case "GATTAI":
      return gattaiPrice(ctx);
  }
}

function manualPrice(usd: number, label: string): PriceResult {
  return { price8: BigInt(Math.round(usd * 1e8)), source: `manual:${label}` };
}

async function ethPrice(ctx: PriceContext): Promise<PriceResult> {
  if (ctx.manualAllowed && ctx.ethUsdOverride) {
    return manualPrice(ctx.ethUsdOverride, "ETH_USD_PRICE");
  }
  if (!ctx.ethFeedAddress) {
    throw new PriceUnavailableError(
      "Chainlink ETH/USD feed is not configured (CHAINLINK_ETH_USD_FEED).",
    );
  }
  return chainlinkPrice(ctx, ctx.ethFeedAddress);
}

async function gattaiPrice(ctx: PriceContext): Promise<PriceResult> {
  if (ctx.manualAllowed && ctx.gattaiUsdOverride) {
    return manualPrice(ctx.gattaiUsdOverride, "GATTAI_USD_PRICE");
  }
  if (ctx.gattaiTwapPool) {
    // TODO(fase-2): hitung TWAP Uniswap V3 dari pool (observe()).
    // Sampai itu ada, tetap fail-closed agar tidak memakai harga spot.
    throw new PriceUnavailableError(
      "Uniswap TWAP for GATTAI is not implemented yet; GATTAI price is unavailable.",
    );
  }
  throw new PriceUnavailableError(
    "GATTAI TWAP pool is not available; GATTAI price cannot be determined.",
  );
}

async function chainlinkPrice(ctx: PriceContext, feed: Hex): Promise<PriceResult> {
  if (!ctx.reader) {
    throw new PriceUnavailableError("Onchain reader is unavailable to read the price feed.");
  }

  const decimals = Number(
    await ctx.reader.readContract({
      address: feed,
      abi: CHAINLINK_AGGREGATOR_ABI,
      functionName: "decimals",
    }),
  );

  const round = (await ctx.reader.readContract({
    address: feed,
    abi: CHAINLINK_AGGREGATOR_ABI,
    functionName: "latestRoundData",
  })) as readonly [bigint, bigint, bigint, bigint, bigint];

  const answer = round[1];
  const updatedAt = round[3];
  if (answer <= 0n) {
    throw new PriceUnavailableError("Chainlink feed returned an invalid price.");
  }

  const maxAge = ctx.maxAgeSeconds ?? 3600;
  if (maxAge > 0 && updatedAt > 0n) {
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (now - updatedAt > BigInt(maxAge)) {
      throw new PriceUnavailableError("Chainlink feed data is stale.");
    }
  }

  const price8 = normalizeTo8(answer, decimals);
  return { price8, source: `chainlink:${feed}` };
}

function normalizeTo8(value: bigint, decimals: number): bigint {
  if (decimals === 8) return value;
  if (decimals < 8) return value * 10n ** BigInt(8 - decimals);
  return value / 10n ** BigInt(decimals - 8);
}
