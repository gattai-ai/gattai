import type { Address } from "../types";
import { addresses } from "./addresses";

export * from "./abis";

/**
 * Mengembalikan alamat kontrak pada chain tertentu,
 * atau undefined kalau kontrak itu belum di-deploy di chain tersebut.
 */
export function findContractAddress(
  chainId: number | undefined,
  name: string,
): Address | undefined {
  if (chainId === undefined) return undefined;
  const byChain = (addresses as Record<string, Record<string, string> | undefined>)[
    String(chainId)
  ];
  return byChain?.[name] as Address | undefined;
}
