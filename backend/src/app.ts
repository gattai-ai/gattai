import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { ZodError } from "zod";
import { errorBody, ApiError } from "./lib/http";
import { allowedOrigins, credentialsAllowed } from "./lib/origins";
import { securityHeaders } from "./middleware/security-headers";
import { ogRoutes } from "./og/routes";
import { api } from "./routes";
import { getHolderWorkerHealth } from "./holder/worker-state";

const app = new Hono();

app.use("*", logger());
app.use("*", securityHeaders);
app.use(
  "*",
  cors({
    origin: allowedOrigins,
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "Idempotency-Key"],
    credentials: credentialsAllowed,
  }),
);

app.get("/health", (c) => c.json({ status: "ok" }));

/**
 * Health worker snapshot holder.
 *
 * Hanya agregat (tanpa wallet/alamat). 503 bila worker stale/degraded agar
 * alerting bisa memakai status HTTP tanpa parsing body.
 */
app.get("/health/holder", async (c) => {
  c.header("Cache-Control", "no-store");
  try {
    const health = await getHolderWorkerHealth();
    const healthy =
      health.status === "ok" ||
      health.status === "disabled" ||
      health.status === "running";
    return c.json(health, healthy ? 200 : 503);
  } catch {
    return c.json({ status: "unavailable" }, 503);
  }
});

// Halaman share + OG image. Di produksi Caddy mem-proxy /run/* ke sini.
app.route("/", ogRoutes);

// Grup route utama (/auth, /v1/*).
app.route("/", api);

// Penanganan error terpusat.
app.onError((error, c) => {
  if (error instanceof ApiError) {
    return c.json(error.toBody(), error.status);
  }
  if (error instanceof ZodError) {
    return c.json(errorBody("VALIDATION_ERROR", "Invalid input", { issues: error.issues }), 400);
  }
  console.error("[backend] error tak tertangani:", error);
  return c.json(errorBody("INTERNAL_ERROR", "Internal server error"), 500);
});

app.notFound((c) => c.json(errorBody("NOT_FOUND", "Endpoint not found"), 404));

export default app;
