import { afterEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RouterContext } from "../src/lib/router-context";
import { SessionContext } from "../src/lib/session-store";
import type { ConversationSummary, ConversationsResponse } from "../src/lib/types";
import { HistoryView } from "../src/site/app/HistoryView";

/**
 * Test komponen halaman History dengan DOM happy-dom (lihat `test/setup.ts`).
 *
 * Providernya nyata (react-query + konteks sesi/router); yang dipalsukan hanya
 * lapisan jaringan (`fetch`), jadi test ini ikut menguji hook `useConversations`
 * — termasuk pemetaan `next_cursor` → halaman berikutnya.
 */

afterEach(() => cleanup());

const SESSION = { session: { projectId: "prj_test", address: "0x1" }, isLoading: false };

const ISO = "2026-10-18T12:04:00.000Z";

function conversation(overrides: Partial<ConversationSummary> & { id: string }): ConversationSummary {
  return { title: `Chat ${overrides.id}`, created_at: ISO, last_run_at: ISO, run_count: 1, ...overrides };
}

/** Palsukan `fetch` untuk `GET /v1/conversations`; kembalikan kursor yang diminta. */
function serveConversations(handler: (cursor: string | null) => ConversationsResponse): Array<string | null> {
  const cursors: Array<string | null> = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input), "http://localhost");
    if (!url.pathname.endsWith("/v1/conversations")) throw new Error(`permintaan tak terduga: ${url.pathname}`);
    const cursor = url.searchParams.get("cursor");
    cursors.push(cursor);
    return new Response(JSON.stringify(handler(cursor)), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return cursors;
}

function renderHistory(navigate: (to: string) => void = () => {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SessionContext.Provider value={SESSION}>
        <RouterContext.Provider value={{ location: "/app/history", navigate }}>
          <HistoryView />
        </RouterContext.Provider>
      </SessionContext.Provider>
    </QueryClientProvider>,
  );
}

describe("HistoryView: keadaan dasar", () => {
  test("menampilkan keadaan memuat sebelum data tiba", () => {
    globalThis.fetch = (() => new Promise(() => {})) as typeof fetch;
    renderHistory();

    expect(screen.getByText("Loading your chats…")).toBeDefined();
  });

  test("menampilkan ajakan saat belum ada percakapan", async () => {
    serveConversations(() => ({ conversations: [], has_more: false, next_cursor: null }));
    renderHistory();

    await waitFor(() =>
      expect(screen.getByText("No chats yet. Send a prompt and it will show up here.")).toBeDefined(),
    );
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  test("menampilkan pesan error yang bisa dicoba lagi", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { code: "BOOM", message: "boom" } }), { status: 500 })) as typeof fetch;
    renderHistory();

    await waitFor(() =>
      expect(screen.getByText("Could not load your chats. Try again in a moment.")).toBeDefined(),
    );
  });
});

describe("HistoryView: daftar percakapan", () => {
  test("judul fallback `New chat` dan jumlah run yang benar", async () => {
    serveConversations(() => ({
      conversations: [
        conversation({ id: "conv_a", title: "Bikin banner", run_count: 1, last_run_at: null }),
        conversation({ id: "conv_b", title: null, run_count: 2 }),
      ],
      has_more: false,
      next_cursor: null,
    }));
    renderHistory();

    await waitFor(() => expect(screen.getByTitle("Bikin banner")).toBeDefined());

    // Judul nullable ditampilkan sebagai "New chat" (dipakai juga sebagai tooltip).
    expect(screen.getByTitle("New chat")).toBeDefined();

    const text = document.body.textContent ?? "";
    expect(text).toContain("1 run ·");
    expect(text).toContain("2 runs ·");
    expect(text).not.toContain("1 runs");
    expect(text).toContain("Oct ");
    expect(text).not.toMatch(/Okt|Des|Agu/);
  });

  test("klik baris mengarah ke transkrip percakapan itu", async () => {
    serveConversations(() => ({
      conversations: [conversation({ id: "conv_a", title: "Bikin banner" })],
      has_more: false,
      next_cursor: null,
    }));
    const navigate = mock(() => {});
    renderHistory(navigate);

    await waitFor(() => expect(screen.getByTitle("Bikin banner")).toBeDefined());
    fireEvent.click(screen.getByTitle("Bikin banner"));

    expect(navigate).toHaveBeenCalledWith("/app/chat/conv_a");
  });

  test("tombol `New chat` mengarah ke chat kosong (bukan ke percakapan)", async () => {
    serveConversations(() => ({ conversations: [], has_more: false, next_cursor: null }));
    const navigate = mock(() => {});
    renderHistory(navigate);

    await waitFor(() =>
      expect(screen.getByText("No chats yet. Send a prompt and it will show up here.")).toBeDefined(),
    );
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));

    expect(navigate).toHaveBeenCalledWith("/app/chat");
  });
});

describe("HistoryView: pagination daftar", () => {
  test("`Load more` mengambil halaman berikutnya lalu menghilang saat habis", async () => {
    const cursors = serveConversations((cursor) =>
      cursor === null
        ? {
            conversations: [conversation({ id: "conv_baru", title: "Terbaru" })],
            has_more: true,
            next_cursor: "2026-10-18T12:04:00.000Z|conv_baru",
          }
        : {
            conversations: [conversation({ id: "conv_lama", title: "Terlama" })],
            has_more: false,
            next_cursor: null,
          },
    );
    renderHistory();

    await waitFor(() => expect(screen.getByTitle("Terbaru")).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));

    await waitFor(() => expect(screen.getByTitle("Terlama")).toBeDefined());
    expect(cursors).toEqual([null, "2026-10-18T12:04:00.000Z|conv_baru"]);
    // Halaman terakhir tidak lagi menawarkan `Load more`, tapi barisnya tetap ada.
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    expect(screen.getByTitle("Terbaru")).toBeDefined();
  });
});

interface RecordedRequest {
  method: string;
  path: string;
  body: unknown;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Palsukan `fetch` untuk daftar + mutasi (PATCH/DELETE) sekaligus mencatat
 * setiap request, supaya test bisa memeriksa method, path, dan body yang
 * benar-benar dikirim klien.
 */
function serveHistory(
  requests: RecordedRequest[],
  handlers: {
    list: () => ConversationsResponse;
    patch?: (id: string, body: unknown) => Response;
    remove?: (id: string) => Response;
  },
): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    requests.push({ method, path: url.pathname, body });

    const detail = url.pathname.match(/\/v1\/conversations\/([^/]+)$/);
    if (method === "GET" && !detail) return jsonResponse(handlers.list());
    if (method === "PATCH" && detail) return handlers.patch?.(detail[1], body) ?? jsonResponse({});
    if (method === "DELETE" && detail) {
      return handlers.remove?.(detail[1]) ?? new Response(null, { status: 204 });
    }
    throw new Error(`permintaan tak terduga: ${method} ${url.pathname}`);
  }) as typeof fetch;
}

describe("HistoryView: ganti judul", () => {
  test("Escape menutup editor tanpa mengirim request", async () => {
    const requests: RecordedRequest[] = [];
    serveHistory(requests, {
      list: () => ({
        conversations: [conversation({ id: "conv_a", title: "Bikin banner" })],
        has_more: false,
        next_cursor: null,
      }),
    });
    renderHistory();

    await waitFor(() => expect(screen.getByTitle("Bikin banner")).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Rename Bikin banner" }));

    const input = screen.getByLabelText("Chat title") as HTMLInputElement;
    expect(input.value).toBe("Bikin banner");

    fireEvent.keyDown(input, { key: "Escape" });

    await waitFor(() => expect(screen.queryByLabelText("Chat title")).toBeNull());
    expect(requests.some((request) => request.method === "PATCH")).toBe(false);
  });

  test("Save mengirim PATCH dengan judul yang dipangkas", async () => {
    const requests: RecordedRequest[] = [];
    serveHistory(requests, {
      list: () => ({
        conversations: [conversation({ id: "conv_a", title: "Bikin banner" })],
        has_more: false,
        next_cursor: null,
      }),
      patch: (id, body) =>
        jsonResponse({ conversation: { id, title: (body as { title: string }).title } }),
    });
    renderHistory();

    await waitFor(() => expect(screen.getByTitle("Bikin banner")).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Rename Bikin banner" }));
    fireEvent.change(screen.getByLabelText("Chat title"), { target: { value: "  Judul baru  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(requests.some((request) => request.method === "PATCH")).toBe(true));
    const patch = requests.find((request) => request.method === "PATCH");
    expect(patch?.path.endsWith("/v1/conversations/conv_a")).toBe(true);
    expect(patch?.body).toEqual({ title: "Judul baru" });
  });
});

describe("HistoryView: hapus percakapan", () => {
  test("Cancel membatalkan konfirmasi tanpa menghapus", async () => {
    const requests: RecordedRequest[] = [];
    serveHistory(requests, {
      list: () => ({
        conversations: [conversation({ id: "conv_a", title: "Bikin banner" })],
        has_more: false,
        next_cursor: null,
      }),
    });
    renderHistory();

    await waitFor(() => expect(screen.getByTitle("Bikin banner")).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Delete Bikin banner" }));

    // Konfirmasi dua langkah muncul lebih dulu.
    expect(screen.getByText(/this cannot be undone/i)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.getByTitle("Bikin banner")).toBeDefined());
    expect(requests.some((request) => request.method === "DELETE")).toBe(false);
  });

  test("konfirmasi mengirim DELETE lalu baris hilang setelah daftar disegarkan", async () => {
    const requests: RecordedRequest[] = [];
    let removed = false;
    serveHistory(requests, {
      list: () => ({
        conversations: removed ? [] : [conversation({ id: "conv_a", title: "Bikin banner" })],
        has_more: false,
        next_cursor: null,
      }),
      remove: (id) => {
        expect(id).toBe("conv_a");
        removed = true;
        return new Response(null, { status: 204 });
      },
    });
    renderHistory();

    await waitFor(() => expect(screen.getByTitle("Bikin banner")).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Delete Bikin banner" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(
        screen.getByText("No chats yet. Send a prompt and it will show up here."),
      ).toBeDefined(),
    );
    expect(requests.some((request) => request.method === "DELETE")).toBe(true);
  });

  test("409 saat run aktif menampilkan pesan dan baris tidak hilang", async () => {
    const requests: RecordedRequest[] = [];
    serveHistory(requests, {
      list: () => ({
        conversations: [conversation({ id: "conv_a", title: "Bikin banner" })],
        has_more: false,
        next_cursor: null,
      }),
      remove: () =>
        jsonResponse(
          { error: { code: "CONVERSATION_ACTIVE", message: "This chat has a run in progress." } },
          409,
        ),
    });
    renderHistory();

    await waitFor(() => expect(screen.getByTitle("Bikin banner")).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Delete Bikin banner" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(
        screen.getByText("This chat has a run in progress. Wait for it to finish."),
      ).toBeDefined(),
    );
    // Baris konfirmasi masih ada: penghapusan tidak terjadi.
    expect(screen.getByText(/this cannot be undone/i)).toBeDefined();
  });
});

/** Palsukan `fetch` daftar + catat nilai `q` tiap permintaan. */
function serveSearch(
  queries: Array<string | null>,
  handler: (q: string | null) => ConversationsResponse,
): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input), "http://localhost");
    if (!url.pathname.endsWith("/v1/conversations")) {
      throw new Error(`permintaan tak terduga: ${url.pathname}`);
    }
    const q = url.searchParams.get("q");
    queries.push(q);
    return jsonResponse(handler(q));
  }) as typeof fetch;
}

describe("HistoryView: pencarian", () => {
  const all = [
    conversation({ id: "conv_a", title: "Bikin banner" }),
    conversation({ id: "conv_b", title: "Tulis kode" }),
  ];
  const filter = (q: string | null) =>
    q ? all.filter((item) => (item.title ?? "").toLowerCase().includes(q.toLowerCase())) : all;

  test("mengetik mengirim `q` setelah debounce dan menyaring daftar", async () => {
    const queries: Array<string | null> = [];
    serveSearch(queries, (q) => ({ conversations: filter(q), has_more: false, next_cursor: null }));
    renderHistory();

    await waitFor(() => expect(screen.getByTitle("Tulis kode")).toBeDefined());
    fireEvent.change(screen.getByLabelText("Search chats"), { target: { value: "banner" } });

    // Query dikirim ke server, bukan disaring hanya di klien.
    await waitFor(() => expect(queries).toContain("banner"));
    await waitFor(() => expect(screen.queryByTitle("Tulis kode") === null).toBe(true));
    expect(screen.getByTitle("Bikin banner")).toBeDefined();
  });

  test("tanpa hasil menampilkan ajakan + Clear mengembalikan daftar", async () => {
    const queries: Array<string | null> = [];
    serveSearch(queries, (q) => ({ conversations: filter(q), has_more: false, next_cursor: null }));
    renderHistory();

    await waitFor(() => expect(screen.getByTitle("Bikin banner")).toBeDefined());
    fireEvent.change(screen.getByLabelText("Search chats"), { target: { value: "zzz" } });

    await waitFor(() => expect(queries).toContain("zzz"));
    await waitFor(() => expect(screen.queryByText(/No chats match/)).not.toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));

    await waitFor(() => expect(screen.getByTitle("Bikin banner")).toBeDefined());
    expect(screen.getByTitle("Tulis kode")).toBeDefined();
  });
});
