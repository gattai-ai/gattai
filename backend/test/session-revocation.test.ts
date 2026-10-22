import { describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import app from "../src/app";
import {
  SESSION_IDLE_TTL_MS,
  createSession,
  createSessionToken,
  resolveSession,
  revokeAllSessions,
  revokeSession,
  sessionCookieName,
} from "../src/auth/session";
import { db } from "../src/db";
import { projects, sessions } from "../src/db/schema";
import { findOrCreateProjectByWallet } from "../src/services/projects";

/** P1: sesi bisa dicabut (revokasi) + TTL berjenjang (absolut & idle). */

async function freshProject() {
  return findOrCreateProjectByWallet(`0x${randomBytes(20).toString("hex")}`);
}

function cookie(token: string): Record<string, string> {
  return { cookie: `${sessionCookieName()}=${token}` };
}

async function me(token: string) {
  return app.request("/auth/me", { headers: cookie(token) });
}

async function setSessionRow(
  sid: string,
  patch: Partial<{ lastSeenAt: Date; expiresAt: Date; revokedAt: Date | null }>,
) {
  await db.update(sessions).set(patch).where(eq(sessions.id, sid));
}

describe("sesi DB-backed", () => {
  test("sesi sah → /auth/me 200 dengan alamat owner project", async () => {
    const project = await freshProject();
    const { token } = await createSession(project.id, project.ownerWallet);

    const res = await me(token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { project: { id: string; address: string } };
    expect(body.project.id).toBe(project.id);
    expect(body.project.address).toBe(project.ownerWallet);
  });

  test("logout mencabut baris → token lama 401 (bukan sekadar hapus cookie)", async () => {
    const project = await freshProject();
    const { token, sid } = await createSession(project.id, project.ownerWallet);
    expect((await me(token)).status).toBe(200);

    const res = await app.request("/auth/logout", { method: "POST", headers: cookie(token) });
    expect(res.status).toBe(200);

    expect((await me(token)).status).toBe(401);
    const rows = await db.select().from(sessions).where(eq(sessions.id, sid));
    expect(rows[0]?.revokedAt).toBeInstanceOf(Date);
  });

  test("logout idempoten: tanpa sesi tetap ok", async () => {
    const res = await app.request("/auth/logout", { method: "POST" });
    expect(res.status).toBe(200);
  });

  test("baris dicabut → 401", async () => {
    const project = await freshProject();
    const { token, sid } = await createSession(project.id, project.ownerWallet);

    await revokeSession(sid);
    expect((await me(token)).status).toBe(401);
  });

  test("idle 72 jam → 401", async () => {
    const project = await freshProject();
    const { token, sid } = await createSession(project.id, project.ownerWallet);

    await setSessionRow(sid, { lastSeenAt: new Date(Date.now() - SESSION_IDLE_TTL_MS - 60_000) });
    expect((await me(token)).status).toBe(401);
  });

  test("batas absolut lewat → 401", async () => {
    const project = await freshProject();
    const { token, sid } = await createSession(project.id, project.ownerWallet);

    await setSessionRow(sid, { expiresAt: new Date(Date.now() - 1000) });
    expect((await me(token)).status).toBe(401);
  });

  test("token menunjuk baris project lain → 401", async () => {
    const a = await freshProject();
    const b = await freshProject();
    const { sid } = await createSession(a.id, a.ownerWallet);

    // Token sah secara HMAC, tapi `projectId` tidak cocok dengan barisnya.
    const forged = createSessionToken(b.id, b.ownerWallet, sid);
    expect((await me(forged)).status).toBe(401);
  });

  test("token tanpa baris sesi → 401", async () => {
    const project = await freshProject();
    const token = createSessionToken(project.id, project.ownerWallet, `ses_${randomUUID()}`);
    expect((await me(token)).status).toBe(401);
  });

  test("logout-all mencabut semua sesi project (tetap sah untuk project lain)", async () => {
    const project = await freshProject();
    const other = await freshProject();
    const deviceA = await createSession(project.id, project.ownerWallet);
    const deviceB = await createSession(project.id, project.ownerWallet);
    const otherDevice = await createSession(other.id, other.ownerWallet);

    const res = await app.request("/auth/logout-all", {
      method: "POST",
      headers: cookie(deviceA.token),
    });
    expect(res.status).toBe(200);

    expect((await me(deviceA.token)).status).toBe(401);
    expect((await me(deviceB.token)).status).toBe(401);
    expect((await me(otherDevice.token)).status).toBe(200);
  });

  test("aktivitas menyegarkan last_seen_at (throttle 5 menit)", async () => {
    const project = await freshProject();
    const { sid, token } = await createSession(project.id, project.ownerWallet);
    const stale = new Date(Date.now() - 10 * 60 * 1000);
    await setSessionRow(sid, { lastSeenAt: stale });

    expect(await resolveSession(token)).not.toBeNull();

    const rows = await db.select().from(sessions).where(eq(sessions.id, sid));
    expect(rows[0]!.lastSeenAt.getTime()).toBeGreaterThan(stale.getTime());
  });

  test("revokeAllSessions mencabut seluruh sesi project", async () => {
    const project = await freshProject();
    const one = await createSession(project.id, project.ownerWallet);
    const two = await createSession(project.id, project.ownerWallet);

    await revokeAllSessions(project.id);

    const rows = await db.select().from(sessions).where(eq(sessions.projectId, project.id));
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.revokedAt instanceof Date)).toBe(true);
    expect(await resolveSession(one.token)).toBeNull();
    expect(await resolveSession(two.token)).toBeNull();
  });
});

describe("ikatan sesi ke owner wallet", () => {
  test("owner project berubah → sesi lama dicabut & 401", async () => {
    const project = await freshProject();
    const { token, sid } = await createSession(project.id, project.ownerWallet);
    expect((await me(token)).status).toBe(200);

    const newOwner = `0x${randomBytes(20).toString("hex")}`;
    await db.update(projects).set({ ownerWallet: newOwner }).where(eq(projects.id, project.id));

    expect((await me(token)).status).toBe(401);
    const rows = await db.select().from(sessions).where(eq(sessions.id, sid));
    expect(rows[0]?.revokedAt).toBeInstanceOf(Date);
  });
});

describe("nama cookie sesi", () => {
  test("produksi memakai prefix __Host- (anti-injeksi subdomain)", () => {
    const previous = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = "production";
      expect(sessionCookieName()).toBe("__Host-gattai_session");
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
    expect(sessionCookieName()).toBe("gattai_session");
  });
});
