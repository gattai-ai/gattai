import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../src/db";
import { projects, runs } from "../src/db/schema";
import { newId } from "../src/lib/id";
import { startReaper } from "../src/orchestration/reap";

/**
 * Test bagian *scheduler* reaper, terpisah dari test perilaku `reapStaleRuns`
 * (di `e2e.test.ts`). Yang diuji: siklus bisa dipicu manual, tidak menumpuk,
 * dan bisa dihentikan.
 */

async function seedStaleRun(): Promise<string> {
  const projectId = newId("prj");
  await db.insert(projects).values({
    id: projectId,
    name: "reaper-sched",
    ownerWallet: `0x${projectId.slice(-40).padStart(40, "0")}`.toLowerCase(),
  });
  const runId = newId("run");
  await db.insert(runs).values({
    id: runId,
    projectId,
    recipeId: "refine",
    recipeVersion: 1,
    status: "RUNNING",
    mode: "streaming",
    input: "macet",
    idempotencyKey: newId("idem"),
    createdAt: new Date(Date.now() - 2 * 3600_000),
    heartbeatAt: new Date(Date.now() - 2 * 3600_000),
  });
  return runId;
}

function start(overrides: Partial<Parameters<typeof startReaper>[0]> = {}) {
  return startReaper({
    staleAfterMs: 3600_000,
    confirmExpiryMs: 3600_000,
    intervalMs: 3600_000,
    immediate: false,
    log: () => {},
    ...overrides,
  });
}

describe("startReaper (scheduler)", () => {
  test("runOnce me-reap run yatim", async () => {
    const runId = await seedStaleRun();
    const handle = start();
    try {
      const result = await handle.runOnce();
      expect(result.runIds).toContain(runId);

      const row = (await db.select().from(runs).where(eq(runs.id, runId)))[0];
      expect(row.status).toBe("RELEASED");
    } finally {
      handle.stop();
    }
  });

  test("siklus yang masih berjalan tidak ditumpuk", async () => {
    await seedStaleRun();
    const handle = start();
    try {
      // Panggilan pertama menahan `busy` sampai query DB selesai; panggilan kedua
      // harus mundur tanpa error dan tanpa hasil ganda.
      const first = handle.runOnce();
      const second = await handle.runOnce();
      expect(second).toEqual({ reaped: 0, runIds: [] });
      await first;
    } finally {
      handle.stop();
    }
  });
});
