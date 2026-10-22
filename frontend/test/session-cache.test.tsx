import { afterEach, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { clearStaleAccountQueries } from "../src/lib/account-cache";
import {
  SESSION_KEY,
  SessionContext,
  fetchSession,
  type Session,
} from "../src/lib/session-store";
import { useLogout, useLogoutAll } from "../src/lib/use-session";
import { useKeysCount, useProjectName } from "../src/site/app/useAppShell";

/**
 * Test higiene sesi & cache akun (temuan "data wallet lama masih tampil setelah
 * logout / ganti akun").
 *
 * Yang dikunci:
 *  1. cache akun dipisah per `projectId` — data wallet lain tidak terpakai;
 *  2. sisa cache akun lama dibuang saat identitas sesi berubah;
 *  3. logout sukses membuat sesi lokal menjadi kosong (composer mati);
 *  4. logout gagal TIDAK membuat UI berbohong (sesi & pesan apa adanya);
 *  5. "sign out everywhere" memakai endpoint `/auth/logout-all` dan membersihkan
 *     sesi lokal dengan perilaku gagal yang sama.
 */

afterEach(cleanup);

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function wrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

describe("clearStaleAccountQueries", () => {
  test("hanya membuang cache akun project lain", () => {
    const client = new QueryClient();
    client.setQueryData(["project", "prj_a"], { name: "A" });
    client.setQueryData(["balance", "prj_a"], { balance_credits: 5 });
    client.setQueryData(["keys", "prj_a"], { keys: [] });
    client.setQueryData(["usage", "cap", "prj_a"], { entries: [] });
    client.setQueryData(["project", "prj_b"], { name: "B" });
    client.setQueryData(["recipes"], { recipes: [] });
    client.setQueryData(["burns"], { burns: [] });

    clearStaleAccountQueries(client, "prj_b");

    expect(client.getQueryData(["project", "prj_a"])).toBeUndefined();
    expect(client.getQueryData(["balance", "prj_a"])).toBeUndefined();
    expect(client.getQueryData(["keys", "prj_a"])).toBeUndefined();
    expect(client.getQueryData(["usage", "cap", "prj_a"])).toBeUndefined();
    // Identitas aktif tetap.
    expect(client.getQueryData(["project", "prj_b"])).toEqual({ name: "B" });
    // Katalog formasi bersifat global (bukan milik akun) — jangan dibuang.
    expect(client.getQueryData(["recipes"])).toBeDefined();
    expect(client.getQueryData(["burns"])).toBeDefined();
  });

  test("tanpa sesi, seluruh cache akun dibuang", () => {
    const client = new QueryClient();
    client.setQueryData(["project", "prj_a"], { name: "A" });
    client.setQueryData(["conversations", "prj_a", ""], { pages: [] });

    clearStaleAccountQueries(client, undefined);

    expect(client.getQueryData(["project", "prj_a"])).toBeUndefined();
    expect(client.getQueryData(["conversations", "prj_a", ""])).toBeUndefined();
  });
});

describe("data akun tidak bocor lintas identitas", () => {
  function sessionWrapper(client: QueryClient, session: Session | null) {
    return function Wrapper({ children }: { children: ReactNode }) {
      return (
        <QueryClientProvider client={client}>
          <SessionContext.Provider value={{ session, isLoading: false }}>{children}</SessionContext.Provider>
        </QueryClientProvider>
      );
    };
  }

  test("tanpa sesi, nama project wallet lama tidak dirender", () => {
    const client = new QueryClient();
    client.setQueryData(["project", "prj_old"], { name: "Wallet lama" });

    const { result } = renderHook(() => useProjectName(), { wrapper: sessionWrapper(client, null) });

    expect(result.current).toBe("my-first-formation");
  });

  test("dengan sesi, hanya data project itu yang dipakai", () => {
    const client = new QueryClient();
    client.setQueryData(["project", "prj_old"], { name: "Wallet lama" });
    client.setQueryData(["project", "prj_new"], { name: "Wallet baru" });

    const { result } = renderHook(() => useProjectName(), {
      wrapper: sessionWrapper(client, { projectId: "prj_new", address: "0xnew" }),
    });

    expect(result.current).toBe("Wallet baru");
  });

  test("jumlah key nol saat tidak ada sesi walau cache wallet lama ada", () => {
    const client = new QueryClient();
    client.setQueryData(["keys", "prj_old"], { keys: [{ id: "k1", revoked_at: null }] });

    const { result } = renderHook(() => useKeysCount(), { wrapper: sessionWrapper(client, null) });

    expect(result.current).toBe(0);
  });
});

describe("useLogout", () => {
  /** Sesi nyata + `useLogout`, supaya query `["session"]` benar-benar aktif. */
  function useHarness() {
    const query = useQuery({ queryKey: SESSION_KEY, queryFn: fetchSession, retry: false });
    const { logout, error, isPending } = useLogout();
    return { query, logout, error, isPending };
  }

  test("sukses: sesi lokal dikosongkan dan mengembalikan true", async () => {
    let loggedOut = false;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const path = new URL(String(input), "http://localhost").pathname;
      if (path.endsWith("/auth/logout")) {
        loggedOut = true;
        return json({ ok: true });
      }
      if (path.endsWith("/auth/me")) {
        if (loggedOut) return json({ error: { code: "UNAUTHORIZED", message: "Not signed in." } }, 401);
        return json({ project: { id: "prj_a", address: "0xaaaa" } });
      }
      throw new Error(`permintaan tak terduga: ${path}`);
    }) as typeof fetch;

    const client = makeClient();
    const { result } = renderHook(() => useHarness(), { wrapper: wrapper(client) });
    await waitFor(() => expect(result.current.query.data).toEqual({ projectId: "prj_a", address: "0xaaaa" }));

    let ok = false;
    await act(async () => {
      ok = await result.current.logout();
    });

    expect(ok).toBe(true);
    await waitFor(() => expect(result.current.query.data ?? null).toBeNull());
  });

  test("gagal: sesi dipertahankan dan pesan error disetel", async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const path = new URL(String(input), "http://localhost").pathname;
      if (path.endsWith("/auth/logout")) throw new TypeError("fetch failed");
      if (path.endsWith("/auth/me")) return json({ project: { id: "prj_a", address: "0xaaaa" } });
      throw new Error(`permintaan tak terduga: ${path}`);
    }) as typeof fetch;

    const client = makeClient();
    const { result } = renderHook(() => useHarness(), { wrapper: wrapper(client) });
    await waitFor(() => expect(result.current.query.data).toEqual({ projectId: "prj_a", address: "0xaaaa" }));

    let ok = true;
    await act(async () => {
      ok = await result.current.logout();
    });

    expect(ok).toBe(false);
    await waitFor(() => expect(result.current.error).toBeTruthy());
    // Sesi tidak dipalsukan: masih ada, seperti kondisi sebenarnya.
    expect(result.current.query.data).toEqual({ projectId: "prj_a", address: "0xaaaa" });
  });
});

describe("useLogoutAll", () => {
  /** Sesi nyata + `useLogoutAll` ("sign out everywhere"). */
  function useHarness() {
    const query = useQuery({ queryKey: SESSION_KEY, queryFn: fetchSession, retry: false });
    const { logoutAll, error, isPending } = useLogoutAll();
    return { query, logoutAll, error, isPending };
  }

  test("sukses: memanggil /auth/logout-all, mengosongkan sesi, mengembalikan true", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const path = new URL(String(input), "http://localhost").pathname;
      calls.push(path);
      if (path.endsWith("/auth/logout-all")) return json({ ok: true });
      if (path.endsWith("/auth/me")) {
        return calls.some((p) => p.endsWith("/auth/logout-all"))
          ? json({ error: { code: "UNAUTHORIZED", message: "Not signed in." } }, 401)
          : json({ project: { id: "prj_a", address: "0xaaaa" } });
      }
      throw new Error(`permintaan tak terduga: ${path}`);
    }) as typeof fetch;

    const client = makeClient();
    const { result } = renderHook(() => useHarness(), { wrapper: wrapper(client) });
    await waitFor(() => expect(result.current.query.data).toEqual({ projectId: "prj_a", address: "0xaaaa" }));

    let ok = false;
    await act(async () => {
      ok = await result.current.logoutAll();
    });

    expect(ok).toBe(true);
    expect(calls.some((path) => path.endsWith("/auth/logout-all"))).toBe(true);
    await waitFor(() => expect(result.current.query.data ?? null).toBeNull());
  });

  test("gagal: sesi tetap ada dan pesan error disetel", async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const path = new URL(String(input), "http://localhost").pathname;
      if (path.endsWith("/auth/logout-all")) throw new TypeError("fetch failed");
      if (path.endsWith("/auth/me")) return json({ project: { id: "prj_a", address: "0xaaaa" } });
      throw new Error(`permintaan tak terduga: ${path}`);
    }) as typeof fetch;

    const client = makeClient();
    const { result } = renderHook(() => useHarness(), { wrapper: wrapper(client) });
    await waitFor(() => expect(result.current.query.data).toEqual({ projectId: "prj_a", address: "0xaaaa" }));

    let ok = true;
    await act(async () => {
      ok = await result.current.logoutAll();
    });

    expect(ok).toBe(false);
    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect(result.current.query.data).toEqual({ projectId: "prj_a", address: "0xaaaa" });
  });
});
