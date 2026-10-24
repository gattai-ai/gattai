import { desc, eq, gte, sql } from "drizzle-orm";
import { formatUnits } from "viem";
import { db } from "../db";
import { burnEpochs, tokenBurns } from "../db/schema";
import { newId } from "../lib/id";

/**
 * Pencatatan burn token GATTAI dari rantai.
 *
 * Semua jumlah disimpan sebagai base-unit integer (uint256) di kolom
 * `numeric(78,0)`. Konversi ke desimal hanya dilakukan di serializer API/UI,
 * sehingga tidak ada pembulatan yang merusak audit trail.
 */

export type TokenBurnKind = "team" | "epoch" | "community";

export interface TokenBurnEvent {
  chainTx: string;
  logIndex: number;
  tokenAddress: string;
  from: string;
  to: string;
  /** Jumlah base-unit token. */
  amountRaw: bigint;
  decimals: number;
  blockNumber: bigint;
  blockHash?: string | null;
  blockTimestamp?: Date | null;
}

export interface IngestTokenBurnOptions {
  /** Wallet tim/treasury (lowercase). */
  teamWallets: Set<string>;
  /** Peta tx hash (lowercase) → epoch id untuk burn yang tercatat di epoch. */
  epochByTx: Map<string, string>;
}

/**
 * Klasifikasi prioritas: epoch menang atas team, team menang atas community.
 * Epoch adalah konteks paling kuat karena tx-nya sudah dicatat sebagai bagian
 * dari siklus buyback/burn resmi.
 */
export function classifyTokenBurn(
  from: string,
  chainTx: string,
  options: Pick<IngestTokenBurnOptions, "teamWallets" | "epochByTx">,
): { kind: TokenBurnKind; epochId: string | null } {
  const epochId = options.epochByTx.get(chainTx.toLowerCase()) ?? null;
  if (epochId) return { kind: "epoch", epochId };
  if (options.teamWallets.has(from.toLowerCase())) return { kind: "team", epochId: null };
  return { kind: "community", epochId: null };
}

/**
 * Upsert idempotent per `(chain_tx, log_index)`. Re-index log yang sama
 * memperbarui metadata/klasifikasi, bukan menggandakan baris.
 */
export async function ingestTokenBurn(
  event: TokenBurnEvent,
  options: IngestTokenBurnOptions,
): Promise<void> {
  const { kind, epochId } = classifyTokenBurn(event.from, event.chainTx, options);
  const values = {
    id: newId("burn"),
    chainTx: event.chainTx.toLowerCase(),
    logIndex: event.logIndex,
    tokenAddress: event.tokenAddress.toLowerCase(),
    fromAddress: event.from.toLowerCase(),
    toAddress: event.to.toLowerCase(),
    amountRaw: event.amountRaw.toString(),
    decimals: event.decimals,
    blockNumber: Number(event.blockNumber),
    blockHash: event.blockHash ?? null,
    blockTimestamp: event.blockTimestamp ?? null,
    kind,
    epochId,
  };

  await db
    .insert(tokenBurns)
    .values(values)
    .onConflictDoUpdate({
      target: [tokenBurns.chainTx, tokenBurns.logIndex],
      set: {
        tokenAddress: values.tokenAddress,
        fromAddress: values.fromAddress,
        toAddress: values.toAddress,
        amountRaw: values.amountRaw,
        decimals: values.decimals,
        blockNumber: values.blockNumber,
        blockHash: values.blockHash,
        blockTimestamp: values.blockTimestamp,
        kind: values.kind,
        epochId: values.epochId,
      },
    });
}

/** Peta tx hash → epoch id untuk semua epoch yang sudah executed. */
export async function loadEpochBurnTxHashes(): Promise<Map<string, string>> {
  const rows = await db
    .select({ id: burnEpochs.id, txHashes: burnEpochs.txHashes })
    .from(burnEpochs)
    .where(eq(burnEpochs.status, "executed"));

  const map = new Map<string, string>();
  for (const row of rows) {
    for (const tx of row.txHashes) map.set(tx.toLowerCase(), row.id);
  }
  return map;
}

export function listTokenBurns(limit = 200) {
  return db
    .select()
    .from(tokenBurns)
    .orderBy(desc(tokenBurns.blockNumber), desc(tokenBurns.logIndex))
    .limit(limit);
}

export interface TokenBurnStats {
  totalRaw: bigint;
  teamRaw: bigint;
  epochRaw: bigint;
  communityRaw: bigint;
  counts: Record<TokenBurnKind, number>;
}

/** Total exact per jenis, dihitung di database (bukan float). */
export async function getTokenBurnStats(): Promise<TokenBurnStats> {
  const [totals, counts] = await Promise.all([
    db
      .select({
        kind: tokenBurns.kind,
        total: sql<string>`coalesce(sum(${tokenBurns.amountRaw}), 0)`,
      })
      .from(tokenBurns)
      .groupBy(tokenBurns.kind),
    db
      .select({
        kind: tokenBurns.kind,
        count: sql<number>`count(*)::int`,
      })
      .from(tokenBurns)
      .groupBy(tokenBurns.kind),
  ]);

  const byKind: Record<TokenBurnKind, bigint> = {
    team: 0n,
    epoch: 0n,
    community: 0n,
  };
  for (const row of totals) byKind[row.kind] = toBigInt(row.total);

  const countByKind: Record<TokenBurnKind, number> = {
    team: 0,
    epoch: 0,
    community: 0,
  };
  for (const row of counts) countByKind[row.kind] = Number(row.count) || 0;

  return {
    totalRaw: byKind.team + byKind.epoch + byKind.community,
    teamRaw: byKind.team,
    epochRaw: byKind.epoch,
    communityRaw: byKind.community,
    counts: countByKind,
  };
}

/** Base-unit integer → string desimal (mis. `28061822.210522966378459998`). */
export function formatTokenAmount(raw: bigint, decimals: number): string {
  return formatUnits(raw, decimals);
}

/**
 * Persentase dari total supply dengan 8 desimal (string, tanpa tanda `%`).
 * Dihitung integer-only agar tidak kehilangan presisi.
 */
export function burnedPercent(totalRaw: bigint, supplyRaw: bigint): string {
  if (supplyRaw <= 0n) return "0.00000000";
  const scale = 100_000_000n;
  const scaled = (totalRaw * 100n * scale) / supplyRaw;
  const whole = scaled / scale;
  const fraction = (scaled % scale).toString().padStart(8, "0");
  return `${whole}.${fraction}`;
}

/** Baris burn yang berada di jendela reorg, untuk pemeriksaan block hash. */
export function listTokenBurnsForReorg(head: bigint, lookbackBlocks: bigint, limit = 500) {
  const minBlock = head > lookbackBlocks ? head - lookbackBlocks : 0n;
  return db
    .select({
      id: tokenBurns.id,
      chainTx: tokenBurns.chainTx,
      logIndex: tokenBurns.logIndex,
      blockNumber: tokenBurns.blockNumber,
      blockHash: tokenBurns.blockHash,
    })
    .from(tokenBurns)
    .where(gte(tokenBurns.blockNumber, Number(minBlock)))
    .limit(limit);
}

export async function deleteTokenBurn(id: string): Promise<void> {
  await db.delete(tokenBurns).where(eq(tokenBurns.id, id));
}

function toBigInt(value: string | number | null | undefined): bigint {
  if (value === null || value === undefined) return 0n;
  const text = String(value).trim();
  if (text === "" || text === "0") return 0n;
  // numeric(78,0) selalu berupa digit; fallback ini hanya untuk driver yang
  // mengembalikan notasi desimal/ilmiah.
  if (/^\d+$/.test(text)) return BigInt(text);
  const [whole = "0", fraction = ""] = text.split(".");
  return BigInt((whole || "0") + fraction);
}
