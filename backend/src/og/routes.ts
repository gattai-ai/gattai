import { createHash } from "node:crypto";
import { Hono } from "hono";
import { getRecipe } from "../config";
import { env } from "../env";
import { createRateLimiter, ipKey } from "../middleware/rate-limit";
import { getPublicSharedRun } from "../services/shares";
import { renderOgImage, renderDefaultOg } from "./image";
import { renderRunHtml } from "./meta";

/**
 * Route HTML/OG yang diproksikan Caddy dari `/run/*` ke backend.
 *
 * Frontend static lain tetap dilayani Caddy. Hanya dua path ini yang perlu
 * backend: shell HTML dengan meta crawler, dan PNG dinamis.
 */
export const ogRoutes = new Hono();

ogRoutes.use(
  "*",
  createRateLimiter({
    windowMs: env.rateLimitWindowMs,
    max: env.rateLimitIpPerMin,
    key: ipKey,
    message: "Too many share page requests. Try again shortly.",
  }),
);

const CACHE_TTL_MS = 60_000;
const MAX_CACHE_ENTRIES = 128;

interface CachedImage {
  png: Uint8Array;
  expiresAt: number;
}

const imageCache = new Map<string, CachedImage>();
let defaultImage: CachedImage | null = null;

function readCache(key: string): Uint8Array | null {
  const entry = imageCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    imageCache.delete(key);
    return null;
  }
  return entry.png;
}

function writeCache(key: string, png: Uint8Array): Uint8Array {
  if (imageCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = imageCache.keys().next().value;
    if (oldest) imageCache.delete(oldest);
  }
  imageCache.set(key, { png, expiresAt: Date.now() + CACHE_TTL_MS });
  return png;
}

async function defaultPng(): Promise<Uint8Array> {
  if (defaultImage && defaultImage.expiresAt > Date.now()) return defaultImage.png;
  const png = await renderDefaultOg();
  defaultImage = { png, expiresAt: Date.now() + CACHE_TTL_MS };
  return png;
}

ogRoutes.get("/run/:slug", async (c) => {
  const slug = c.req.param("slug");
  const shared = await getPublicSharedRun(slug);
  const baseUrl = env.publicBaseUrl ?? new URL(c.req.url).origin;
  const rendered = renderRunHtml(shared, { baseUrl, slug });

  c.header("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
  c.header("Content-Type", "text/html; charset=UTF-8");
  return c.body(rendered.html, rendered.status);
});

ogRoutes.get("/run/:slug/og.png", async (c) => {
  const slug = c.req.param("slug");
  const shared = await getPublicSharedRun(slug);

  let png: Uint8Array;
  if (!shared) {
    png = await defaultPng();
  } else {
    const formationName = getRecipe(shared.run.recipeId)?.name ?? shared.run.recipeId;
    const prompt = shared.share.showPrompt ? shared.run.input : null;
    const promptHash = createHash("sha1").update(prompt ?? "").digest("hex");
    const key = `${slug}:${shared.share.showPrompt ? "1" : "0"}:${promptHash}:${formationName}:${shared.steps.length}`;
    png =
      readCache(key) ??
      writeCache(
        key,
        await renderOgImage({
          formationName,
          prompt,
          stepCount: shared.steps.length,
        }).catch((error) => {
          console.error("[og] render failed, using default:", error);
          return defaultPng();
        }),
      );
  }

  const body = new Uint8Array(png.byteLength);
  body.set(png);
  return c.newResponse(body, 200, {
    "Cache-Control": "public, max-age=60, stale-while-revalidate=300",
    "Content-Type": "image/png",
  });
});
