import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { useRecipes } from "../src/features/chat/useRecipes";

/**
 * `/v1/recipes` butuh sesi. Selama belum login hook TIDAK boleh menembak
 * request — kalau menembak, 401-nya ter-cache dan formasi baru muncul setelah
 * refresh, bukan langsung setelah login (bug "formasi hilang setelah login").
 */

let calls = 0;

beforeEach(() => {
  calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(JSON.stringify({ recipes: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
});

afterEach(cleanup);

/** QueryClient stabil per test (dibuat sekali, bukan tiap render wrapper). */
function makeWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

describe("useRecipes", () => {
  test("tidak menembak request saat belum login (enabled = false)", async () => {
    renderHook(() => useRecipes(false), { wrapper: makeWrapper() });
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(calls).toBe(0);
  });

  test("menembak /v1/recipes saat sudah login (enabled = true)", async () => {
    const { result } = renderHook(() => useRecipes(true), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(calls).toBe(1);
  });

  test("baru menembak setelah sesi muncul", async () => {
    const { rerender } = renderHook(({ enabled }) => useRecipes(enabled), {
      wrapper: makeWrapper(),
      initialProps: { enabled: false },
    });
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(calls).toBe(0);

    rerender({ enabled: true });
    await waitFor(() => expect(calls).toBe(1));
  });
});
