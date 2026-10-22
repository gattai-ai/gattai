import { getParams } from "../config";
import { buildPriceContext } from "../onchain/config";
import type { ContractReader } from "../onchain/prices";
import type { BurnConfig } from "./types";

/** Bangun konfigurasi burn dari `params.yaml` + environment. */
export function buildBurnConfig(reader?: ContractReader): BurnConfig {
  const params = getParams();
  return {
    shareStable: params.burn.share_stable,
    shareToken: params.burn.share_token,
    priceContext: buildPriceContext(reader),
  };
}
