import { afterEach, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RouterContext } from "../src/lib/router-context";
import { RunPage } from "../src/site/pages/RunPage";
import { ShareDialog } from "../src/site/app/ShareDialog";
import type { PublicRunResponse, RunInfo, ShareResponse } from "../src/lib/types";

/**
 * Halaman share + dialog share: kontrak publik sempit, prompt mengikuti
 * toggle, dan CTA membawa formasi + prompt ke composer.
 */

afterEach(() => cleanup());

const ISO = "2026-10-24T10:00:00.000Z";
const SLUG = "0123456789abcdef0123456789abcdef";

const PUBLIC_RUN: PublicRunResponse = {
  slug: SLUG,
  formation: { id: "refine", name: "Refine", mode: "streaming" },
  prompt: "Sharpen this landing headline.",
  output: { type: "streaming", content: "# Three options\n\n1. One formation.", media: null },
  steps: [
    {
      role: "planner",
      role_label: "Planner",
      provider: "GPT",
      status: "COMPLETE",
      summary: "Tightened the brief.",
      duration_ms: 1200,
    },
    {
      role: "executor",
      role_label: "Executor",
      provider: "Claude",
      status: "COMPLETE",
      summary: "Wrote the result.",
      duration_ms: 2400,
    },
  ],
  cost: { credits: "12.000000", usd: "0.12000000" },
  created_at: ISO,
  finished_at: ISO,
};

const RUN_INFO: RunInfo = {
  run_id: "run_test",
  recipe: "refine",
  recipe_version: 1,
  status: "SETTLED",
  mode: "streaming",
  is_trial: false,
  input: "Sharpen this landing headline.",
  output: { type: "streaming", content: "ok" },
  cost: {
    reserved_micro: 12_000_000,
    charged_micro: 12_000_000,
    charged_credits: 12,
    charged_usd: 0.12,
    provider_cost_usd: 0.01,
  },
  error: null,
  created_at: ISO,
  finished_at: ISO,
  steps: [],
};

const SHARE: ShareResponse = {
  slug: SLUG,
  url: `https://gattai.test/run/${SLUG}`,
  show_prompt: true,
  created_at: ISO,
};

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderRun() {
  return render(
    <QueryClientProvider client={client()}>
      <RouterContext.Provider value={{ location: `/run/${SLUG}`, navigate: () => {} }}>
        <RunPage slug={SLUG} />
      </RouterContext.Provider>
    </QueryClientProvider>,
  );
}

describe("RunPage", () => {
  test("merender run publik dan CTA membawa prompt + formasi", async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input), "http://localhost");
      if (!url.pathname.endsWith(`/v1/public/runs/${SLUG}`)) {
        throw new Error(`permintaan tak terduga: ${url.pathname}`);
      }
      return new Response(JSON.stringify(PUBLIC_RUN), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    renderRun();

    await screen.findByText("Refine");
    expect(screen.getByText("Sharpen this landing headline.")).toBeDefined();
    expect(screen.getByText("Planner")).toBeDefined();
    expect(screen.getByText("Executor")).toBeDefined();
    expect(screen.getByText("One formation.")).toBeDefined();

    const cta = screen.getByRole("link", { name: "Run this formation" }) as HTMLAnchorElement;
    expect(cta.getAttribute("href")).toContain("/app/chat?f=refine&prompt=Sharpen");
    expect(document.title).toContain("Refine · Shared run · GATTAI");
  });

  test("share yang dicabut menampilkan 404 branded dan noindex", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { code: "RUN_NOT_FOUND", message: "Run not found." } }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;

    renderRun();

    await screen.findByText("This run isn’t available.");
    const robots = document.head.querySelector('meta[name="robots"]');
    expect(robots?.getAttribute("content")).toBe("noindex, nofollow");
  });
});

describe("ShareDialog", () => {
  test("membuat link setelah user menekan tombol dan menampilkan URL", async () => {
    const requests: Array<{ method: string; path: string; body: string | null }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      requests.push({
        method: init?.method ?? "GET",
        path: url.pathname,
        body: typeof init?.body === "string" ? init.body : null,
      });
      if (url.pathname.endsWith("/v1/runs/run_test") && (init?.method ?? "GET") === "GET") {
        return new Response(JSON.stringify(RUN_INFO), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.pathname.endsWith("/v1/runs/run_test/share") && (init?.method ?? "GET") === "GET") {
        return new Response(JSON.stringify({ share: null }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.pathname.endsWith("/v1/runs/run_test/share") && init?.method === "POST") {
        return new Response(JSON.stringify(SHARE), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`permintaan tak terduga: ${init?.method ?? "GET"} ${url.pathname}`);
    }) as typeof fetch;

    render(
      <QueryClientProvider client={client()}>
        <ShareDialog runId="run_test" title="Refine" onClose={() => {}} />
      </QueryClientProvider>,
    );

    await screen.findByText("Sharpen this landing headline.");
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Create public link" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );

    fireEvent.click(screen.getByRole("button", { name: "Create public link" }));
    await screen.findByDisplayValue(SHARE.url);

    const post = requests.find((request) => request.method === "POST");
    expect(post?.body).toBe(JSON.stringify({ show_prompt: true }));
  });
});
