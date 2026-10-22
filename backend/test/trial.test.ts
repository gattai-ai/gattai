import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import app from "../src/app";
import { db } from "../src/db";
import { apiKeys, projects, runs } from "../src/db/schema";
import { getBalanceMicro, recordCreditLot } from "../src/billing/ledger";
import { readTrialState } from "../src/billing/trial";
import { getParams } from "../src/config";
import { generateApiKey, hashSecret } from "../src/lib/crypto";
import { newId } from "../src/lib/id";
import { creditsToMicro } from "../src/lib/money";
import { getRun, syncRecipes } from "../src/orchestration/create-run";
import { reapStaleRuns } from "../src/orchestration/reap";
import { installFetch, makeMockFetch } from "./helpers/mock-fetch";

/**
 * Kuota trial gratis per wallet. Semua hitungan **diturunkan** dari tabel
 * `runs`, jadi test ini menekankan: (a) run trial tidak menyentuh ledger,
 * (b) refund terjadi sendiri saat status menjadi RELEASED tanpa output,
 * (c) batas percobaan menahan penyalahgunaan, (d) klaim bersamaan tidak
 * melewati kuota.
 */

let restoreFetch: () => void;

const TRIAL_FREE_RUNS = getParams().trial.free_runs;
const TRIAL_MAX_ATTEMPTS = getParams().trial.max_attempts;

beforeAll(async () => {
  restoreFetch = installFetch(makeMockFetch());
  await syncRecipes();
});

afterAll(() => {
  restoreFetch?.();
});

function jsonHeaders(secret: string): Record<string, string> {
  return { authorization: `Bearer ${secret}`, "content-type": "application/json" };
}

/** Project tanpa saldo + API key, siap memakai kuota trial. */
async function newUnfundedProject(name: string): Promise<{ id: string; secret: string }> {
  const id = newId("prj");
  await db.insert(projects).values({
    id,
    name,
    ownerWallet: `0x${id.slice(-40).padStart(40, "0")}`.toLowerCase(),
  });
  const generated = generateApiKey();
  await db.insert(apiKeys).values({
    id: newId("key"),
    projectId: id,
    prefix: generated.prefix,
    hash: hashSecret(generated.secret),
    label: name,
  });
  return { id, secret: generated.secret };
}

/** Baris run trial mentah, untuk menguji predikat tanpa eksekusi nyata. */
async function seedTrialRun(input: {
  projectId: string;
  status: (typeof runs.$inferSelect)["status"];
  withOutput: boolean;
  createdAt?: Date;
  mode?: "streaming" | "async" | "mixed";
}): Promise<string> {
  const id = newId("run");
  await db.insert(runs).values({
    id,
    projectId: input.projectId,
    recipeId: "refine",
    status: input.status,
    mode: input.mode ?? "streaming",
    input: "seed",
    isTrial: true,
    output: input.withOutput ? { type: "streaming", content: "ok" } : null,
    error: input.withOutput ? null : "seed failure",
    createdAt: input.createdAt ?? new Date(),
    idempotencyKey: newId("idem"),
  });
  return id;
}

async function waitForTerminal(secret: string, runId: string): Promise<string> {
  let status = "CREATED";
  for (let i = 0; i < 100; i++) {
    const res = await app.request(`/v1/runs/${runId}`, { headers: jsonHeaders(secret) });
    status = ((await res.json()) as { status: string }).status;
    if (["SETTLED", "RELEASED", "INSUFFICIENT_BALANCE"].includes(status)) return status;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return status;
}

describe("kuota trial: run gratis tanpa menyentuh ledger", () => {
  test("run trial ditandai is_trial, charged 0, saldo tidak bergerak", async () => {
    const { id, secret } = await newUnfundedProject("trial-basic");
    const balanceBefore = await getBalanceMicro(id);

    const res = await app.request("/v1/runs", {
      method: "POST",
      headers: jsonHeaders(secret),
      body: JSON.stringify({ recipe_id: "refine", input: "Halo dari kuota gratis." }),
    });
    expect(res.status).toBe(202);
    const created = (await res.json()) as { run_id: string; status: string; is_trial: boolean };
    expect(created.is_trial).toBe(true);

    expect(await waitForTerminal(secret, created.run_id)).toBe("SETTLED");

    const row = (await db.select().from(runs).where(eq(runs.id, created.run_id)))[0];
    expect(row.isTrial).toBe(true);
    expect(row.chargedMicro).toBe(0);
    expect(row.reservedMicro).toBe(0);
    // Biaya provider tetap dicatat (transparansi + dasar perhitungan burn).
    expect(Number(row.providerCostUsd)).toBeGreaterThan(0);

    // Ledger tidak bergerak sama sekali: tidak ada RESERVE/SETTLE/RELEASE.
    expect(await getBalanceMicro(id)).toBe(balanceBefore);

    // Bentuk API-nya juga benar.
    const info = (await (
      await app.request(`/v1/runs/${created.run_id}`, { headers: jsonHeaders(secret) })
    ).json()) as {
      is_trial: boolean;
      cost: { charged_micro: number; reserved_micro: number; provider_cost_usd: number };
    };
    expect(info.is_trial).toBe(true);
    expect(info.cost.charged_micro).toBe(0);
    expect(info.cost.reserved_micro).toBe(0);
    expect(info.cost.provider_cost_usd).toBeGreaterThan(0);

    // Kuota terpakai satu.
    const state = await readTrialState(db, id, TRIAL_FREE_RUNS, TRIAL_MAX_ATTEMPTS);
    expect(state.textUsed).toBe(1);
    expect(state.remaining).toBe(TRIAL_FREE_RUNS - 1);
  });
});

describe("kuota trial: batas klaim", () => {
  test("15 permintaan teks bersamaan → tepat 10 lolos, 5 ditolak, tidak overshoot", async () => {
    const { id, secret } = await newUnfundedProject("trial-race");
    const body = JSON.stringify({ recipe_id: "refine", input: "Halo serentak." });

    const results = await Promise.all(
      Array.from({ length: 15 }, () =>
        app.request("/v1/runs", { method: "POST", headers: jsonHeaders(secret), body }),
      ),
    );

    expect(results.filter((res) => res.status === 202)).toHaveLength(TRIAL_FREE_RUNS);
    expect(results.filter((res) => res.status === 402)).toHaveLength(15 - TRIAL_FREE_RUNS);

    const state = await readTrialState(db, id, TRIAL_FREE_RUNS, TRIAL_MAX_ATTEMPTS);
    expect(state.textUsed).toBe(TRIAL_FREE_RUNS);
    expect(state.attempts).toBe(TRIAL_FREE_RUNS);
    expect(state.remaining).toBe(0);

    // Tunggu semua run selesai sebelum mock fetch dicabut di `afterAll`.
    const accepted = results.filter((res) => res.status === 202);
    const acceptedIds = await Promise.all(
      accepted.map(async (res) => ((await res.json()) as { run_id: string }).run_id),
    );
    for (const runId of acceptedIds) {
      expect(await waitForTerminal(secret, runId)).toBe("SETTLED");
    }
  });

  test("jatah media dibatasi terpisah: percobaan ke-3 ditolak walau kuota masih ada", async () => {
    const { id, secret } = await newUnfundedProject("trial-media-cap");
    const body = JSON.stringify({ recipe_id: "visual", input: "Banner serentak." });

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        app.request("/v1/runs", { method: "POST", headers: jsonHeaders(secret), body }),
      ),
    );

    const mediaLimit = getParams().trial.free_media_attempts;
    expect(results.filter((res) => res.status === 202)).toHaveLength(mediaLimit);
    expect(results.filter((res) => res.status === 402)).toHaveLength(5 - mediaLimit);

    const state = await readTrialState(db, id, TRIAL_FREE_RUNS, TRIAL_MAX_ATTEMPTS);
    expect(state.mediaAttempts).toBe(mediaLimit);
    // Anggaran teks dan media mandiri: 2 run media tidak menyentuh kuota teks.
    expect(state.textUsed).toBe(0);
    expect(state.remaining).toBe(TRIAL_FREE_RUNS);
  });

  test("media gagal tidak memulihkan jatah media (refund bukan pengampunan)", async () => {
    const { id, secret } = await newUnfundedProject("trial-media-refund");
    const mediaLimit = getParams().trial.free_media_attempts;
    for (let i = 0; i < mediaLimit; i++) {
      await seedTrialRun({
        projectId: id,
        status: "RELEASED",
        withOutput: false,
        mode: "async",
      });
    }

    const state = await readTrialState(db, id, TRIAL_FREE_RUNS, TRIAL_MAX_ATTEMPTS);
    // Kuota umum pulih karena tidak ada output…
    expect(state.textUsed).toBe(0);
    expect(state.remaining).toBe(TRIAL_FREE_RUNS);
    // …tapi jatah media tetap terpakai.
    expect(state.mediaAttempts).toBe(mediaLimit);

    const res = await app.request("/v1/runs", {
      method: "POST",
      headers: jsonHeaders(secret),
      body: JSON.stringify({ recipe_id: "visual", input: "Banner lagi." }),
    });
    expect(res.status).toBe(402);
  });

  test("10 prompt teks habis → jatah media tetap utuh dan masih gratis", async () => {
    const { id, secret } = await newUnfundedProject("trial-text-then-media");
    for (let i = 0; i < TRIAL_FREE_RUNS; i++) {
      await seedTrialRun({ projectId: id, status: "SETTLED", withOutput: true });
    }

    const exhausted = await readTrialState(db, id, TRIAL_FREE_RUNS, TRIAL_MAX_ATTEMPTS);
    expect(exhausted.remaining).toBe(0);
    expect(exhausted.mediaAttempts).toBe(0);

    // Formasi teks ditolak…
    const text = await app.request("/v1/runs", {
      method: "POST",
      headers: jsonHeaders(secret),
      body: JSON.stringify({ recipe_id: "refine", input: "Teks ke-11." }),
    });
    expect(text.status).toBe(402);
    expect(((await text.json()) as { error: { code: string } }).error.code).toBe("TRIAL_EXHAUSTED");

    // …tapi media masih gratis. Inti dari dua anggaran yang mandiri: dulu
    // `remaining = 0` menutup jalur media, jadi 2 jatah media menjadi stok mati.
    const media = await app.request("/v1/runs", {
      method: "POST",
      headers: jsonHeaders(secret),
      body: JSON.stringify({ recipe_id: "visual", input: "Banner setelah teks habis." }),
    });
    expect(media.status).toBe(202);
    expect(((await media.json()) as { is_trial: boolean }).is_trial).toBe(true);
  });

  test("2 media dulu → 10 prompt teks tetap gratis (anggaran tidak saling makan)", async () => {
    const { id, secret } = await newUnfundedProject("trial-media-then-text");
    const mediaLimit = getParams().trial.free_media_attempts;
    for (let i = 0; i < mediaLimit; i++) {
      await seedTrialRun({ projectId: id, status: "SETTLED", withOutput: true, mode: "async" });
    }

    const seeded = await readTrialState(db, id, TRIAL_FREE_RUNS, TRIAL_MAX_ATTEMPTS);
    expect(seeded.mediaAttempts).toBe(mediaLimit);
    expect(seeded.remaining).toBe(TRIAL_FREE_RUNS);

    const text = await app.request("/v1/runs", {
      method: "POST",
      headers: jsonHeaders(secret),
      body: JSON.stringify({ recipe_id: "refine", input: "Teks setelah media." }),
    });
    expect(text.status).toBe(202);
    const created = (await text.json()) as { run_id: string; is_trial: boolean };
    expect(created.is_trial).toBe(true);
    expect(await waitForTerminal(secret, created.run_id)).toBe("SETTLED");

    // Jatah media habis tapi kuota teks masih ada → kode yang jujur.
    const media = await app.request("/v1/runs", {
      method: "POST",
      headers: jsonHeaders(secret),
      body: JSON.stringify({ recipe_id: "visual", input: "Banner ke-3." }),
    });
    expect(media.status).toBe(402);
    expect(((await media.json()) as { error: { code: string } }).error.code).toBe(
      "TRIAL_MEDIA_EXHAUSTED",
    );
  });

  test("teks dan media habis → 402 TRIAL_EXHAUSTED, bukan pesan 'teks masih gratis'", async () => {
    const { id, secret } = await newUnfundedProject("trial-both-exhausted");
    const mediaLimit = getParams().trial.free_media_attempts;
    for (let i = 0; i < TRIAL_FREE_RUNS; i++) {
      await seedTrialRun({ projectId: id, status: "SETTLED", withOutput: true });
    }
    for (let i = 0; i < mediaLimit; i++) {
      await seedTrialRun({ projectId: id, status: "SETTLED", withOutput: true, mode: "async" });
    }

    const res = await app.request("/v1/runs", {
      method: "POST",
      headers: jsonHeaders(secret),
      body: JSON.stringify({ recipe_id: "video", input: "Video terakhir." }),
    });
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("TRIAL_EXHAUSTED");
    expect(body.error.message).not.toContain("still free");
  });

  test("kuota habis → 402 TRIAL_EXHAUSTED + topup_url", async () => {
    const { id, secret } = await newUnfundedProject("trial-exhausted");
    for (let i = 0; i < TRIAL_FREE_RUNS; i++) {
      await seedTrialRun({ projectId: id, status: "SETTLED", withOutput: true });
    }

    const res = await app.request("/v1/runs", {
      method: "POST",
      headers: jsonHeaders(secret),
      body: JSON.stringify({ recipe_id: "refine", input: "Satu lagi." }),
    });
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: { code: string; topup_url: string } };
    expect(body.error.code).toBe("TRIAL_EXHAUSTED");
    expect(body.error.topup_url).toBe("/app/balance");
  });

  test("batas percobaan menutup pintu walau semua gagal dan di-refund", async () => {
    const { id, secret } = await newUnfundedProject("trial-attempts");
    for (let i = 0; i < TRIAL_MAX_ATTEMPTS; i++) {
      await seedTrialRun({ projectId: id, status: "RELEASED", withOutput: false });
    }

    // Semua di-refund, jadi kuota masih penuh…
    const state = await readTrialState(db, id, TRIAL_FREE_RUNS, TRIAL_MAX_ATTEMPTS);
    expect(state.textUsed).toBe(0);
    expect(state.remaining).toBe(TRIAL_FREE_RUNS);
    // …tapi percobaan sudah habis: penjaga biaya platform.
    expect(state.attempts).toBe(TRIAL_MAX_ATTEMPTS);

    const res = await app.request("/v1/runs", {
      method: "POST",
      headers: jsonHeaders(secret),
      body: JSON.stringify({ recipe_id: "refine", input: "Percobaan ke-31." }),
    });
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("TRIAL_ATTEMPTS_EXHAUSTED");
  });
});

describe("kuota trial: refund otomatis", () => {
  test("predikat: tanpa output tidak dihitung, sedang berjalan dihitung", async () => {
    const { id } = await newUnfundedProject("trial-predicate");
    await seedTrialRun({ projectId: id, status: "SETTLED", withOutput: true });
    await seedTrialRun({ projectId: id, status: "RELEASED", withOutput: false });
    await seedTrialRun({ projectId: id, status: "RUNNING", withOutput: true });
    await seedTrialRun({ projectId: id, status: "CREATED", withOutput: false });
    await seedTrialRun({ projectId: id, status: "AWAITING_CONFIRMATION", withOutput: false });

    const state = await readTrialState(db, id, TRIAL_FREE_RUNS, TRIAL_MAX_ATTEMPTS);
    expect(state.attempts).toBe(5);
    expect(state.textUsed).toBe(4);
    expect(state.remaining).toBe(TRIAL_FREE_RUNS - 4);
  });

  test("reaper menghapus estimasi media kedaluwarsa → jatah media DAN percobaan kembali", async () => {
    const { id } = await newUnfundedProject("trial-refund");
    const runId = await seedTrialRun({
      projectId: id,
      status: "AWAITING_CONFIRMATION",
      withOutput: false,
      mode: "async",
      createdAt: new Date(Date.now() - 2 * 3600_000),
    });
    // Klaim terjadi saat create: percobaan media tercatat walau belum dikonfirmasi.
    const before = await readTrialState(db, id, TRIAL_FREE_RUNS, TRIAL_MAX_ATTEMPTS);
    expect(before.mediaAttempts).toBe(1);
    expect(before.textUsed).toBe(0);

    const reaped = await reapStaleRuns({ staleAfterMs: 3600_000, confirmExpiryMs: 3600_000 });
    expect(reaped.runIds).toContain(runId);

    // Barisnya dihapus, sama seperti `POST /:id/cancel`: run ini tidak pernah
    // memanggil provider, jadi seluruh jatahnya kembali — termasuk jatah media.
    expect(await getRun(runId)).toBeUndefined();
    const after = await readTrialState(db, id, TRIAL_FREE_RUNS, TRIAL_MAX_ATTEMPTS);
    expect(after.textUsed).toBe(0);
    expect(after.remaining).toBe(TRIAL_FREE_RUNS);
    expect(after.attempts).toBe(0);
    expect(after.mediaAttempts).toBe(0);
  });

  test("refund run media yang SUDAH dieksekusi tetap tidak memulihkan jatah media", async () => {
    const { id } = await newUnfundedProject("trial-refund-executed");
    // Run media yang benar-benar berjalan lalu gagal: status RELEASED tanpa
    // output. Beda dengan run yang tak pernah dikonfirmasi — di sini provider
    // sudah dipanggil, jadi jatah media HARUS tetap terpakai.
    await seedTrialRun({ projectId: id, status: "RELEASED", withOutput: false, mode: "async" });

    const state = await readTrialState(db, id, TRIAL_FREE_RUNS, TRIAL_MAX_ATTEMPTS);
    expect(state.mediaAttempts).toBe(1);
    expect(state.attempts).toBe(1);
    expect(state.textUsed).toBe(0);
  });
});

describe("kuota trial: pembatalan run media", () => {
  test("cancel mengembalikan kuota teks DAN jatah media (run belum jalan)", async () => {
    const { id, secret } = await newUnfundedProject("trial-cancel");
    const created = await app.request("/v1/runs", {
      method: "POST",
      headers: jsonHeaders(secret),
      body: JSON.stringify({ recipe_id: "visual", input: "Banner yang dibatalkan." }),
    });
    expect(created.status).toBe(202);
    const { run_id } = (await created.json()) as { run_id: string };

    const before = await readTrialState(db, id, TRIAL_FREE_RUNS, TRIAL_MAX_ATTEMPTS);
    expect(before.mediaAttempts).toBe(1);
    // Run media mengklaim anggaran media saja, bukan kuota teks.
    expect(before.textUsed).toBe(0);

    const cancelled = await app.request(`/v1/runs/${run_id}/cancel`, {
      method: "POST",
      headers: jsonHeaders(secret),
    });
    expect(cancelled.status).toBe(200);

    const after = await readTrialState(db, id, TRIAL_FREE_RUNS, TRIAL_MAX_ATTEMPTS);
    expect(after.textUsed).toBe(0);
    expect(after.attempts).toBe(0);
    expect(after.mediaAttempts).toBe(0);
    expect(after.remaining).toBe(TRIAL_FREE_RUNS);

    // Baris run benar-benar hilang.
    const gone = await app.request(`/v1/runs/${run_id}`, { headers: jsonHeaders(secret) });
    expect(gone.status).toBe(404);

    // Jatah media kembali: formasi media berikutnya tetap gratis.
    const again = await app.request("/v1/runs", {
      method: "POST",
      headers: jsonHeaders(secret),
      body: JSON.stringify({ recipe_id: "visual", input: "Banner pengganti." }),
    });
    expect(again.status).toBe(202);
    expect(((await again.json()) as { is_trial: boolean }).is_trial).toBe(true);
  });

  test("cancel hanya berlaku untuk run yang belum dikonfirmasi", async () => {
    const { id, secret } = await newUnfundedProject("trial-cancel-status");
    const runId = await seedTrialRun({ projectId: id, status: "SETTLED", withOutput: true });

    const res = await app.request(`/v1/runs/${runId}/cancel`, {
      method: "POST",
      headers: jsonHeaders(secret),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_STATUS");

    // Run lama tidak boleh terhapus.
    expect((await db.select().from(runs).where(eq(runs.id, runId))).length).toBe(1);
  });

  test("jatah media habis tapi kuota teks masih ada → 402 TRIAL_MEDIA_EXHAUSTED", async () => {
    const { id, secret } = await newUnfundedProject("trial-media-exhausted");
    const mediaLimit = getParams().trial.free_media_attempts;
    for (let i = 0; i < mediaLimit; i++) {
      await seedTrialRun({ projectId: id, status: "SETTLED", withOutput: true, mode: "async" });
    }
    for (let i = 0; i < 3; i++) {
      await seedTrialRun({ projectId: id, status: "SETTLED", withOutput: true });
    }

    const res = await app.request("/v1/runs", {
      method: "POST",
      headers: jsonHeaders(secret),
      body: JSON.stringify({ recipe_id: "video", input: "Video lagi." }),
    });
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: { code: string; topup_url: string } };
    expect(body.error.code).toBe("TRIAL_MEDIA_EXHAUSTED");
    expect(body.error.topup_url).toBe("/app/balance");

    // Bukti pesannya tidak menyesatkan: formasi teks tetap gratis.
    const text = await app.request("/v1/runs", {
      method: "POST",
      headers: jsonHeaders(secret),
      body: JSON.stringify({ recipe_id: "refine", input: "Teks masih gratis." }),
    });
    expect(text.status).toBe(202);
    const created = (await text.json()) as { run_id: string; is_trial: boolean };
    expect(created.is_trial).toBe(true);
    expect(await waitForTerminal(secret, created.run_id)).toBe("SETTLED");
  });
});

describe("kuota trial: idempotency & saldo cukup", () => {
  test("replay Idempotency-Key tidak menambah percobaan", async () => {
    const { id, secret } = await newUnfundedProject("trial-idem");
    const headers = { ...jsonHeaders(secret), "Idempotency-Key": `trial-idem-${newId("t")}` };
    const body = JSON.stringify({ recipe_id: "visual", input: "Body sama." });

    const first = await app.request("/v1/runs", { method: "POST", headers, body });
    const second = await app.request("/v1/runs", { method: "POST", headers, body });
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(((await second.json()) as { run_id: string }).run_id).toBe(
      ((await first.json()) as { run_id: string }).run_id,
    );

    const state = await readTrialState(db, id, TRIAL_FREE_RUNS, TRIAL_MAX_ATTEMPTS);
    expect(state.attempts).toBe(1);
  });

  test("saldo cukup → tetap pakai kuota gratis lebih dulu", async () => {
    const { id, secret } = await newUnfundedProject("trial-funded");
    await recordCreditLot({
      projectId: id,
      source: "PROMO",
      amountMicro: creditsToMicro(100),
      idempotencyKey: `fund:${id}`,
    });
    const balanceBefore = await getBalanceMicro(id);

    const res = await app.request("/v1/runs", {
      method: "POST",
      headers: jsonHeaders(secret),
      body: JSON.stringify({ recipe_id: "refine", input: "Halo dari kuota gratis." }),
    });
    expect(res.status).toBe(202);
    const created = (await res.json()) as { run_id: string; is_trial: boolean };
    expect(created.is_trial).toBe(true);
    expect(await waitForTerminal(secret, created.run_id)).toBe("SETTLED");

    // Saldo tidak bergerak walau project punya credit.
    expect(await getBalanceMicro(id)).toBe(balanceBefore);
    const state = await readTrialState(db, id, TRIAL_FREE_RUNS, TRIAL_MAX_ATTEMPTS);
    expect(state.textUsed).toBe(1);
    expect(state.remaining).toBe(TRIAL_FREE_RUNS - 1);
  });

  test("kuota habis tapi saldo cukup → run berbayar (charged > 0)", async () => {
    const { id, secret } = await newUnfundedProject("trial-then-paid");
    await recordCreditLot({
      projectId: id,
      source: "PROMO",
      amountMicro: creditsToMicro(100),
      idempotencyKey: `fund:${id}`,
    });
    for (let i = 0; i < TRIAL_FREE_RUNS; i++) {
      await seedTrialRun({ projectId: id, status: "SETTLED", withOutput: true });
    }

    const res = await app.request("/v1/runs", {
      method: "POST",
      headers: jsonHeaders(secret),
      body: JSON.stringify({ recipe_id: "refine", input: "Lanjut berbayar." }),
    });
    expect(res.status).toBe(202);
    const created = (await res.json()) as { run_id: string; is_trial: boolean };
    expect(created.is_trial).toBe(false);
    expect(await waitForTerminal(secret, created.run_id)).toBe("SETTLED");

    const row = (await db.select().from(runs).where(eq(runs.id, created.run_id)))[0];
    expect(row.isTrial).toBe(false);
    expect(row.chargedMicro).toBeGreaterThan(0);
  });

  test("batas percobaan tidak memblokir run berbayar wallet bersaldo", async () => {
    const { id, secret } = await newUnfundedProject("trial-attempts-funded");
    await recordCreditLot({
      projectId: id,
      source: "PROMO",
      amountMicro: creditsToMicro(100),
      idempotencyKey: `fund:${id}`,
    });
    for (let i = 0; i < TRIAL_MAX_ATTEMPTS; i++) {
      await seedTrialRun({ projectId: id, status: "RELEASED", withOutput: false });
    }

    // Percobaan gratis habis, tapi credit sendiri tetap boleh dibelanjakan.
    const res = await app.request("/v1/runs", {
      method: "POST",
      headers: jsonHeaders(secret),
      body: JSON.stringify({ recipe_id: "refine", input: "Bayar sendiri." }),
    });
    expect(res.status).toBe(202);
    const created = (await res.json()) as { run_id: string; is_trial: boolean };
    expect(created.is_trial).toBe(false);
    expect(await waitForTerminal(secret, created.run_id)).toBe("SETTLED");
  });

  test("GET /v1/project menyertakan kuota trial", async () => {
    const { id, secret } = await newUnfundedProject("trial-project-info");
    await seedTrialRun({ projectId: id, status: "SETTLED", withOutput: true });

    const info = (await (
      await app.request("/v1/project", { headers: jsonHeaders(secret) })
    ).json()) as {
      trial: {
        limit: number;
        text_used: number;
        remaining: number;
        attempts_limit: number;
        media_limit: number;
        media_used: number;
      };
    };
    expect(info.trial.limit).toBe(TRIAL_FREE_RUNS);
    expect(info.trial.text_used).toBe(1);
    expect(info.trial.remaining).toBe(TRIAL_FREE_RUNS - 1);
    expect(info.trial.attempts_limit).toBe(TRIAL_MAX_ATTEMPTS);
    expect(info.trial.media_limit).toBe(getParams().trial.free_media_attempts);
    expect(info.trial.media_used).toBe(0);
  });
});
