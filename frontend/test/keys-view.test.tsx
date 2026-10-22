import { afterEach, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { RouterContext } from "../src/lib/router-context";
import { SessionContext } from "../src/lib/session-store";
import { KeysView } from "../src/site/app/KeysView";

/**
 * Halaman Keys mengikuti referensi `gattai-site/app.html`: hanya API keys +
 * quick test. Blok "Sessions" (sign out everywhere) dihapus dari UI, dan
 * kalimat "Full reference in the docs" menautkan ke halaman `/docs`.
 */

afterEach(cleanup);

const SESSION = { session: { projectId: "prj_test", address: "0x1" }, isLoading: false };

function renderKeys() {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname.endsWith("/v1/keys")) {
      return new Response(JSON.stringify({ keys: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`permintaan tak terduga: ${url.pathname}`);
  }) as typeof fetch;

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SessionContext.Provider value={SESSION}>
        <RouterContext.Provider value={{ location: "/app/keys", navigate: () => {} }}>
          <KeysView />
        </RouterContext.Provider>
      </SessionContext.Provider>
    </QueryClientProvider>,
  );
}

describe("KeysView", () => {
  test("tidak lagi menampilkan blok Sessions / Sign out everywhere", async () => {
    renderKeys();
    await waitFor(() =>
      expect(screen.getByText("No keys yet: create your first key above.")).toBeDefined(),
    );
    expect(screen.queryByText(/sign out everywhere/i)).toBeNull();
    expect(screen.queryByText("Sessions")).toBeNull();
  });

  test("tautan docs mengarah ke halaman /docs", async () => {
    renderKeys();
    await waitFor(() =>
      expect(screen.getByText("No keys yet: create your first key above.")).toBeDefined(),
    );
    const link = screen.getByRole("link", { name: "docs" });
    expect(link.getAttribute("href")).toBe("/docs");
  });
});
