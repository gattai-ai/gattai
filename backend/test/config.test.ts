import { describe, expect, test } from "bun:test";
import { getModelByRef, loadConfig, reloadConfig } from "../src/config";
import {
  getHolderSnapshotBatchSize,
  getHolderSnapshotConcurrency,
  getHolderSnapshotIntervalMs,
  getHolderSnapshotJitterRatio,
  getHolderSnapshotRetentionDays,
  getHolderSnapshotRetentionMinPerWallet,
  getHolderTierMinGapHours,
} from "../src/holder/config";

const HOLDER_ENV_KEYS = [
  "HOLDER_SNAPSHOT_INTERVAL_HOURS",
  "HOLDER_SNAPSHOT_INTERVAL_MINUTES",
  "HOLDER_TIER_MIN_GAP_MINUTES",
  "HOLDER_SNAPSHOT_CONCURRENCY",
  "HOLDER_SNAPSHOT_BATCH_SIZE",
  "HOLDER_SNAPSHOT_JITTER_RATIO",
  "HOLDER_SNAPSHOT_RETENTION_DAYS",
  "HOLDER_SNAPSHOT_RETENTION_MIN_PER_WALLET",
] as const;

function withHolderEnv(
  patch: Partial<Record<(typeof HOLDER_ENV_KEYS)[number], string | undefined>>,
  fn: () => void,
): void {
  const saved = HOLDER_ENV_KEYS.map((key) => [key, process.env[key]] as const);
  try {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    reloadConfig();
    fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    reloadConfig();
  }
}

describe("config", () => {
  test("memuat 6 recipe dan profil parameter", () => {
    const config = loadConfig();
    expect(config.recipes.length).toBe(6);
    expect(config.params.pricing.default_markup).toBeGreaterThan(0);
    expect(config.params.context.summary_threshold_chars).toBeGreaterThan(0);
  });

  test("setiap step menunjuk model_ref yang ada dan providernya cocok", () => {
    const config = loadConfig();
    for (const recipe of config.recipes) {
      for (const step of recipe.steps) {
        const model = config.models[step.model_ref];
        expect(model).toBeDefined();
        expect(model.provider).toBe(step.provider);
        // Label tampilan wajib ada dan tidak boleh membocorkan provider internal.
        expect(step.label.length).toBeGreaterThan(0);
        expect(step.label.toLowerCase()).not.toContain("mimo");
        // Role tampilan wajib ada dan juga bebas provider internal.
        expect(step.role_label.length).toBeGreaterThan(0);
        expect(step.role_label.toLowerCase()).not.toContain("mimo");
      }
    }
  });

  test("getModelByRef melempar untuk ref tak dikenal", () => {
    expect(() => getModelByRef("tidak_ada")).toThrow();
  });

  test("default worker holder: 24 jam, gap 12 jam, konkurensi 5, jitter 0.1", () => {
    withHolderEnv(
      {
        HOLDER_SNAPSHOT_INTERVAL_HOURS: undefined,
        HOLDER_SNAPSHOT_INTERVAL_MINUTES: undefined,
        HOLDER_TIER_MIN_GAP_MINUTES: undefined,
        HOLDER_SNAPSHOT_CONCURRENCY: undefined,
        HOLDER_SNAPSHOT_BATCH_SIZE: undefined,
        HOLDER_SNAPSHOT_JITTER_RATIO: undefined,
        HOLDER_SNAPSHOT_RETENTION_DAYS: undefined,
        HOLDER_SNAPSHOT_RETENTION_MIN_PER_WALLET: undefined,
      },
      () => {
        expect(getHolderSnapshotIntervalMs()).toBe(24 * 60 * 60 * 1000);
        expect(getHolderTierMinGapHours()).toBe(12);
        expect(getHolderSnapshotConcurrency()).toBe(5);
        expect(getHolderSnapshotBatchSize()).toBe(500);
        expect(getHolderSnapshotJitterRatio()).toBe(0.1);
        expect(getHolderSnapshotRetentionDays()).toBe(90);
        expect(getHolderSnapshotRetentionMinPerWallet()).toBe(10);
      },
    );
  });

  test("override retensi snapshot terbaca dari env", () => {
    withHolderEnv(
      {
        HOLDER_SNAPSHOT_RETENTION_DAYS: "30",
        HOLDER_SNAPSHOT_RETENTION_MIN_PER_WALLET: "5",
      },
      () => {
        expect(getHolderSnapshotRetentionDays()).toBe(30);
        expect(getHolderSnapshotRetentionMinPerWallet()).toBe(5);
      },
    );
  });

  test("override menit staging mengubah interval dan gap tanpa mengubah kode", () => {
    withHolderEnv(
      {
        HOLDER_SNAPSHOT_INTERVAL_MINUTES: "2",
        HOLDER_TIER_MIN_GAP_MINUTES: "1",
      },
      () => {
        expect(getHolderSnapshotIntervalMs()).toBe(2 * 60 * 1000);
        expect(getHolderTierMinGapHours()).toBeCloseTo(1 / 60, 10);
      },
    );
  });
});
