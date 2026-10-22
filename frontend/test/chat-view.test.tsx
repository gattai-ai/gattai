import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RouterContext } from "../src/lib/router-context";
import { SessionContext } from "../src/lib/session-store";
import type {
  ConversationDetailResponse,
  Estimate,
  Recipe,
  RunCreateResponse,
  RunInfo,
  RunStepInfo,
} from "../src/lib/types";
import { ChatView } from "../src/site/app/ChatView";

/**
 * Test komponen `ChatView` dengan DOM happy-dom.
 *
 * Providernya nyata (react-query + konteks sesi/router); yang dipalsukan hanya
 * lapisan jaringan (`fetch`) dan `EventSource`. Yang dikunci di sini adalah
 * perilaku P1/P2: klien TIDAK lagi mengirim `history`, paginasi transkrip
 * memakai kursor server, id percakapan mati (404) tidak dikirim ulang, dan chat
 * yang sudah dihapus menjelaskan dirinya sendiri alih-alih mengalihkan URL diam-diam.
 */

declare global {
  interface Window {
    /**
     * API happy-dom untuk mengganti URL dokumen. Dibutuhkan test deep link:
     * `history.replaceState` tidak memperbarui `window.location.search`, sedangkan
     * `ChatView` membaca formasi awal dari sana.
     */
    happyDOM: { setURL(url: string): void };
  }
}

afterEach(() => {
  cleanup();
  FakeEventSource.instances = [];
});

const ISO = "2026-10-18T12:04:00.000Z";
const SESSION = { session: { projectId: "prj_test", address: "0x1" }, isLoading: false };
/** Id percakapan sah (cermin `CONVERSATION_ID_PATTERN`): `conv_` + 32 heks. */
const CONV = `conv_${"1".repeat(32)}`;
const NEW_CONV = `conv_${"a".repeat(32)}`;
const RUN = `run_${"b".repeat(32)}`;

/** `EventSource` palsu: merekam instance, tidak menyambung ke jaringan. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  close(): void {
    this.closed = true;
  }
}

beforeEach(() => {
  (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;
});

const ESTIMATE: Estimate = {
  credits: 2,
  usd: 0.02,
  reserve_micro: 2_000_000,
  provider_cost_usd: 0.01,
  markup: 1,
  requires_confirmation: false,
};

function recipe(id: string, name: string, mode: string, requiresConfirmation: boolean): Recipe {
  return {
    id,
    name,
    description: "",
    mode,
    markup: 1,
    pricing: { ...ESTIMATE, requires_confirmation: requiresConfirmation },
    steps: [
      {
        id: `${id}-s1`,
        provider: id === "visual" ? "Higgsfield" : "GPT",
        role: "writer",
        role_label: "writer",
        async: false,
        stream: true,
      },
    ],
  };
}

const RECIPES: Recipe[] = [
  recipe("refine", "Refine", "streaming", false),
  recipe("visual", "Visual", "async", true),
];

function projectInfo() {
  return {
    project_id: "prj_test",
    name: "test",
    owner_wallet: null,
    onchain_id: null,
    status: "active",
    created_at: ISO,
    trial: { limit: 5, text_used: 0, remaining: 5, attempts_limit: 10, attempts_used: 0, media_limit: 2, media_used: 0 },
  };
}

function runStep(overrides: Partial<RunStepInfo> & { id: string }): RunStepInfo {
  return {
    id: overrides.id,
    provider: "Claude",
    role: "execute",
    role_label: "execute",
    status: "COMPLETE",
    usage: { input_tokens: 10, output_tokens: 20, units: null },
    provider_cost_usd: 0.001,
    latency_ms: 10,
    error: null,
    ...overrides,
  };
}

function runInfo(overrides: Partial<RunInfo> & { run_id: string }): RunInfo {
  return {
    recipe: "refine",
    recipe_version: 1,
    status: "SETTLED",
    mode: "streaming",
    is_trial: true,
    input: "Halo",
    output: { content: "Hi there" },
    cost: { reserved_micro: 0, charged_micro: 0, charged_credits: 0, charged_usd: 0, provider_cost_usd: 0 },
    error: null,
    created_at: ISO,
    finished_at: ISO,
    steps: [],
    ...overrides,
  };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

function detailResponse(
  turns: RunInfo[],
  options: { has_more?: boolean; next_cursor?: string | null } = {},
): Response {
  const body: ConversationDetailResponse = {
    conversation: { id: CONV, title: "Old chat", created_at: ISO },
    turns,
    has_more: options.has_more ?? false,
    next_cursor: options.next_cursor ?? null,
  };
  return json(body);
}

function runCreated(conversationId: string, status: RunCreateResponse["status"] = "RESERVED"): RunCreateResponse {
  return { run_id: RUN, status, estimate: ESTIMATE, is_trial: true, conversation_id: conversationId };
}

interface Recorded {
  method: string;
  path: string;
  before: string | null;
  body: Record<string, unknown> | undefined;
}

/**
 * Palsukan `fetch` untuk seluruh endpoint yang dipakai `ChatView`, sekaligus
 * mencatat setiap request agar test bisa memeriksa body yang benar-benar dikirim.
 */
function serveChat(
  requests: Recorded[],
  handlers: {
    detail?: (before: string | null) => Response;
    create?: () => Response;
    recipes?: () => Response;
  } = {},
): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    requests.push({ method, path: url.pathname, before: url.searchParams.get("before"), body });
    const path = url.pathname;

    if (path.endsWith("/v1/conversations")) {
      return json({ conversations: [], has_more: false, next_cursor: null });
    }
    if (path.endsWith("/v1/recipes")) return handlers.recipes?.() ?? json({ recipes: RECIPES });
    if (path.endsWith("/v1/project")) return json(projectInfo());
    if (path.endsWith("/v1/usage")) return json({ entries: [] });
    if (path.endsWith("/v1/router/suggest")) return json({ recipe: "refine" });
    if (method === "POST" && path.endsWith("/v1/runs")) {
      return handlers.create?.() ?? json(runCreated(NEW_CONV));
    }
    if (method === "POST" && /\/v1\/runs\/[^/]+\/confirm$/.test(path)) {
      return new Response(null, { status: 202 });
    }
    if (method === "GET" && /\/v1\/conversations\/[^/]+$/.test(path)) {
      return (
        handlers.detail?.(url.searchParams.get("before")) ??
        json({ error: { code: "CONVERSATION_NOT_FOUND", message: "not found" } }, 404)
      );
    }
    throw new Error(`permintaan tak terduga: ${method} ${path}`);
  }) as typeof fetch;
}

function renderChat(location: string, navigate: (to: string) => void = () => {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SessionContext.Provider value={SESSION}>
        <RouterContext.Provider value={{ location, navigate }}>
          <ChatView />
        </RouterContext.Provider>
      </SessionContext.Provider>
    </QueryClientProvider>,
  );
}

describe("ChatView: hidrasi transkrip", () => {
  test("menggambar turn dari server untuk id percakapan di URL", async () => {
    serveChat([], {
      detail: () => detailResponse([runInfo({ run_id: RUN, input: "Bikin banner", output: { content: "Selesai." } })]),
    });
    renderChat(`/app/chat/${CONV}`);

    // Prompt tampil juga di blok "Original request", jadi pakai `queryAllByText`.
    await waitFor(() =>
      expect(screen.queryAllByText("Bikin banner").length).toBeGreaterThan(0),
    );
    expect(screen.queryAllByText("Selesai.").length).toBeGreaterThan(0);
  });

  test("output asisten dirender sebagai Markdown (heading & tebal)", async () => {
    serveChat([], {
      detail: () =>
        detailResponse([
          runInfo({ run_id: RUN, input: "Bikin", output: { content: "# Hasil\n\nIni **tebal**." } }),
        ]),
    });
    renderChat(`/app/chat/${CONV}`);

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Hasil", level: 1 })).toBeDefined(),
    );
    expect(screen.getByText("tebal")).toBeDefined();
  });
});

describe("ChatView: label provider", () => {
  test("proses live memakai label dari recipe, bukan provider internal", async () => {
    const requests: Recorded[] = [];
    serveChat(requests);
    renderChat("/app/chat");

    await waitFor(() => expect(screen.getByRole("button", { name: "Refine" })).toBeDefined());
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "Tulis sesuatu" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(screen.queryAllByText("GPT").length).toBeGreaterThan(0));
    expect(screen.queryAllByText("mimo").length).toBe(0);
  });

  test("history memakai label step dari server, bukan provider internal", async () => {
    serveChat([], {
      detail: () =>
        detailResponse([
          runInfo({
            run_id: RUN,
            steps: [
              runStep({ id: "interpret", provider: "GPT", role: "interpret", role_label: "interpret" }),
              runStep({ id: "execute", provider: "Claude" }),
            ],
          }),
        ]),
    });
    renderChat(`/app/chat/${CONV}`);

    await waitFor(() => expect(screen.queryAllByText("GPT").length).toBeGreaterThan(0));
    expect(screen.queryAllByText("Claude").length).toBeGreaterThan(0);
    expect(screen.queryAllByText("mimo").length).toBe(0);
  });

  test("provider internal tanpa label tidak pernah tampil ke pengguna", async () => {
    serveChat([], {
      detail: () =>
        detailResponse([
          runInfo({ run_id: RUN, steps: [runStep({ id: "legacy", provider: "mimo" })] }),
        ]),
    });
    renderChat(`/app/chat/${CONV}`);

    await waitFor(() => expect(screen.queryAllByText("Model").length).toBeGreaterThan(0));
    expect(screen.queryAllByText(/mimo/i).length).toBe(0);
  });
});

describe("ChatView: kirim prompt", () => {
  test("prompt pertama TIDAK mengirim `history` dan memakai percakapan baru dari server", async () => {
    const requests: Recorded[] = [];
    serveChat(requests);
    const navigate = mock(() => {});
    renderChat("/app/chat", navigate);

    // Recipe dimuat dari server; tunggu sampai formasi tersedia sebelum kirim.
    await waitFor(() => expect(screen.getByRole("button", { name: "Refine" })).toBeDefined());
    // Ada sesi → query recipe jalan (kebalikan dari bug "formasi hilang setelah login").
    expect(requests.some((request) => request.path.endsWith("/v1/recipes"))).toBe(true);
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "Tulis sesuatu" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(requests.some((request) => request.method === "POST" && request.path.endsWith("/v1/runs"))).toBe(true));
    const create = requests.find((request) => request.method === "POST" && request.path.endsWith("/v1/runs"));
    expect(create?.body?.input).toBe("Tulis sesuatu");
    // P1: konteks dipegang server; klien tidak lagi mengirim `history`.
    expect(create?.body).not.toHaveProperty("history");
    // URL berpindah ke id yang dibuat server.
    expect(navigate).toHaveBeenCalledWith(`/app/chat/${NEW_CONV}`, { replace: true });
  });
});

describe("ChatView: pesan error & status ramah", () => {
  test("penolakan 402 menampilkan kalimat ramah + tombol Top up, tanpa kode mentah", async () => {
    const requests: Recorded[] = [];
    serveChat(requests, {
      create: () =>
        json(
          {
            error: {
              code: "INSUFFICIENT_BALANCE",
              message: "Insufficient credits.",
              topup_url: "/app/balance",
            },
          },
          402,
        ),
    });
    renderChat("/app/chat");

    await waitFor(() => expect(screen.getByRole("button", { name: "Refine" })).toBeDefined());
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "Tulis sesuatu" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(screen.getByText("Not enough credits for this run. Top up to continue.")).toBeDefined(),
    );
    expect(screen.getByRole("link", { name: "Top up" })).toBeDefined();
    expect(screen.queryByText(/INSUFFICIENT_BALANCE/)).toBeNull();
  });

  test("badge status memakai label ramah, bukan enum mentah", async () => {
    const requests: Recorded[] = [];
    serveChat(requests); // default: run dibuat dengan status RESERVED
    renderChat("/app/chat");

    await waitFor(() => expect(screen.getByRole("button", { name: "Refine" })).toBeDefined());
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "Tulis sesuatu" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(screen.getByText("RUNNING")).toBeDefined());
    expect(screen.queryByText("RESERVED")).toBeNull();
  });

  test("error run dari server disanitasi: nama env/provider tidak tampil", async () => {
    serveChat([], {
      detail: () =>
        detailResponse([
          runInfo({
            run_id: RUN,
            status: "RELEASED",
            error: "Environment variable wajib belum diisi: HIGGSFIELD_API_KEY",
          }),
        ]),
    });
    renderChat(`/app/chat/${CONV}`);

    await waitFor(() =>
      expect(screen.getByText("Something went wrong. Try again.")).toBeDefined(),
    );
    expect(screen.queryByText(/HIGGSFIELD/)).toBeNull();
    expect(screen.queryByText(/Environment variable/)).toBeNull();
  });

  test("pesan run publik dari backend ditampilkan apa adanya", async () => {
    const friendly = "This formation is temporarily unavailable. Please try again later.";
    serveChat([], {
      detail: () => detailResponse([runInfo({ run_id: RUN, status: "RELEASED", error: friendly })]),
    });
    renderChat(`/app/chat/${CONV}`);

    await waitFor(() => expect(screen.getByText(friendly)).toBeDefined());
  });
});

describe("ChatView: percakapan yang sudah tidak ada (404)", () => {
  test("menampilkan penjelasan dan TIDAK mengalihkan URL diam-diam", async () => {
    serveChat([]); // detail default = 404
    const navigate = mock(() => {});
    renderChat(`/app/chat/${CONV}`, navigate);

    await waitFor(() => expect(screen.getByText("That chat no longer exists.")).toBeDefined());
    expect(navigate).not.toHaveBeenCalled();
  });

  test("id mati tidak ikut dikirim saat prompt berikutnya; percakapan baru dibuat", async () => {
    const requests: Recorded[] = [];
    serveChat(requests);
    renderChat(`/app/chat/${CONV}`);

    await waitFor(() => expect(screen.getByText("That chat no longer exists.")).toBeDefined());
    await waitFor(() => expect(screen.getByRole("button", { name: "Refine" })).toBeDefined());

    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "Mulai lagi" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(requests.some((request) => request.method === "POST" && request.path.endsWith("/v1/runs"))).toBe(true));
    const create = requests.find((request) => request.method === "POST" && request.path.endsWith("/v1/runs"));
    expect(create?.body).not.toHaveProperty("conversation_id");
  });

  test("tombol `Start a new chat` membuka chat kosong", async () => {
    serveChat([]);
    const navigate = mock(() => {});
    renderChat(`/app/chat/${CONV}`, navigate);

    await waitFor(() => expect(screen.getByRole("button", { name: "Start a new chat" })).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Start a new chat" }));

    expect(navigate).toHaveBeenCalledWith("/app/chat", { replace: true });
  });
});

describe("ChatView: pagination transkrip", () => {
  test("`Load older turns` meminta halaman lebih lama memakai kursor server", async () => {
    const requests: Recorded[] = [];
    serveChat(requests, {
      detail: (before) =>
        before === null
          ? detailResponse([runInfo({ run_id: RUN, input: "Turn terbaru" })], {
              has_more: true,
              next_cursor: `2026-10-18T12:04:00.000Z|${RUN}`,
            })
          : detailResponse([runInfo({ run_id: `run_${"c".repeat(32)}`, input: "Turn tertua" })]),
    });
    renderChat(`/app/chat/${CONV}`);

    await waitFor(() =>
      expect(screen.queryAllByText("Turn terbaru").length).toBeGreaterThan(0),
    );
    fireEvent.click(screen.getByRole("button", { name: "Load older turns" }));

    await waitFor(() =>
      expect(screen.queryAllByText("Turn tertua").length).toBeGreaterThan(0),
    );
    const older = requests.find((request) => request.before !== null);
    expect(older?.before).toBe(`2026-10-18T12:04:00.000Z|${RUN}`);
    // Halaman terakhir: tombol tidak ditawarkan lagi.
    await waitFor(() => expect(screen.queryByRole("button", { name: "Load older turns" })).toBeNull());
  });
});

describe("ChatView: konfirmasi media", () => {
  test("formasi media menunggu konfirmasi lalu mengirim run + confirm", async () => {
    const requests: Recorded[] = [];
    serveChat(requests, { create: () => json(runCreated(NEW_CONV, "AWAITING_CONFIRMATION")) });
    renderChat("/app/chat");

    await waitFor(() => expect(screen.getByRole("button", { name: "Visual" })).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Visual" }));
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "8s teaser modul docking" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    // Belum ada run dibuat: user harus mengonfirmasi biaya lebih dulu.
    await waitFor(() => expect(screen.getByRole("button", { name: "Confirm" })).toBeDefined());
    expect(requests.some((request) => request.method === "POST" && request.path.endsWith("/v1/runs"))).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() =>
      expect(requests.some((request) => request.method === "POST" && /\/v1\/runs\/[^/]+\/confirm$/.test(request.path))).toBe(true),
    );
    expect(requests.some((request) => request.method === "POST" && request.path.endsWith("/v1/runs"))).toBe(true);
  });
});

describe("ChatView: formasi coming soon", () => {
  /**
   * Formasi yang providernya belum dikonfigurasi server (`available: false`)
   * harus terkunci: pil tidak bisa dipilih, ada badge + keterangan yang terlihat
   * tanpa hover, dan jalur kirim tidak pernah menunjuk formasi itu.
   */
  const SOON_RECIPES: Recipe[] = [
    recipe("refine", "Refine", "streaming", false),
    { ...recipe("visual", "Visual", "async", true), available: false },
  ];

  /**
   * Atur URL dokumen happy-dom. `history.replaceState` tidak memperbarui
   * `window.location.search` di lingkungan ini, sedangkan `readInitialFormation`
   * membacanya dari sana — jadi deep link harus diuji lewat API happy-dom.
   */
  function setUrl(url: string): void {
    window.happyDOM.setURL(url);
  }

  test("pil terkunci, ada badge Soon, dan keterangan tanpa perlu hover", async () => {
    serveChat([], { recipes: () => json({ recipes: SOON_RECIPES }) });
    renderChat("/app/chat");

    const visual = await screen.findByRole("button", { name: "Visual — coming soon" });
    // `aria-disabled`, bukan `disabled` native: tetap terjangkau keyboard.
    expect(visual.getAttribute("aria-disabled")).toBe("true");
    expect(visual.textContent).toContain("Soon");
    // Keterangan selalu tampil — badge saja tidak menjelaskan sebabnya, dan di
    // layar sentuh tidak ada hover.
    expect(screen.getByText(/coming soon — the media layer/)).toBeDefined();
    expect(screen.getByRole("button", { name: "Auto" })).toBeDefined();
  });

  test("mengklik pil coming soon tidak memilihnya; kirim memakai formasi yang jalan", async () => {
    const requests: Recorded[] = [];
    serveChat(requests, { recipes: () => json({ recipes: SOON_RECIPES }) });
    renderChat("/app/chat");

    const visual = await screen.findByRole("button", { name: "Visual — coming soon" });
    fireEvent.click(visual);
    // Kelasnya tetap `soon` (bukan `on`): pil tidak pernah menjadi pilihan aktif.
    expect(visual.className).toBe("soon");

    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "Bikin poster" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(
        requests.some((request) => request.method === "POST" && request.path.endsWith("/v1/runs")),
      ).toBe(true),
    );
    const create = requests.find(
      (request) => request.method === "POST" && request.path.endsWith("/v1/runs"),
    );
    expect(create?.body?.recipe_id).toBe("refine");
    // Tidak ada run media → tidak ada langkah konfirmasi biaya.
    expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
  });

  test("deep link ke formasi coming soon jatuh ke Auto", async () => {
    setUrl("http://localhost/app/chat?f=visual");
    try {
      expect(window.location.search).toBe("?f=visual");
      serveChat([], { recipes: () => json({ recipes: SOON_RECIPES }) });
      renderChat("/app/chat?f=visual");

      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Auto" }).className).toContain("on"),
      );
      expect(screen.getByRole("button", { name: "Visual — coming soon" }).className).toBe("soon");
    } finally {
      setUrl("http://localhost/");
    }
  });

  test("kontrol: deep link yang tersedia tetap terpilih (URL memang dibaca)", async () => {
    setUrl("http://localhost/app/chat?f=visual");
    try {
      expect(window.location.search).toBe("?f=visual");
      // `RECIPES` bawaan: `visual` tanpa `available` → dianggap tersedia.
      serveChat([]);
      renderChat("/app/chat?f=visual");

      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Visual" }).className).toContain("on"),
      );
      expect(screen.getByRole("button", { name: "Auto" }).className).not.toContain("on");
    } finally {
      setUrl("http://localhost/");
    }
  });
});
