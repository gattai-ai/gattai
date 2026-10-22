import { afterAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import app from "../src/app";
import { db } from "../src/db";
import { apiKeys, projects } from "../src/db/schema";
import { generateApiKey, hashSecret } from "../src/lib/crypto";
import { newId } from "../src/lib/id";

/**
 * `/v1/dev/credits` adalah jalur pengembangan untuk menambah saldo tanpa
 * onchain. Route ini harus benar-benar mati di produksi; kalau tidak, siapa pun
 * yang punya API key bisa mencetak credits.
 */

const previousNodeEnv = process.env.NODE_ENV;

afterAll(() => {
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnv;
});

async function createProjectWithKey(name: string): Promise<{ secret: string }> {
  const id = newId("prj");
  await db.insert(projects).values({
    id,
    name,
    ownerWallet: `0x${randomBytes(20).toString("hex")}`,
  });
  const generated = generateApiKey();
  await db.insert(apiKeys).values({
    id: newId("key"),
    projectId: id,
    prefix: generated.prefix,
    hash: hashSecret(generated.secret),
    label: name,
  });
  return { secret: generated.secret };
}

describe("dev credits route", () => {
  test("produksi → 404 NOT_FOUND", async () => {
    const { secret } = await createProjectWithKey("dev-route-production");

    process.env.NODE_ENV = "production";
    try {
      const res = await app.request("/v1/dev/credits", {
        method: "POST",
        headers: {
          authorization: `Bearer ${secret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ credits: 1 }),
      });

      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("NOT_FOUND");
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
    }
  });
});
