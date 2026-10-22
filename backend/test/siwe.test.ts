import { describe, expect, test } from "bun:test";
import { privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { SiweError, createNonce, verifySiwe } from "../src/auth/siwe";

// Test harus deterministik: jangan bergantung pada SIWE_DOMAIN di .env lokal.
// `env.siweDomains` dibaca lazy (per panggilan `verifySiwe`), jadi menetapkannya
// di sini sudah cukup.
process.env.SIWE_DOMAIN = "localhost:3000";

const account = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);

/** Jalankan `fn` dengan `SIWE_DOMAIN` sementara, lalu pulihkan. */
async function withSiweDomains<T>(value: string, fn: () => Promise<T>): Promise<T> {
  const saved = process.env.SIWE_DOMAIN;
  process.env.SIWE_DOMAIN = value;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.SIWE_DOMAIN;
    else process.env.SIWE_DOMAIN = saved;
  }
}

async function signedMessage(
  nonce: string,
  domain = "localhost:3000",
): Promise<{ message: string; signature: `0x${string}` }> {
  const message = createSiweMessage({
    address: account.address,
    chainId: 1,
    domain,
    nonce,
    uri: "http://localhost:3000",
    version: "1",
    issuedAt: new Date(),
    expirationTime: new Date(Date.now() + 5 * 60 * 1000),
  });
  const signature = await account.signMessage({ message });
  return { message, signature };
}

describe("SIWE", () => {
  test("nonce valid + tanda tangan benar → alamat terverifikasi", async () => {
    const nonce = createNonce();
    const { message, signature } = await signedMessage(nonce);
    const result = await verifySiwe({ message, signature });
    expect(result.address.toLowerCase()).toBe(account.address.toLowerCase());
  });

  test("nonce tidak dikenal ditolak", async () => {
    const { message, signature } = await signedMessage("abcdefgh12345678");
    await expect(verifySiwe({ message, signature })).rejects.toBeInstanceOf(SiweError);
  });

  test("nonce hanya bisa dipakai sekali", async () => {
    const nonce = createNonce();
    const { message, signature } = await signedMessage(nonce);
    await verifySiwe({ message, signature });
    await expect(verifySiwe({ message, signature })).rejects.toBeInstanceOf(SiweError);
  });

  test("domain salah ditolak", async () => {
    const nonce = createNonce();
    const message = createSiweMessage({
      address: account.address,
      chainId: 1,
      domain: "evil.example.com",
      nonce,
      uri: "http://localhost:3000",
      version: "1",
      issuedAt: new Date(),
      expirationTime: new Date(Date.now() + 5 * 60 * 1000),
    });
    const signature = await account.signMessage({ message });
    await expect(verifySiwe({ message, signature })).rejects.toBeInstanceOf(SiweError);
  });

  test("domain kedua di daftar diterima (SIWE_DOMAIN dipisah koma)", async () => {
    await withSiweDomains("localhost:3000,localhost:5174", async () => {
      const nonce = createNonce();
      const { message, signature } = await signedMessage(nonce, "localhost:5174");
      const result = await verifySiwe({ message, signature });
      expect(result.address.toLowerCase()).toBe(account.address.toLowerCase());
    });
  });

  test("host yang hanya menyerupai (substring/sufiks) ditolak", async () => {
    // Bukan pencocokan `includes`/`endsWith`: `evilgattai.tech` (mengandung
    // nama host kita sebagai substring), `gattai.tech` (apex berbeda dari www),
    // dan `www.gattai.tech:8443` (port lain) harus tetap ditolak.
    await withSiweDomains("localhost:3000,www.gattai.tech", async () => {
      const similar = ["evilgattai.tech", "gattai.tech", "www.gattai.tech:8443"];
      for (const domain of similar) {
        const nonce = createNonce();
        const { message, signature } = await signedMessage(nonce, domain);
        await expect(verifySiwe({ message, signature })).rejects.toBeInstanceOf(SiweError);
      }
    });
  });

  test("nama host dibandingkan tanpa peduli huruf besar/kecil", async () => {
    await withSiweDomains("LocalHost:3000", async () => {
      const nonce = createNonce();
      const { message, signature } = await signedMessage(nonce, "localhost:3000");
      const result = await verifySiwe({ message, signature });
      expect(result.address.toLowerCase()).toBe(account.address.toLowerCase());
    });
  });
});
