import { and, eq, isNull } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { assertSessionOwner, readSessionCookie, resolveSession } from "../auth/session";
import { db } from "../db";
import { apiKeys } from "../db/schema";
import { apiKeyPrefix, isApiKeyFormat, verifySecret } from "../lib/crypto";
import { ApiError } from "../lib/http";
import { getProjectById, type Project } from "../services/projects";
import type { AppEnv } from "../types";

/** Jeda minimum antar penulisan `last_used_at` pada API key. */
const LAST_USED_THROTTLE_MS = 5 * 60 * 1000;

/** Resolve project dari API key (`gtt_live_...`). */
async function projectFromApiKey(secret: string): Promise<Project | null> {
  if (!isApiKeyFormat(secret)) return null;
  const prefix = apiKeyPrefix(secret);
  const rows = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.prefix, prefix), isNull(apiKeys.revokedAt)));

  for (const row of rows) {
    if (await verifySecret(secret, row.hash)) {
      // `last_used_at` hanya untuk tampilan; menulisnya tiap request menambah
      // beban DB tanpa manfaat. Tulis paling sering sekali per 5 menit.
      const lastUsed = row.lastUsedAt?.getTime() ?? 0;
      if (Date.now() - lastUsed > LAST_USED_THROTTLE_MS) {
        await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, row.id));
      }
      return (await getProjectById(row.projectId)) ?? null;
    }
  }
  return null;
}

/**
 * Terima API key ATAU sesi SIWE. Dipakai endpoint yang bisa diakses developer
 * (via key) maupun web app (via sesi).
 */
export const requireProject: MiddlewareHandler<AppEnv> = async (c, next) => {
  const header = c.req.header("Authorization");
  if (header?.startsWith("Bearer ")) {
    const secret = header.slice("Bearer ".length).trim();
    const project = await projectFromApiKey(secret);
    if (project) {
      c.set("project", project);
      c.set("authKind", "key");
      return next();
    }
    throw new ApiError(401, "UNAUTHORIZED", "API key is invalid or revoked.");
  }

  const session = await resolveSession(readSessionCookie(c));
  if (session) {
    const project = await getProjectById(session.projectId);
    if (project) {
      await assertSessionOwner(session, project);
      c.set("project", project);
      c.set("authKind", "session");
      return next();
    }
  }

  throw new ApiError(401, "UNAUTHORIZED", "Authentication required (API key or session).");
};

/** Hanya menerima sesi SIWE (untuk aksi web app, mis. kelola key). */
export const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  const session = await resolveSession(readSessionCookie(c));
  if (!session) {
    throw new ApiError(401, "UNAUTHORIZED", "Session is invalid. Sign in again.");
  }
  const project = await getProjectById(session.projectId);
  if (!project) {
    throw new ApiError(401, "UNAUTHORIZED", "Project not found.");
  }
  await assertSessionOwner(session, project);
  c.set("project", project);
  c.set("authKind", "session");
  return next();
};
