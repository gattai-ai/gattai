import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { ZodError } from "zod";
import { errorBody, ApiError } from "./lib/http";
import { allowedOrigins, credentialsAllowed } from "./lib/origins";
import { securityHeaders } from "./middleware/security-headers";
import { api } from "./routes";

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
