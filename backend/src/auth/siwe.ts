import { verifyMessage } from "viem";
import { generateSiweNonce, parseSiweMessage, validateSiweMessage } from "viem/siwe";
import { env } from "../env";

/**
 * SIWE (EIP-4361). Nonce disimpan in-memory dengan masa berlaku pendek.
 * Verifikasi tanda tangan memakai `verifyMessage` (EOA) sehingga tidak butuh RPC.
 *
 * CATATAN SKALA: `nonces` hidup di memori proses, jadi hanya konsisten pada
 * satu instance backend. Aman selama deploy 1 replica; bila diperbanyak,
 * pindahkan ke DB/Redis (atau pakai sticky session).
 */

const NONCE_TTL_MS = 5 * 60 * 1000;
const nonces = new Map<string, number>();

export class SiweError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SiweError";
  }
}

export function createNonce(): string {
  const now = Date.now();
  for (const [nonce, exp] of nonces) {
    if (exp < now) nonces.delete(nonce);
  }
  const nonce = generateSiweNonce();
  nonces.set(nonce, now + NONCE_TTL_MS);
  return nonce;
}

function consumeNonce(nonce: string): boolean {
  const exp = nonces.get(nonce);
  if (!exp || exp < Date.now()) return false;
  nonces.delete(nonce);
  return true;
}

export interface SiweVerifyInput {
  message: string;
  signature: `0x${string}`;
}

export interface SiweVerifyResult {
  address: `0x${string}`;
}

export async function verifySiwe(input: SiweVerifyInput): Promise<SiweVerifyResult> {
  const parsed = parseSiweMessage(input.message);
  if (!parsed.address || !parsed.nonce) {
    throw new SiweError("Incomplete SIWE message");
  }

  if (!consumeNonce(parsed.nonce)) {
    throw new SiweError("Nonce is invalid or expired");
  }

  // Otoritas domain = allow-list server, bukan `message.domain` (ditulis klien)
  // dan bukan header `Origin`/`Host` (bisa dipalsukan). `message.domain` tidak
  // lagi dipercaya; ia hanya dicocokkan ke daftar host yang kita izinkan.
  // Nama host case-insensitive; port ikut dibandingkan (`localhost:5173`).
  const domain = parsed.domain?.trim().toLowerCase() ?? "";
  if (!domain || !env.siweDomains.includes(domain)) {
    throw new SiweError(`SIWE domain not allowed: ${domain || "(empty)"}`);
  }

  // `domain` tidak dioper lagi: pencocokan host sudah di atas, sedangkan sisa
  // validasi viem (expiry, notBefore, format alamat) tetap berjalan.
  const valid = validateSiweMessage({ message: parsed });
  if (!valid) {
    throw new SiweError("Invalid SIWE message (domain/expiry)");
  }

  const signatureValid = await verifyMessage({
    address: parsed.address,
    message: input.message,
    signature: input.signature,
  });
  if (!signatureValid) {
    throw new SiweError("Invalid signature");
  }

  return { address: parsed.address };
}
