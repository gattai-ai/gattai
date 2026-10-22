import { keccak256, toHex } from "viem";

/**
 * ID project onchain = `keccak256(utf8(project.id))` (bytes32).
 * Deterministik, dipakai di `DepositManager.deposit(projectId, ...)` dan
 * dipetakan balik oleh indexer lewat kolom `projects.onchain_id`.
 */
export function onchainProjectId(projectId: string): `0x${string}` {
  return keccak256(toHex(projectId));
}

/** Normalisasi hex bytes32 untuk perbandingan (case-insensitive). */
export function normalizeOnchainId(id: string): string {
  return id.toLowerCase();
}
