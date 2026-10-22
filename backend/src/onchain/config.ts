import { getParams } from "../config";
import { env, isProd } from "../env";
import type { IngestConfig } from "./ingest";
import type { ContractReader, PriceContext } from "./prices";
import { buildTokenRegistry } from "./registry";
import type { Hex } from "./types";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function asHex(address: string | undefined): Hex | undefined {
  return address && ADDRESS_RE.test(address) ? (address as Hex) : undefined;
}

/** Bangun `PriceContext` dari environment. `reader` opsional (diperlukan feed on-chain). */
export function buildPriceContext(reader?: ContractReader): PriceContext {
  return {
    reader,
    ethFeedAddress: asHex(env.chainlinkEthUsdFeed),
    gattaiTwapPool: asHex(env.gattaiTwapPool),
    ethUsdOverride: env.ethUsdPriceOverride,
    gattaiUsdOverride: env.gattaiUsdPriceOverride,
    // Harga manual hanya untuk non-produksi, kecuali diizinkan eksplisit.
    manualAllowed: !isProd() || env.allowManualPrices,
  };
}

/** Bangun konfigurasi ingest dari params.yaml + environment. */
export function buildIngestConfig(reader?: ContractReader): IngestConfig {
  const params = getParams();
  return {
    tokens: buildTokenRegistry({
      gattaiTokenAddress: env.gattaiTokenAddress,
      usdgTokenAddress: env.usdgTokenAddress,
      usdgDecimals: env.usdgDecimals,
      enabledSymbols: env.depositEnabledSymbols,
    }),
    priceContext: buildPriceContext(reader),
    capUsd: params.deposits.cap_usd,
    discountRatio: params.gattai.discount_ratio,
    confirmations: env.depositConfirmations,
    minUsd: env.depositMinUsd,
  };
}
