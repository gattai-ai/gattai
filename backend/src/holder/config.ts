import { getParams } from "../config";
import { isProd } from "../env";

/**
 * Nilai turunan konfigurasi worker holder.
 *
 * Semua jalur (worker, health, CLI) memakai helper ini supaya override staging
 * tidak tersebar dan produksi tetap memakai default 24 jam / 12 jam.
 */

export function getHolderSnapshotIntervalMs(): number {
  const holder = getParams().holder;
  if (holder.snapshot_interval_minutes !== undefined) {
    if (isProd()) {
      throw new Error(
        "HOLDER_SNAPSHOT_INTERVAL_MINUTES is staging-only and must not be set in production.",
      );
    }
    return holder.snapshot_interval_minutes * 60_000;
  }
  return holder.snapshot_interval_hours * 60 * 60_000;
}

export function getHolderSnapshotIntervalSeconds(): number {
  return Math.floor(getHolderSnapshotIntervalMs() / 1000);
}

export function getHolderTierMinGapHours(): number {
  const holder = getParams().holder;
  if (holder.tier_min_gap_minutes !== undefined) {
    if (isProd()) {
      throw new Error(
        "HOLDER_TIER_MIN_GAP_MINUTES is staging-only and must not be set in production.",
      );
    }
    return holder.tier_min_gap_minutes / 60;
  }
  return 12;
}

export function getHolderTierMinGapSeconds(): number {
  return Math.floor(getHolderTierMinGapHours() * 60 * 60);
}

export function getHolderSnapshotConcurrency(): number {
  return getParams().holder.snapshot_concurrency;
}

export function getHolderSnapshotBatchSize(): number {
  return getParams().holder.snapshot_batch_size;
}

export function getHolderSnapshotJitterRatio(): number {
  return getParams().holder.snapshot_jitter_ratio;
}

export function getHolderSnapshotRetentionDays(): number {
  return getParams().holder.snapshot_retention_days;
}

export function getHolderSnapshotRetentionMinPerWallet(): number {
  return getParams().holder.snapshot_retention_min_per_wallet;
}
