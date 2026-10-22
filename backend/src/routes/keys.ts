import { Hono } from "hono";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { apiKeys } from "../db/schema";
import { generateApiKey, hashSecret } from "../lib/crypto";
import { ApiError } from "../lib/http";
import { newId } from "../lib/id";
import { requireSession } from "../middleware/auth";
import { serializeApiKey } from "../serialize";
import type { AppEnv } from "../types";

/**
 * Manajemen API key. Key lengkap hanya dikembalikan sekali saat pembuatan.
 * Semua endpoint butuh sesi SIWE.
 */
export const keyRoutes = new Hono<AppEnv>();

keyRoutes.use("*", requireSession);

keyRoutes.get("/", async (c) => {
  const project = c.get("project");
  const rows = await db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.projectId, project.id))
    .orderBy(desc(apiKeys.createdAt));
  return c.json({ keys: rows.map(serializeApiKey) });
});

keyRoutes.post("/", async (c) => {
  const project = c.get("project");
  const body = z.object({ label: z.string().min(1).optional() }).parse(await c.req.json().catch(() => ({})));

  const { secret, prefix } = generateApiKey();
  const inserted = await db
    .insert(apiKeys)
    .values({
      id: newId("key"),
      projectId: project.id,
      prefix,
      hash: hashSecret(secret),
      label: body.label ?? "default",
    })
    .returning();

  return c.json({ ...serializeApiKey(inserted[0]), secret }, 201);
});

keyRoutes.delete("/:id", async (c) => {
  const project = c.get("project");
  const id = c.req.param("id");
  const rows = await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKeys.id, id), eq(apiKeys.projectId, project.id), isNull(apiKeys.revokedAt)))
    .returning({ id: apiKeys.id });
  if (!rows[0]) throw new ApiError(404, "KEY_NOT_FOUND", "Key not found or revoked.");
  return c.json({ id: rows[0].id, revoked: true });
});
