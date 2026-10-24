import { afterEach, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RouterContext } from "../src/lib/router-context";
import { SessionContext, type Session } from "../src/lib/session-store";
import { LeaderboardPage } from "../src/site/pages/LeaderboardPage";
import type { LeaderboardMeResponse, LeaderboardResponse } from "../src/lib/types";

/**
 * Halaman leaderboard:
 *  - tab current/previous memakai query yang benar,
 *  - rank pribadi diambil dari endpoint terautentikasi (bukan response cache),
 *  - opt-out mengirim boolean eksplisit,
 *  - alias publik tidak membawa wallet.
 */

afterEach(cleanup);

const CURRENT_WEEK = {
  start: "2026-10-19T00:00:00.000Z",
  end: "2026-10-26T00:00:00.000Z",
  label: "current" as const,
};

const PREVIOUS_WEEK = {
  start: "2026-10-12T00:00:00.000Z",
  end: "2026-10-19T00:00:00.000Z",
  label: "previous" as const,
};

const BOARD: LeaderboardResponse = {
  week: CURRENT_WEEK,
  entries: [
    { rank: 1, display_name: "Project abcd", runs: 200, is_me: false },
    { rank: 2, display_name: "Project 1234", runs: 87, is_me: false },
  ],
  me: null,
  updated_at: "2026-10-24T10:00:00.000Z",
};

const PREVIOUS_BOARD: LeaderboardResponse = {
  week: PREVIOUS_WEEK,
  entries: [{ rank: 1, display_name: "Project prev", runs: 200, is_me: false }],
  me: null,
  updated_at: "2026-10-19T00:00:00.000Z",
};

const ME: LeaderboardMeResponse = {
  week: CURRENT_WEEK,
  me: {
    rank: 1,
    runs: 42,
    opted_out: false,
    display_name: "Project abcd",
  },
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderBoard(session: Session | null = null) {
  return render(
    <QueryClientProvider client={makeClient()}>
      <SessionContext.Provider value={{ session, isLoading: false }}>
        <RouterContext.Provider value={{ location: "/leaderboard", navigate: () => {} }}>
          <LeaderboardPage />
        </RouterContext.Provider>
      </SessionContext.Provider>
    </QueryClientProvider>,
  );
}

describe("LeaderboardPage", () => {
  test("merender entri publik, meta, dan CTA login tanpa wallet", async () => {
    const paths: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input), "http://localhost");
      paths.push(`${url.pathname}${url.search}`);
      if (url.pathname.endsWith("/v1/public/leaderboard")) return json(BOARD);
      throw new Error(`permintaan tak terduga: ${url.pathname}`);
    }) as typeof fetch;

    renderBoard();

    await screen.findByText("Project abcd");
    expect(screen.getByText("Project 1234")).toBeDefined();
    expect(screen.getByText("200")).toBeDefined();
    expect(screen.getByText("87")).toBeDefined();
    expect(screen.getByRole("link", { name: "Sign in" })).toBeDefined();
    expect(document.body.textContent).not.toContain("0x");
    expect(document.title).toContain("GATTAI Leaderboard");
    expect(paths.some((path) => path.includes("/v1/public/leaderboard?week=current"))).toBe(true);
  });

  test("tab Last week meminta window previous", async () => {
    const paths: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input), "http://localhost");
      paths.push(`${url.pathname}${url.search}`);
      if (!url.pathname.endsWith("/v1/public/leaderboard")) {
        throw new Error(`permintaan tak terduga: ${url.pathname}`);
      }
      return json(url.searchParams.get("week") === "previous" ? PREVIOUS_BOARD : BOARD);
    }) as typeof fetch;

    renderBoard();
    await screen.findByText("Project abcd");

    fireEvent.click(screen.getByRole("tab", { name: "Last week" }));

    await screen.findByText("Project prev");
    expect(paths.some((path) => path.includes("/v1/public/leaderboard?week=previous"))).toBe(true);
  });

  test("user login melihat rank pribadi dan opt-out mengirim boolean", async () => {
    const optOutBodies: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname.endsWith("/v1/public/leaderboard")) return json(BOARD);
      if (url.pathname.endsWith("/v1/leaderboard/me")) return json(ME);
      if (url.pathname.endsWith("/v1/leaderboard/opt-out") && init?.method === "POST") {
        optOutBodies.push(String(init.body));
        return json({ opted_out: true });
      }
      throw new Error(`permintaan tak terduga: ${init?.method ?? "GET"} ${url.pathname}`);
    }) as typeof fetch;

    renderBoard({ projectId: "prj_test", address: "0xabcdef" });

    await screen.findByText("#1");
    expect(screen.getByText("42 settled runs this week")).toBeDefined();
    // Muncul dua kali: baris tabel (dengan badge "You") dan kartu rank pribadi.
    expect(screen.getAllByText("Project abcd")).toHaveLength(2);
    expect(screen.getByText("You")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Opt out" }));

    await waitFor(() => expect(optOutBodies).toHaveLength(1));
    expect(optOutBodies[0]).toBe(JSON.stringify({ opted_out: true }));
  });

  test("opt-out aktif menampilkan tombol Join leaderboard dan mengirim false", async () => {
    const optOutBodies: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname.endsWith("/v1/public/leaderboard")) return json(BOARD);
      if (url.pathname.endsWith("/v1/leaderboard/me")) {
        return json({
          week: CURRENT_WEEK,
          me: { rank: 3, runs: 42, opted_out: true, display_name: "Project abcd" },
        } satisfies LeaderboardMeResponse);
      }
      if (url.pathname.endsWith("/v1/leaderboard/opt-out") && init?.method === "POST") {
        optOutBodies.push(String(init.body));
        return json({ opted_out: false });
      }
      throw new Error(`permintaan tak terduga: ${url.pathname}`);
    }) as typeof fetch;

    renderBoard({ projectId: "prj_test", address: "0xabcdef" });

    await screen.findByRole("button", { name: "Join leaderboard" });
    expect(screen.getByText(/hidden from the public leaderboard/i)).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Join leaderboard" }));
    await waitFor(() => expect(optOutBodies).toHaveLength(1));
    expect(optOutBodies[0]).toBe(JSON.stringify({ opted_out: false }));
  });

  test("user dengan holder tier menampilkan badge tier di panel rank pribadi dan tabel", async () => {
    const meWithTier: LeaderboardMeResponse = {
      week: CURRENT_WEEK,
      me: {
        rank: 1,
        runs: 42,
        opted_out: false,
        display_name: "Project abcd",
        tier: { id: "commander", name: "Commander" },
      },
    };

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname.endsWith("/v1/public/leaderboard")) return json(BOARD);
      if (url.pathname.endsWith("/v1/leaderboard/me")) return json(meWithTier);
      throw new Error(`permintaan tak terduga: ${url.pathname}`);
    }) as typeof fetch;

    renderBoard({ projectId: "prj_test", address: "0xabcdef" });

    await screen.findByText("#1");
    expect(screen.getAllByText(/Commander/i).length).toBeGreaterThanOrEqual(1);
  });
});
