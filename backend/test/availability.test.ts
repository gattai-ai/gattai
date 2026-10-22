import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import app from "../src/app";
import { getRecipe } from "../src/config";
import { db } from "../src/db";
import { apiKeys, projects, runs } from "../src/db/schema";
import { isProviderConfigured } from "../src/env";
import { generateApiKey, hashSecret } from "../src/lib/crypto";
import { newId } from "../src/lib/id";
import { syncRecipes } from "../src/orchestration/create-run";
import {
  FORMATION_UNAVAILABLE_MESSAGE,
  isRecipeAvailable,
  missingRecipeProviders,
} from "../src/orchestration/availability";
import { suggestRecipe } from "../src/orchestration/router";
import { installFetch, makeMockFetch } from "./helpers/mock-fetch";

/**
 * Ketersediaan formasi: formasi yang provider-nya belum dikonfigurasi (mis.
 * media tanpa key Higgsfield) harus tampak "coming soon" di UI **dan** ditolak
 * di pintu masuk run — satu aturan yang dipakai bersama, bukan dua.
 *
 * Key provider diisi di `test/setup.ts`, jadi test di sini menambalnya keluar
 * untuk meniru deployment teks saja (MIMO), lalu memulihkannya.
 */

const ENV_KEY = "HIGGSFIELD_API_KEY";

async function withEnvAsync<T>(
  name: string,
  value: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const saved = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  }
}

function withEnv<T>(name: string, value: string | undefined, fn: () => T): T {
  const saved = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  }
}

describe("aturan ketersediaan formasi", () => {
  test("hanya MIMO → formasi teks siap, tiga formasi media belum", () => {
    withEnv(ENV_KEY, undefined, () => {
      const available = (id: string) => isRecipeAvailable(getRecipe(id)!);
      expect(available("refine")).toBe(true);
      expect(available("research")).toBe(true);
      expect(available("code")).toBe(true);
      expect(available("visual")).toBe(false);
      expect(available("video")).toBe(false);
      expect(available("launch_kit")).toBe(false);
      // Penyebabnya satu hal saja: provider render media.
      expect(missingRecipeProviders(getRecipe("video")!)).toEqual(["higgsfield"]);
    });
  });

  test("kembali siap begitu key provider diisi", () => {
    withEnv(ENV_KEY, "test-key", () => {
      expect(isRecipeAvailable(getRecipe("visual")!)).toBe(true);
      expect(missingRecipeProviders(getRecipe("visual")!)).toEqual([]);
    });
  });

  test("provider tak dikenal dianggap belum terkonfigurasi (fail-closed)", () => {
    expect(isProviderConfigured("unknown-provider")).toBe(false);
  });

  test("auto tidak menyarankan formasi yang belum siap", () => {
    withEnv(ENV_KEY, undefined, () => {
      expect(suggestRecipe("buatkan video pendek 9:16")).not.toBe("video");
      expect(suggestRecipe("buat logo dan banner")).not.toBe("visual");
      expect(suggestRecipe("launch kit untuk peluncuran produk")).not.toBe("launch_kit");
      // Formasi teks tetap bisa disarankan.
      expect(suggestRecipe("tolong perbaiki bug kode ini")).toBe("code");
    });
  });
});

let secret: string;
let projectId: string;
let restoreFetch: () => void;

const auth = () => ({
  authorization: `Bearer ${secret}`,
  "content-type": "application/json",
});

beforeAll(async () => {
  // Formasi teks benar-benar dieksekusi di salah satu test (untuk membuktikan
  // guard tidak menolaknya), jadi provider harus dimock: tanpa ini test akan
  // menembak jaringan sungguhan.
  restoreFetch = installFetch(makeMockFetch());
  projectId = newId("prj");
  await db.insert(projects).values({
    id: projectId,
    name: "availability-test",
    ownerWallet: `0x${projectId.slice(-40)}`.toLowerCase(),
  });
  const generated = generateApiKey();
  secret = generated.secret;
  await db.insert(apiKeys).values({
    id: newId("key"),
    projectId,
    prefix: generated.prefix,
    hash: hashSecret(secret),
    label: "availability",
  });
  await syncRecipes();
});

afterAll(() => {
  restoreFetch();
});

describe("GET /v1/recipes", () => {
  test("menandai formasi yang provider-nya belum dikonfigurasi", async () => {
    await withEnvAsync(ENV_KEY, undefined, async () => {
      const res = await app.request("/v1/recipes", { headers: auth() });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { recipes: Array<{ id: string; available: boolean }> };
      const byId = new Map(body.recipes.map((recipe) => [recipe.id, recipe.available]));
      expect(byId.get("refine")).toBe(true);
      expect(byId.get("visual")).toBe(false);
      expect(byId.get("video")).toBe(false);
      expect(byId.get("launch_kit")).toBe(false);
    });
  });
});

describe("GET /v1/public/formations", () => {
  test("tanpa auth, memuat status yang sama dan tanpa nama provider", async () => {
    await withEnvAsync(ENV_KEY, undefined, async () => {
      const res = await app.request("/v1/public/formations");
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        formations: Array<{ id: string; name: string; available: boolean }>;
      };
      expect(body.formations.length).toBeGreaterThan(0);
      const visual = body.formations.find((formation) => formation.id === "visual");
      expect(visual?.name).toBe("Visual");
      expect(visual?.available).toBe(false);
      expect(body.formations.find((formation) => formation.id === "refine")?.available).toBe(true);

      const raw = JSON.stringify(body);
      expect(raw).not.toContain("higgsfield");
      expect(raw).not.toContain("HIGGSFIELD");
    });
  });
});

describe("POST /v1/runs", () => {
  test("formasi media tanpa key provider → 503 tanpa membuat run", async () => {
    await withEnvAsync(ENV_KEY, undefined, async () => {
      const res = await app.request("/v1/runs", {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ recipe_id: "visual", input: "Bikin poster produk." }),
      });
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("FORMATION_UNAVAILABLE");
      expect(body.error.message).toBe(FORMATION_UNAVAILABLE_MESSAGE);
      // Pesan publik tidak boleh menyebut provider/env internal.
      expect(body.error.message).not.toContain("HIGGSFIELD");
      expect(body.error.message).not.toContain("higgsfield");
    });

    // Gagal di depan berarti tidak ada baris run (dan tidak ada charge).
    const rows = await db.select().from(runs).where(eq(runs.projectId, projectId));
    expect(rows.length).toBe(0);
  });

  test("formasi teks tetap bisa dibuat saat media belum siap", async () => {
    await withEnvAsync(ENV_KEY, undefined, async () => {
      const res = await app.request("/v1/runs", {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ recipe_id: "refine", input: "Ringkas ini." }),
      });
      // 202/200 sama-sama berarti lolos guard; yang penting bukan 503.
      expect(res.status).not.toBe(503);
    });
  });
});
