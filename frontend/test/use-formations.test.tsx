import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { useFormationAvailability } from "../src/features/chat/useFormations";

/**
 * Ketersediaan formasi untuk landing page. Berbeda dari `/v1/recipes` (butuh
 * sesi), endpoint ini publik: pengunjung anonim pun harus tahu formasi mana yang
 * "coming soon", jadi hook-nya TIDAK boleh menunggu login.
 */

let calls = 0;
let lastPath = "";

const RESPONSE = {
  formations: [
    { id: "refine", name: "Refine", available: true },
    { id: "visual", name: "Visual", available: false },
  ],
};

beforeEach(() => {
  calls = 0;
  lastPath = "";
  globalThis.fetch = (async (input: string | URL | Request) => {
    calls += 1;
    lastPath = new URL(String(input), "http://localhost").pathname;
    return new Response(JSON.stringify(RESPONSE), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
});

afterEach(cleanup);

function makeWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

describe("useFormationAvailability", () => {
  test("menembak endpoint publik tanpa menunggu sesi", async () => {
    const { result } = renderHook(() => useFormationAvailability(), { wrapper: makeWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(calls).toBe(1);
    expect(lastPath).toBe("/api/v1/public/formations");
    expect(result.current.data?.formations.find((item) => item.id === "visual")?.available).toBe(
      false,
    );
  });
});
