import { Hono } from "hono";
import { z } from "zod";
import { SiweError, createNonce, verifySiwe } from "../auth/siwe";
import {
  assertSessionOwner,
  clearSessionCookie,
  createSession,
  readSessionCookie,
  readSessionToken,
  resolveSession,
  revokeAllSessions,
  revokeSession,
  setSessionCookie,
} from "../auth/session";
import { ApiError } from "../lib/http";
import { requireSession } from "../middleware/auth";
import { findOrCreateProjectByWallet, getProjectById, normalizeAddress } from "../services/projects";

export const authRoutes = new Hono();

/** Ambil nonce untuk membangun pesan SIWE di sisi klien. */
authRoutes.get("/nonce", (c) => c.json({ nonce: createNonce() }));

const verifySchema = z.object({
  message: z.string().min(1),
  signature: z.string().startsWith("0x"),
});

authRoutes.post("/verify", async (c) => {
  const body = verifySchema.parse(await c.req.json());
  try {
    const { address } = await verifySiwe({
      message: body.message,
      signature: body.signature as `0x${string}`,
    });
    const project = await findOrCreateProjectByWallet(address);
    const { token } = await createSession(project.id, normalizeAddress(address));

    setSessionCookie(c, token);

    return c.json({
      project: { id: project.id, name: project.name, address: project.ownerWallet },
    });
  } catch (error) {
    if (error instanceof SiweError) {
      // Detail verifikasi (viem) hanya masuk log; klien cukup tahu sign-in gagal.
      console.error("[auth] verifikasi SIWE gagal:", error.message);
      throw new ApiError(401, "SIWE_INVALID", "Sign-in could not be verified. Try again.");
    }
    throw error;
  }
});

/**
 * Tutup sesi yang sedang dipakai: cabut barisnya di DB lalu hapus cookie.
 * Idempoten — dipanggil dua kali (atau tanpa sesi) tetap `ok`.
 */
authRoutes.post("/logout", async (c) => {
  const session = readSessionToken(readSessionCookie(c));
  if (session?.sid) await revokeSession(session.sid);
  clearSessionCookie(c);
  return c.json({ ok: true });
});

/** Cabut SEMUA sesi project (semua perangkat) lalu hapus cookie perangkat ini. */
authRoutes.post("/logout-all", requireSession, async (c) => {
  await revokeAllSessions(c.get("project").id);
  clearSessionCookie(c);
  return c.json({ ok: true });
});

authRoutes.get("/me", async (c) => {
  const session = await resolveSession(readSessionCookie(c));
  if (!session) {
    // Termasuk sesi dicabut/kedaluwarsa: bersihkan cookie agar klien tidak
    // menyimpan sisa sesi yang tak berguna.
    clearSessionCookie(c);
    throw new ApiError(401, "UNAUTHORIZED", "Not signed in.");
  }

  // Sesi bisa menunjuk project yang sudah tidak ada (mis. DB berbeda / project
  // dihapus). Perlakukan seperti belum login agar klien membersihkan sesi dan
  // login ulang, alih-alih memakai sesi "hantu".
  const project = await getProjectById(session.projectId);
  if (!project) {
    clearSessionCookie(c);
    throw new ApiError(401, "UNAUTHORIZED", "Session is invalid. Sign in again.");
  }

  // Owner project berubah → sesi ini milik wallet lama; cabut & minta login ulang.
  try {
    await assertSessionOwner(session, project);
  } catch (error) {
    clearSessionCookie(c);
    throw error;
  }

  return c.json({ project: { id: project.id, address: project.ownerWallet } });
});
