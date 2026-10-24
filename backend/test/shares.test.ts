import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import app from "../src/app";
import { db } from "../src/db";
import { apiKeys, conversations, projects, runShares, runSteps, runs } from "../src/db/schema";
import { generateApiKey, hashSecret } from "../src/lib/crypto";
import { newId, SHARE_SLUG_PATTERN } from "../src/lib/id";

/**
 * Share publik `/run/:slug`:
 *  - hanya pemilik yang bisa membuat/mencabut,
 *  - hanya run SETTLED,
 *  - serializer publik tidak membocorkan id/wallet/biaya provider,
 *  - prompt mengikuti toggle `show_prompt`,
 *  - meta HTML/OG dirender server-side dan share yang dicabut mati.
 */

let restoreEnv: () => void;
let templateDir: string;
const OLD_BASE = process.env.PUBLIC_BASE_URL;
const OLD_DIST = process.env.FRONTEND_DIST_DIR;
const OLD_MEDIA = process.env.MEDIA_SHARE_ENABLED;

beforeAll(() => {
  templateDir = mkdtempSync(join(tmpdir(), "gattai-og-"));
  writeFileSync(
    join(templateDir, "index.html"),
    [
      "<!doctype html><html><head>",
      "<!-- SEO_META_START -->",
      "<title>old</title>",
      "<!-- SEO_META_END -->",
      "</head><body><div id=\"root\"></div></body></html>",
    ].join("\n"),
  );
  process.env.PUBLIC_BASE_URL = "https://gattai.test";
  process.env.FRONTEND_DIST_DIR = templateDir;
  delete process.env.MEDIA_SHARE_ENABLED;
  restoreEnv = () => {
    if (OLD_BASE === undefined) delete process.env.PUBLIC_BASE_URL;
    else process.env.PUBLIC_BASE_URL = OLD_BASE;
    if (OLD_DIST === undefined) delete process.env.FRONTEND_DIST_DIR;
    else process.env.FRONTEND_DIST_DIR = OLD_DIST;
    if (OLD_MEDIA === undefined) delete process.env.MEDIA_SHARE_ENABLED;
    else process.env.MEDIA_SHARE_ENABLED = OLD_MEDIA;
  };
});

afterAll(() => {
  restoreEnv();
  rmSync(templateDir, { recursive: true, force: true });
});

function auth(secret: string): Record<string, string> {
  return { authorization: `Bearer ${secret}`, "content-type": "application/json" };
}

async function newProject(name: string): Promise<{ id: string; secret: string }> {
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

interface SeededRun {
  projectId: string;
  conversationId: string;
  runId: string;
}

async function seedRun(input: {
  projectId: string;
  status?: "SETTLED" | "RUNNING";
  prompt?: string;
  output?: unknown;
  chargedMicro?: number;
}): Promise<SeededRun> {
  const conversationId = newId("conv");
  await db.insert(conversations).values({
    id: conversationId,
    projectId: input.projectId,
    title: "Share test",
  });
  const runId = newId("run");
  await db.insert(runs).values({
    id: runId,
    projectId: input.projectId,
    recipeId: "refine",
    status: input.status ?? "SETTLED",
    mode: "streaming",
    conversationId,
    input: input.prompt ?? "Write a sharper landing headline.",
    output: input.output ?? { type: "streaming", content: "Here are three headline options." },
    chargedMicro: input.chargedMicro ?? 12_345_678,
    idempotencyKey: newId("idem"),
    finishedAt: input.status === "SETTLED" || input.status === undefined ? new Date() : null,
  });
  await db.insert(runSteps).values([
    {
      id: newId("step"),
      runId,
      stepId: "interpret",
      provider: "mimo",
      model: "mimo_architect",
      role: "interpret",
      status: "COMPLETE",
      latencyMs: 900,
      output: { type: "json", content: "Internal brief that must not leak as a step id." },
      providerCostUsd: "0.001",
      createdAt: new Date(Date.now() - 1000),
    },
    {
      id: newId("step"),
      runId,
      stepId: "execute",
      provider: "mimo",
      model: "mimo_primary",
      role: "execute",
      status: "COMPLETE",
      latencyMs: 2300,
      output: { type: "streaming", content: "Here are three headline options." },
      providerCostUsd: "0.004",
    },
  ]);
  return { projectId: input.projectId, conversationId, runId };
}

async function createShare(secret: string, runId: string, body: unknown = {}) {
  return app.request(`/v1/runs/${runId}/share`, {
    method: "POST",
    headers: auth(secret),
    body: JSON.stringify(body),
  });
}

describe("share run", () => {
  test("owner can create, read, update toggle, and public page is sanitized", async () => {
    const project = await newProject("share-owner");
    const seeded = await seedRun({ projectId: project.id, prompt: "Private prompt text." });

    const created = await createShare(project.secret, seeded.runId, { show_prompt: false });
    expect(created.status).toBe(200);
    const share = (await created.json()) as {
      slug: string;
      url: string;
      show_prompt: boolean;
    };
    expect(SHARE_SLUG_PATTERN.test(share.slug)).toBe(true);
    expect(share.url).toBe(`https://gattai.test/run/${share.slug}`);
    expect(share.show_prompt).toBe(false);

    const ownerView = await app.request(`/v1/runs/${seeded.runId}/share`, {
      headers: auth(project.secret),
    });
    expect(ownerView.status).toBe(200);
    const ownerBody = (await ownerView.json()) as { share: { slug: string } | null };
    expect(ownerBody.share?.slug).toBe(share.slug);

    // Tanpa body: share aktif dipertahankan, termasuk toggle false.
    const again = await createShare(project.secret, seeded.runId);
    expect(again.status).toBe(200);
    expect(((await again.json()) as { slug: string }).slug).toBe(share.slug);

    // Toggle prompt on memakai slug yang sama (tautan yang beredar tidak mati).
    const toggled = await createShare(project.secret, seeded.runId, { show_prompt: true });
    expect(toggled.status).toBe(200);
    const toggledBody = (await toggled.json()) as { slug: string; show_prompt: boolean };
    expect(toggledBody.slug).toBe(share.slug);
    expect(toggledBody.show_prompt).toBe(true);

    const pub = await app.request(`/v1/public/runs/${share.slug}`);
    expect(pub.status).toBe(200);
    expect(pub.headers.get("cache-control")).toContain("max-age=60");
    const body = (await pub.json()) as Record<string, unknown> & {
      prompt: string | null;
      formation: { name: string };
      steps: Array<Record<string, unknown>>;
      cost: { credits: string; usd: string };
      output: { content: string };
    };
    expect(body.prompt).toBe("Private prompt text.");
    expect(body.formation.name).toBe("Refine");
    expect(body.steps).toHaveLength(2);
    expect(body.steps[0].role_label).toBe("Planner");
    expect(body.steps[0].provider).toBe("GPT");
    expect(body.steps[0].summary).toContain("Internal brief");
    expect(body.steps[0].duration_ms).toBe(900);
    expect(body.cost.credits).toBe("12.345678");
    expect(body.cost.usd).toBe("0.12345678");
    expect(body.output.content).toBe("Here are three headline options.");

    // Kontrak publik sempit: tidak ada id internal/biaya provider/alamat.
    const serialized = JSON.stringify(body);
    for (const forbidden of [
      "run_id",
      "project_id",
      "step_id",
      "provider_cost_usd",
      "request_ref",
      "0x",
      seeded.runId,
      seeded.projectId,
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  test("show_prompt=false hides prompt in API and server HTML", async () => {
    const project = await newProject("share-hidden");
    const seeded = await seedRun({
      projectId: project.id,
      prompt: "Do not publish this exact sentence.",
    });
    const created = await createShare(project.secret, seeded.runId, { show_prompt: false });
    const { slug } = (await created.json()) as { slug: string };

    const pub = (await (await app.request(`/v1/public/runs/${slug}`)).json()) as {
      prompt: string | null;
    };
    expect(pub.prompt).toBeNull();

    const html = await app.request(`/run/${slug}`);
    expect(html.status).toBe(200);
    expect(html.headers.get("content-type")).toContain("text/html");
    const text = await html.text();
    expect(text).toContain("<title>Refine · Shared run · GATTAI</title>");
    expect(text).toContain(`https://gattai.test/run/${slug}`);
    expect(text).toContain(`https://gattai.test/run/${slug}/og.png`);
    expect(text).toContain('property="og:image:width" content="1200"');
    expect(text).not.toContain("Do not publish this exact sentence.");
  });

  test("revoked share returns 404 and OG falls back to default", async () => {
    const project = await newProject("share-revoke");
    const seeded = await seedRun({ projectId: project.id, prompt: "Revoked prompt." });
    const created = await createShare(project.secret, seeded.runId, { show_prompt: true });
    const { slug } = (await created.json()) as { slug: string };

    const revoked = await app.request(`/v1/runs/${seeded.runId}/share`, {
      method: "DELETE",
      headers: auth(project.secret),
    });
    expect(revoked.status).toBe(204);

    expect((await app.request(`/v1/public/runs/${slug}`)).status).toBe(404);
    const html = await app.request(`/run/${slug}`);
    expect(html.status).toBe(404);
    const text = await html.text();
    expect(text).toContain("noindex");
    expect(text).not.toContain("Revoked prompt.");

    const og = await app.request(`/run/${slug}/og.png`);
    expect(og.status).toBe(200);
    expect(og.headers.get("content-type")).toBe("image/png");
    const png = new Uint8Array(await og.arrayBuffer());
    expect(String.fromCharCode(...png.subarray(1, 4))).toBe("PNG");
    const view = new DataView(png.buffer);
    expect(view.getUint32(16)).toBe(1200);
    expect(view.getUint32(20)).toBe(630);

    // Share ulang setelah revoke memakai slug baru; tautan lama tetap mati.
    const reshared = await createShare(project.secret, seeded.runId, { show_prompt: true });
    const resharedBody = (await reshared.json()) as { slug: string };
    expect(resharedBody.slug).not.toBe(slug);
    expect((await app.request(`/v1/public/runs/${slug}`)).status).toBe(404);
    expect((await app.request(`/v1/public/runs/${resharedBody.slug}`)).status).toBe(200);
  });

  test("other projects cannot read, create, or revoke a share", async () => {
    const owner = await newProject("share-owner-2");
    const other = await newProject("share-other");
    const seeded = await seedRun({ projectId: owner.id });
    const created = await createShare(owner.secret, seeded.runId);
    const { slug } = (await created.json()) as { slug: string };

    const read = await app.request(`/v1/runs/${seeded.runId}/share`, {
      headers: auth(other.secret),
    });
    expect(read.status).toBe(404);
    expect((await createShare(other.secret, seeded.runId)).status).toBe(404);
    const del = await app.request(`/v1/runs/${seeded.runId}/share`, {
      method: "DELETE",
      headers: auth(other.secret),
    });
    expect(del.status).toBe(404);

    // Share tetap hidup setelah percobaan project lain.
    expect((await app.request(`/v1/public/runs/${slug}`)).status).toBe(200);
  });

  test("only settled runs can be shared", async () => {
    const project = await newProject("share-running");
    const seeded = await seedRun({ projectId: project.id, status: "RUNNING" });
    const res = await createShare(project.secret, seeded.runId);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("RUN_NOT_SETTLED");
  });

  test("conversation list exposes latest settled run and its active share", async () => {
    const project = await newProject("share-history");
    const seeded = await seedRun({ projectId: project.id });
    const created = await createShare(project.secret, seeded.runId, { show_prompt: false });
    const { slug } = (await created.json()) as { slug: string };

    const list = await app.request("/v1/conversations", { headers: auth(project.secret) });
    expect(list.status).toBe(200);
    const body = (await list.json()) as {
      conversations: Array<{
        id: string;
        latest_settled_run_id: string | null;
        share: { slug: string; show_prompt: boolean } | null;
      }>;
    };
    const row = body.conversations.find((item) => item.id === seeded.conversationId);
    expect(row?.latest_settled_run_id).toBe(seeded.runId);
    expect(row?.share?.slug).toBe(slug);
    expect(row?.share?.show_prompt).toBe(false);
  });

  test("deleting a conversation revokes its shares", async () => {
    const project = await newProject("share-delete");
    const seeded = await seedRun({ projectId: project.id });
    const created = await createShare(project.secret, seeded.runId);
    const { slug } = (await created.json()) as { slug: string };

    const del = await app.request(`/v1/conversations/${seeded.conversationId}`, {
      method: "DELETE",
      headers: auth(project.secret),
    });
    expect(del.status).toBe(204);

    const rows = await db.select().from(runShares).where(eq(runShares.runId, seeded.runId));
    expect(rows[0]?.revokedAt).not.toBeNull();
    expect((await app.request(`/v1/public/runs/${slug}`)).status).toBe(404);
  });

  test("media output is gated by MEDIA_SHARE_ENABLED", async () => {
    const project = await newProject("share-media");
    const seeded = await seedRun({
      projectId: project.id,
      output: {
        type: "async",
        content: null,
        media: { type: "image", url: "https://cdn.example.com/result.png" },
      },
    });
    const created = await createShare(project.secret, seeded.runId);
    const { slug } = (await created.json()) as { slug: string };

    const off = (await (await app.request(`/v1/public/runs/${slug}`)).json()) as {
      output: { media: unknown };
    };
    expect(off.output.media).toBeNull();

    process.env.MEDIA_SHARE_ENABLED = "true";
    const on = (await (await app.request(`/v1/public/runs/${slug}`)).json()) as {
      output: { media: { type: string; url: string } | null };
    };
    expect(on.output.media).toEqual({
      type: "image",
      url: "https://cdn.example.com/result.png",
    });
    delete process.env.MEDIA_SHARE_ENABLED;
  });

  test("share OG image is generated at 1200×630", async () => {
    const project = await newProject("share-og");
    const seeded = await seedRun({ projectId: project.id, prompt: "Make a sharp OG card." });
    const created = await createShare(project.secret, seeded.runId, { show_prompt: true });
    const { slug } = (await created.json()) as { slug: string };

    const og = await app.request(`/run/${slug}/og.png`);
    expect(og.status).toBe(200);
    expect(og.headers.get("content-type")).toBe("image/png");
    const png = new Uint8Array(await og.arrayBuffer());
    const view = new DataView(png.buffer);
    expect(view.getUint32(16)).toBe(1200);
    expect(view.getUint32(20)).toBe(630);
  });
});
