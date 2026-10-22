import { describe, expect, test } from "bun:test";
import {
  apiKeyPrefix,
  generateApiKey,
  hashSecret,
  isApiKeyFormat,
  signSession,
  verifySecret,
  verifySession,
} from "../src/lib/crypto";

describe("api key", () => {
  test("generate → format benar & hash terverifikasi", async () => {
    const { secret, prefix } = generateApiKey();
    expect(isApiKeyFormat(secret)).toBe(true);
    expect(secret.startsWith("gtt_live_")).toBe(true);
    expect(prefix).toBe(apiKeyPrefix(secret));

    const hash = hashSecret(secret);
    expect(await verifySecret(secret, hash)).toBe(true);
    expect(await verifySecret(`${secret}x`, hash)).toBe(false);
  });

  test("hash berbeda tiap kali (salt acak)", () => {
    const { secret } = generateApiKey();
    expect(hashSecret(secret)).not.toBe(hashSecret(secret));
  });

  test("menolak string yang bukan key", () => {
    expect(isApiKeyFormat("bukan-key")).toBe(false);
  });
});

describe("session", () => {
  const valid = {
    projectId: "prj_test",
    address: "0xabc",
    sid: "ses_test",
    exp: Date.now() + 60_000,
  };

  test("sign → verify round-trip", () => {
    const token = signSession(valid);
    const payload = verifySession(token);
    expect(payload?.projectId).toBe("prj_test");
    expect(payload?.address).toBe("0xabc");
  });

  test("menolak token yang diubah", () => {
    const token = signSession(valid);
    expect(verifySession(`${token}x`)).toBeNull();
    expect(verifySession("abc.def")).toBeNull();
    expect(verifySession("")).toBeNull();
  });

  test("menolak token kedaluwarsa", () => {
    const token = signSession({ ...valid, exp: Date.now() - 1000 });
    expect(verifySession(token)).toBeNull();
  });
});
