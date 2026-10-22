import { Hono } from "hono";
import type { PublicClient } from "viem";
import { z } from "zod";
import { getBalanceMicro } from "../billing/ledger";
import { env } from "../env";
import { errorBody } from "../lib/http";
import { requireProject } from "../middleware/auth";
import { createRateLimiter } from "../middleware/rate-limit";
import { createRobinhoodClient } from "../onchain/client";
import { buildIngestConfig } from "../onchain/config";
import { confirmDeposit } from "../onchain/confirm";
import { ingestDeposit } from "../onchain/ingest";
import type { AppEnv } from "../types";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

const confirmSchema = z.object({
  tx_hash: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/, "tx_hash must be a transaction hash of 0x + 64 hex characters."),
});

/** Seam untuk tes: ganti pembuat klien RPC. */
export interface DepositRouteDeps {
  createClient?: () => PublicClient;
}

/**
 * Endpoint konfirmasi deposit (Fase 2, jalur "instan").
 *
 * Frontend memanggil ini tepat setelah menerima receipt, sehingga kredit
 * mendarat dalam hitungan detik alih-alih menunggu siklus indexer.
 * Aman diproses ulang (idempoten lewat `ingestDeposit`).
 */
export function createDepositRoutes(deps: DepositRouteDeps = {}) {
  const routes = new Hono<AppEnv>();

  routes.use("*", requireProject);
  routes.use(
    "*",
    createRateLimiter<AppEnv>({
      windowMs: env.rateLimitWindowMs,
      max: env.rateLimitRunsPerMin,
      key: (c) => `confirm:${c.get("project").id}`,
      message: "Too many deposit confirmations. Try again shortly.",
    }),
  );

  routes.post("/confirm", async (c) => {
    const project = c.get("project");

    const depositManager = env.depositManagerAddress;
    if (!depositManager || !ADDRESS_RE.test(depositManager)) {
      return c.json(
        errorBody("NO_DEPOSIT_MANAGER", "DepositManager is not configured on the server."),
        503,
      );
    }

    const { tx_hash } = confirmSchema.parse(await c.req.json().catch(() => ({})));
    const client = deps.createClient ? deps.createClient() : createRobinhoodClient();

    const result = await confirmDeposit(tx_hash, {
      client,
      depositManager,
      confirmations: env.depositConfirmations,
      config: buildIngestConfig(client),
      projectId: project.id,
      projectOnchainId: project.onchainId,
      ingest: ingestDeposit,
      getBalanceMicro,
    });

    if (result.status === "pending") return c.json(result, 202);
    return c.json(result, 200);
  });

  return routes;
}
