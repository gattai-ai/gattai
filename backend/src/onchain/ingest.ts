import { and, eq } from "drizzle-orm";
import { recordCreditLotTx } from "../billing/ledger";
import { db } from "../db";
import { deposits, projects } from "../db/schema";
import { newId } from "../lib/id";
import { computeCreditsMicro, usd8ToDecimalString, usdValue8 } from "./credits";
import { recordDeadLetter } from "./dead-letter";
import { PriceUnavailableError, priceForToken, type PriceContext } from "./prices";
import { normalizeOnchainId } from "./project-id";
import type { TokenRegistry } from "./types";

/** Satu event `Deposited` yang sudah didekode. */
export interface DepositEvent {
  chainTx: string;
  logIndex: number;
  blockNumber?: bigint;
  /** Hash blok tx (untuk deteksi reorg). */
  blockHash?: string;
  /** bytes32 project id onchain (hex). */
  projectId: string;
  payer: string;
  /** Alamat token; `0x0000…0000` untuk ETH native. */
  token: string;
  amountRaw: bigint;
}

export interface IngestConfig {
  tokens: TokenRegistry;
  priceContext: PriceContext;
  /** Cap maksimum per deposit (USD). <= 0 berarti tanpa cap. */
  capUsd: number;
  /** Rasio diskon untuk pembayaran GATTAI (mis. 0.15). */
  discountRatio: number;
  /** Jumlah konfirmasi yang sudah dicapai saat log diproses. */
  confirmations: number;
  /** Ambang minimum nilai USD agar dikreditkan (anti-spam dust). <= 0 = nonaktif. */
  minUsd?: number;
}

export type IngestOutcome =
  | { status: "credited"; depositId: string; lotId: string; creditsMicro: number; usdValue: string }
  | { status: "duplicate"; depositId: string }
  | { status: "unknown_project" }
  | { status: "unknown_token"; depositId: string }
  | { status: "unpriced"; depositId: string; reason: string }
  | { status: "dust"; depositId: string; usdValue: string }
  | { status: "over_cap"; depositId: string; usdValue: string };

/**
 * Memproses satu event deposit: resolusi project → klaim idempotensi →
 * valuasi → dust/cap → kredit lot. Idempotent per `(chain_tx, log_index)`
 * sehingga aman diproses ulang oleh jalur confirm maupun reconciler.
 *
 * Kredit (lot + ledger + tandai deposit) dibungkus SATU transaksi DB, jadi
 * tidak mungkin ada lot tanpa baris deposit `confirmed` atau sebaliknya.
 * Valuasi (yang bisa memanggil RPC) dilakukan di luar transaksi.
 */
export async function ingestDeposit(
  event: DepositEvent,
  config: IngestConfig,
): Promise<IngestOutcome> {
  const projectId = await findProjectIdByOnchainId(event.projectId);
  if (!projectId) {
    // Dana sudah diteruskan kontrak ke treasury, tetapi tidak ada project yang
    // bisa dikreditkan. Simpan dead-letter agar tidak hilang diam-diam dan
    // bisa diproses refund manual.
    await recordDeadLetter({
      chainTx: event.chainTx,
      logIndex: event.logIndex,
      projectId: event.projectId,
      payer: event.payer,
      token: event.token,
      amountRaw: event.amountRaw.toString(),
      error: "unknown_project",
      attempts: 0,
    });
    return { status: "unknown_project" };
  }

  const tokenAddress = event.token.toLowerCase();
  const spec = config.tokens.byAddress(tokenAddress);

  // Klaim baris deposit (idempotensi) atau ambil baris yang sudah ada.
  const claimed = await db
    .insert(deposits)
    .values({
      id: newId("dep"),
      projectId,
      chainTx: event.chainTx,
      logIndex: event.logIndex,
      token: tokenAddress,
      payer: event.payer.toLowerCase(),
      source: spec?.symbol ?? null,
      amountRaw: event.amountRaw.toString(),
      blockNumber: event.blockNumber !== undefined ? Number(event.blockNumber) : null,
      blockHash: event.blockHash ?? null,
      confirmations: config.confirmations,
      // Token yang tidak dikenal tetap menerima dana di treasury; tandai untuk
      // peninjauan manual, bukan `failed` yang tidak terlihat di antrean refund.
      status: spec ? "pending" : "needs_review",
    })
    .onConflictDoNothing({ target: [deposits.chainTx, deposits.logIndex] })
    .returning({ id: deposits.id });

  const depositId = claimed[0]?.id ?? (await findDepositId(event.chainTx, event.logIndex));
  if (!depositId) return { status: "unknown_project" };

  if (!claimed[0]) {
    // Baris sudah ada: hanya boleh diproses ulang bila masih `pending`.
    const existing = await loadDeposit(depositId);
    if (!existing || existing.status !== "pending" || existing.lotId) {
      return { status: "duplicate", depositId };
    }
  }

  if (!spec) return { status: "unknown_token", depositId };
  if (event.amountRaw <= 0n) {
    await markDeposit(depositId, { status: "failed" });
    return { status: "duplicate", depositId };
  }

  // Valuasi (fail-closed). Di luar transaksi DB karena bisa memanggil RPC.
  let price: { price8: bigint; source: string };
  try {
    price = await priceForToken(spec, config.priceContext);
  } catch (error) {
    if (error instanceof PriceUnavailableError) {
      return { status: "unpriced", depositId, reason: error.message };
    }
    throw error;
  }

  const usd8 = usdValue8(event.amountRaw, price.price8, spec.decimals);
  const usdValue = usd8ToDecimalString(usd8);

  // Anti-dust: nilai terlalu kecil → catat tapi jangan kredit.
  const minUsd8 =
    config.minUsd && config.minUsd > 0 ? BigInt(Math.ceil(config.minUsd * 1e8)) : 0n;
  if (usd8 < minUsd8) {
    const changed = await markDeposit(depositId, {
      status: "dust",
      usdValue,
      priceSource: price.source,
      confirmations: config.confirmations,
    });
    if (!changed) return { status: "duplicate", depositId };
    // Dana dust sudah diteruskan ke treasury oleh kontrak dan tidak dibuatkan
    // lot. Catat keras agar operator bisa memutuskan refund manual.
    console.warn(
      `[deposit ${depositId}] dust ${usdValue} USD (tx ${event.chainTx}); no lot created, refund review required`,
    );
    return { status: "dust", depositId, usdValue };
  }

  // Cap per deposit.
  if (config.capUsd > 0 && usd8 > BigInt(Math.round(config.capUsd * 1e8))) {
    const changed = await markDeposit(depositId, {
      status: "over_cap",
      usdValue,
      priceSource: price.source,
      confirmations: config.confirmations,
    });
    if (!changed) return { status: "duplicate", depositId };
    console.warn(
      `[deposit ${depositId}] over cap ${usdValue} USD (tx ${event.chainTx}); no lot created, refund review required`,
    );
    return { status: "over_cap", depositId, usdValue };
  }

  const discount = spec.symbol === "GATTAI" ? config.discountRatio : 0;
  const creditsMicro = computeCreditsMicro(usd8, discount);

  // Kredit atomik: lot + ledger + tandai deposit dalam SATU transaksi.
  const result = await db.transaction(async (tx) => {
    const lot = await recordCreditLotTx(tx, {
      projectId,
      source: spec.symbol,
      amountMicro: Number(creditsMicro),
      idempotencyKey: `deposit:${event.chainTx}:${event.logIndex}`,
      depositTx: event.chainTx,
    });

    const confirmedValues = {
      status: "confirmed" as const,
      source: spec.symbol,
      usdValue,
      creditsMicro: Number(creditsMicro),
      lotId: lot.lotId,
      priceSource: price.source,
      blockNumber: event.blockNumber !== undefined ? Number(event.blockNumber) : null,
      blockHash: event.blockHash ?? null,
      confirmations: config.confirmations,
    };

    if (!lot.applied) {
      // Proses lain sudah membuat lot lebih dulu. Jangan laporkan "credited"
      // (itu akan membuat saldo yang ditampilkan bertambah dua kali); cukup
      // pastikan baris deposit juga sudah confirmed.
      await tx
        .update(deposits)
        .set(confirmedValues)
        .where(and(eq(deposits.id, depositId), eq(deposits.status, "pending")));
      return { applied: false, lotId: lot.lotId };
    }

    await tx
      .update(deposits)
      .set(confirmedValues)
      .where(eq(deposits.id, depositId));
    return { applied: true, lotId: lot.lotId };
  });

  if (!result.applied) return { status: "duplicate", depositId };

  return {
    status: "credited",
    depositId,
    lotId: result.lotId ?? "",
    creditsMicro: Number(creditsMicro),
    usdValue,
  };
}

async function markDeposit(
  depositId: string,
  values: Partial<typeof deposits.$inferInsert>,
): Promise<boolean> {
  const changed = await db
    .update(deposits)
    .set(values)
    .where(and(eq(deposits.id, depositId), eq(deposits.status, "pending")))
    .returning({ id: deposits.id });
  return changed.length > 0;
}

async function findProjectIdByOnchainId(onchainId: string): Promise<string | undefined> {
  const rows = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.onchainId, normalizeOnchainId(onchainId)))
    .limit(1);
  return rows[0]?.id;
}

async function findDepositId(chainTx: string, logIndex: number): Promise<string | undefined> {
  const rows = await db
    .select({ id: deposits.id })
    .from(deposits)
    .where(and(eq(deposits.chainTx, chainTx), eq(deposits.logIndex, logIndex)))
    .limit(1);
  return rows[0]?.id;
}

async function loadDeposit(id: string) {
  const rows = await db.select().from(deposits).where(eq(deposits.id, id)).limit(1);
  return rows[0];
}
