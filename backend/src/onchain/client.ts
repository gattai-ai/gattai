import { createPublicClient, fallback, http, parseAbiItem, type PublicClient } from "viem";
import { robinhood, robinhoodTestnet } from "viem/chains";
import { env } from "../env";

/** Signature event `DepositManager.Deposited`. */
export const DEPOSITED_EVENT = parseAbiItem(
  "event Deposited(bytes32 indexed projectId, address indexed payer, address indexed token, uint256 amount)",
);

/**
 * Buat klien JSON-RPC dengan **timeout + retry** dan, bila disediakan,
 * **daftar fallback** (P1.2). `fallback` mencoba endpoint berikutnya saat
 * endpoint utama gagal. `rank: false` menjaga urutan prioritas tetap.
 */
export function createRobinhoodClient(
  rpcUrl: string | undefined = env.robinhoodRpcUrl,
  fallbackUrls: string[] = env.robinhoodRpcFallbackUrls,
): PublicClient {
  const urls = [rpcUrl, ...fallbackUrls].filter(
    (url): url is string => typeof url === "string" && url.trim() !== "",
  );
  if (urls.length === 0) {
    throw new Error(
      "ROBINHOOD_RPC_URL is not set. Configure an RPC endpoint in .env to enable onchain deposits.",
    );
  }

  const chain = env.chainId === robinhood.id ? robinhood : robinhoodTestnet;
  const transports = urls.map((url, index) =>
    http(url, {
      timeout: env.rpcTimeoutMs,
      retryCount: env.rpcRetryCount,
      retryDelay: 250 + index * 250,
    }),
  );
  const transport = transports.length === 1 ? transports[0] : fallback(transports, { rank: false });

  return createPublicClient({ chain, transport });
}
