import { NATIVE_TOKEN, type Hex, type TokenRegistry, type TokenSpec } from "./types";

/** Input alamat token dari environment. */
export interface TokenRegistryInput {
  gattaiTokenAddress?: string;
  usdgTokenAddress?: string;
  usdgDecimals?: number;
  /**
   * Aset yang diaktifkan. Default semua yang alamatnya tersedia (perilaku
   * lama). Produksi memakai default USDG-only lewat `env.depositEnabledSymbols`.
   */
  enabledSymbols?: ReadonlySet<string>;
}

/**
 * Bangun registry token yang bisa di-deposit:
 * - ETH native (`0x0000…0000`, 18 desimal) bila diaktifkan;
 * - USDG dan GATTAI hanya bila alamatnya dikonfigurasi dan diaktifkan.
 */
export function buildTokenRegistry(input: TokenRegistryInput): TokenRegistry {
  const enabled = input.enabledSymbols;
  const isEnabled = (symbol: string) => !enabled || enabled.has(symbol);
  const tokens: TokenSpec[] = [];

  if (isEnabled("ETH")) {
    tokens.push({ symbol: "ETH", address: NATIVE_TOKEN, decimals: 18 });
  }

  if (input.usdgTokenAddress && isEnabled("USDG")) {
    tokens.push({
      symbol: "USDG",
      address: normalizeAddress(input.usdgTokenAddress),
      decimals: input.usdgDecimals ?? 6,
    });
  }
  if (input.gattaiTokenAddress && isEnabled("GATTAI")) {
    tokens.push({
      symbol: "GATTAI",
      address: normalizeAddress(input.gattaiTokenAddress),
      decimals: 18,
    });
  }

  const byAddressMap = new Map(
    tokens.map((token) => [token.address.toLowerCase(), token]),
  );

  return {
    byAddress: (address) => byAddressMap.get(address.toLowerCase()),
    all: () => tokens,
  };
}

function normalizeAddress(address: string): Hex {
  return address.toLowerCase() as Hex;
}
