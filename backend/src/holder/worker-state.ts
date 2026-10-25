import { eq } from "drizzle-orm";
import { getParams } from "../config";
import { db } from "../db";
import { holderWorkerState } from "../db/schema";
import { env } from "../env";
import {
  getHolderSnapshotIntervalSeconds,
  getHolderTierMinGapSeconds,
} from "./config";

export const HOLDER_WORKER_STATE_ID = "holder-snapshot";

export interface HolderWorkerStateRow {
  id: string;
  lastCycleStartedAt: Date | null;
  lastCycleFinishedAt: Date | null;
  lastSuccessAt: Date | null;
  lastScanned: number;
  lastRecorded: number;
  lastSkipped: number;
  lastErrors: number;
  lastError: string | null;
  lastErrorAt: Date | null;
  updatedAt: Date;
}

export type HolderWorkerHealthStatus =
  | "ok"
  | "degraded"
  | "stale"
  | "disabled"
  | "running"
  | "unavailable";

export interface HolderWorkerHealth {
  status: HolderWorkerHealthStatus;
  enabled: boolean;
  interval_seconds: number;
  tier_min_gap_seconds: number;
  last_cycle_started_at: string | null;
  last_cycle_finished_at: string | null;
  last_success_at: string | null;
  age_seconds: number | null;
  last_scanned: number;
  last_recorded: number;
  last_skipped: number;
  last_errors: number;
  last_error_at: string | null;
  last_error_present: boolean;
  cycle_running: boolean;
}

export async function getHolderWorkerState(): Promise<HolderWorkerStateRow | null> {
  const [row] = await db
    .select()
    .from(holderWorkerState)
    .where(eq(holderWorkerState.id, HOLDER_WORKER_STATE_ID))
    .limit(1);
  return row ?? null;
}

export async function markHolderCycleStarted(startedAt = new Date()): Promise<void> {
  await db
    .insert(holderWorkerState)
    .values({
      id: HOLDER_WORKER_STATE_ID,
      lastCycleStartedAt: startedAt,
      updatedAt: startedAt,
    })
    .onConflictDoUpdate({
      target: holderWorkerState.id,
      set: {
        lastCycleStartedAt: startedAt,
        updatedAt: startedAt,
      },
    });
}

export async function markHolderCycleSuccess(input: {
  startedAt: Date;
  finishedAt?: Date;
  scanned: number;
  recorded: number;
  skipped: number;
  errors: number;
  errorMessage?: string | null;
}): Promise<void> {
  const finishedAt = input.finishedAt ?? new Date();
  const errorMessage = input.errorMessage?.slice(0, 1000) ?? null;
  await db
    .insert(holderWorkerState)
    .values({
      id: HOLDER_WORKER_STATE_ID,
      lastCycleStartedAt: input.startedAt,
      lastCycleFinishedAt: finishedAt,
      lastSuccessAt: finishedAt,
      lastScanned: input.scanned,
      lastRecorded: input.recorded,
      lastSkipped: input.skipped,
      lastErrors: input.errors,
      lastError: errorMessage,
      lastErrorAt: errorMessage ? finishedAt : null,
      updatedAt: finishedAt,
    })
    .onConflictDoUpdate({
      target: holderWorkerState.id,
      set: {
        lastCycleStartedAt: input.startedAt,
        lastCycleFinishedAt: finishedAt,
        lastSuccessAt: finishedAt,
        lastScanned: input.scanned,
        lastRecorded: input.recorded,
        lastSkipped: input.skipped,
        lastErrors: input.errors,
        lastError: errorMessage,
        lastErrorAt: errorMessage ? finishedAt : null,
        updatedAt: finishedAt,
      },
    });
}

export async function markHolderCycleFailure(
  input: {
    startedAt: Date;
    finishedAt?: Date;
    error: unknown;
  },
): Promise<void> {
  const finishedAt = input.finishedAt ?? new Date();
  const message =
    input.error instanceof Error ? input.error.message : String(input.error);
  const trimmed = message.slice(0, 1000);
  await db
    .insert(holderWorkerState)
    .values({
      id: HOLDER_WORKER_STATE_ID,
      lastCycleStartedAt: input.startedAt,
      lastCycleFinishedAt: finishedAt,
      lastError: trimmed,
      lastErrorAt: finishedAt,
      updatedAt: finishedAt,
    })
    .onConflictDoUpdate({
      target: holderWorkerState.id,
      set: {
        lastCycleStartedAt: input.startedAt,
        lastCycleFinishedAt: finishedAt,
        lastError: trimmed,
        lastErrorAt: finishedAt,
        updatedAt: finishedAt,
      },
    });
}

export async function getHolderWorkerHealth(): Promise<HolderWorkerHealth> {
  const holder = getParams().holder;
  const enabled = holder.enabled && Boolean(env.robinhoodRpcUrl);
  const intervalSeconds = getHolderSnapshotIntervalSeconds();
  const tierMinGapSeconds = getHolderTierMinGapSeconds();

  if (!enabled) {
    return {
      status: "disabled",
      enabled: false,
      interval_seconds: intervalSeconds,
      tier_min_gap_seconds: tierMinGapSeconds,
      last_cycle_started_at: null,
      last_cycle_finished_at: null,
      last_success_at: null,
      age_seconds: null,
      last_scanned: 0,
      last_recorded: 0,
      last_skipped: 0,
      last_errors: 0,
      last_error_at: null,
      last_error_present: false,
      cycle_running: false,
    };
  }

  let state: HolderWorkerStateRow | null;
  try {
    state = await getHolderWorkerState();
  } catch {
    return {
      status: "unavailable",
      enabled: true,
      interval_seconds: intervalSeconds,
      tier_min_gap_seconds: tierMinGapSeconds,
      last_cycle_started_at: null,
      last_cycle_finished_at: null,
      last_success_at: null,
      age_seconds: null,
      last_scanned: 0,
      last_recorded: 0,
      last_skipped: 0,
      last_errors: 0,
      last_error_at: null,
      last_error_present: false,
      cycle_running: false,
    };
  }

  const now = Date.now();
  const lastSuccessMs = state?.lastSuccessAt?.getTime() ?? null;
  const ageSeconds =
    lastSuccessMs === null ? null : Math.max(0, Math.floor((now - lastSuccessMs) / 1000));
  const cycleRunning = Boolean(
    state?.lastCycleStartedAt &&
      (!state.lastCycleFinishedAt ||
        state.lastCycleStartedAt.getTime() > state.lastCycleFinishedAt.getTime()),
  );
  const stale = lastSuccessMs === null || (ageSeconds ?? 0) > intervalSeconds * 2;
  const lastErrorMs = state?.lastErrorAt?.getTime() ?? null;
  const degraded =
    (state?.lastErrors ?? 0) > 0 ||
    (lastErrorMs !== null && (lastSuccessMs === null || lastErrorMs >= lastSuccessMs));

  let status: HolderWorkerHealthStatus;
  if (cycleRunning && lastSuccessMs === null) status = "running";
  else if (stale) status = "stale";
  else if (degraded) status = "degraded";
  else status = "ok";

  return {
    status,
    enabled: true,
    interval_seconds: intervalSeconds,
    tier_min_gap_seconds: tierMinGapSeconds,
    last_cycle_started_at: state?.lastCycleStartedAt?.toISOString() ?? null,
    last_cycle_finished_at: state?.lastCycleFinishedAt?.toISOString() ?? null,
    last_success_at: state?.lastSuccessAt?.toISOString() ?? null,
    age_seconds: ageSeconds,
    last_scanned: state?.lastScanned ?? 0,
    last_recorded: state?.lastRecorded ?? 0,
    last_skipped: state?.lastSkipped ?? 0,
    last_errors: state?.lastErrors ?? 0,
    last_error_at: state?.lastErrorAt?.toISOString() ?? null,
    last_error_present: Boolean(state?.lastError),
    cycle_running: cycleRunning,
  };
}
