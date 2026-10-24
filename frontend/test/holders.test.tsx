import "./setup";
import { afterEach, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import { WagmiProvider } from "wagmi";
import { wagmiConfig } from "../src/lib/wagmi";
import { RouterContext } from "../src/lib/router-context";
import { SessionContext, type Session } from "../src/lib/session-store";
import { HoldersPage } from "../src/site/pages/HoldersPage";
import type {
  HolderPublicTiersResponse,
  HolderStatusResponse,
} from "../src/lib/types";

afterEach(cleanup);

const MOCK_PUBLIC_TIERS: HolderPublicTiersResponse = {
  tiers: [
    {
      id: "pilot",
      name: "Pilot",
      min_tokens: "10000",
      free_runs_per_day: 5,
      free_media_per_day: 0,
      badge: "bronze",
      perks: ["5 free text runs every day", "Standard priority"],
    },
    {
      id: "commander",
      name: "Commander",
      min_tokens: "50000",
      free_runs_per_day: 15,
      free_media_per_day: 1,
      badge: "silver",
      perks: ["15 free text runs every day", "1 free media generation every day"],
    },
    {
      id: "admiral",
      name: "Fleet Admiral",
      min_tokens: "250000",
      free_runs_per_day: 40,
      free_media_per_day: 5,
      badge: "gold",
      perks: ["40 free text runs every day", "5 free media generations every day"],
    },
  ],
  rules: {
    snapshot_interval_hours: 24,
    consecutive_snapshots_required: 2,
    reset_time_utc: "00:00",
    daily_budget_usd: "50.00",
    enabled: true,
  },
};

const MOCK_STATUS: HolderStatusResponse = {
  tier: {
    id: "commander",
    name: "Commander",
    min_tokens: "50000",
    free_runs_per_day: 15,
    free_media_per_day: 1,
    badge: "silver",
    perks: ["15 free text runs every day", "1 free media generation every day"],
  },
  snapshot: {
    balance: "54200.0000",
    balance_raw: "54200000000000000000000",
    block_number: 8945210,
    taken_at: "2026-10-24T00:00:00.000Z",
    explorer_url: "https://robinhoodchain.blockscout.com/block/8945210",
  },
  free_runs: {
    limit: 15,
    used: 3,
    remaining: 12,
    media_limit: 1,
    media_used: 0,
    media_remaining: 1,
    resets_at: "2026-10-25T00:00:00.000Z",
  },
  next_tier: {
    id: "admiral",
    name: "Fleet Admiral",
    min_tokens: "250000",
    tokens_needed: "195800.0000",
    progress_pct: 22,
  },
  pending: {
    target_tier: null,
    message: null,
    next_snapshot_at: "2026-10-25T00:00:00.000Z",
  },
  today_runs: [
    {
      id: "run_test1",
      recipe_id: "text-chat",
      formation_name: "Gattai Chat",
      created_at: "2026-10-24T08:00:00.000Z",
      status: "SETTLED",
      share_slug: "test-share-slug",
    },
  ],
  budget: {
    exhausted: false,
    daily_budget_usd: "50.00",
    spent_today_usd: "4.50",
    resets_at: "2026-10-25T00:00:00.000Z",
  },
  kill_switch: false,
};

function renderHolders({
  session = null,
  status = MOCK_STATUS,
  tiers = MOCK_PUBLIC_TIERS,
}: {
  session?: Session | null;
  status?: HolderStatusResponse;
  tiers?: HolderPublicTiersResponse;
} = {}) {
  globalThis.fetch = (async (url: string | URL | Request) => {
    const urlStr = url.toString();
    if (urlStr.includes("/v1/public/holder/tiers")) {
      return new Response(JSON.stringify(tiers), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (urlStr.includes("/v1/holder/status")) {
      if (!session) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
      }
      return new Response(JSON.stringify(status), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  }) as typeof fetch;

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={client}>
        <SessionContext.Provider value={{ session, isLoading: false }}>
          <RouterContext.Provider value={{ location: "/holders", navigate: () => {} }}>
            <HoldersPage />
          </RouterContext.Provider>
        </SessionContext.Provider>
      </QueryClientProvider>
    </WagmiProvider>,
  );
}

describe("HoldersPage", () => {
  test("merender hero unauthenticated, tabel tier, dan snapshot protocol", async () => {
    const view = renderHolders({ session: null });

    await waitFor(() => {
      expect(view.getByText("Hold $GATTAI. Use AI for free.")).toBeDefined();
      expect(view.getByText("Connect wallet")).toBeDefined();
      expect(view.getAllByText("Get $GATTAI on Pons ↗").length).toBeGreaterThanOrEqual(1);
      expect(view.getByText("Formation Tiers")).toBeDefined();
      expect(view.getByText("How the 24-Hour Snapshot Protocol Works")).toBeDefined();
    });

    expect(view.getByText("Pilot")).toBeDefined();
    expect(view.getByText("Commander")).toBeDefined();
    expect(view.getByText("Fleet Admiral")).toBeDefined();
  });

  test("merender dashboard authenticated: tier card, verified snapshot, progress, dan today runs", async () => {
    const mockSession: Session = {
      address: "0x1234567890123456789012345678901234567890",
      projectId: "prj_test",
      name: "Test Project",
      chainId: 4663,
    };

    const view = renderHolders({ session: mockSession, status: MOCK_STATUS });

    await waitFor(() => {
      expect(view.getByText("Current Tier")).toBeDefined();
      expect(view.getByText("Verified Snapshot")).toBeDefined();
      expect(view.getByText("Milestone Progress")).toBeDefined();
      expect(view.getByText("Block #8945210")).toBeDefined();
      expect(view.getByText("54,200 $GATTAI")).toBeDefined();
      expect(view.getByText("Today's Holder Runs")).toBeDefined();
      expect(view.getByText("Gattai Chat")).toBeDefined();
    });
  });

  test("merender banner khusus bila kill switch aktif atau budget habis", async () => {
    const mockSession: Session = {
      address: "0x1234567890123456789012345678901234567890",
      projectId: "prj_test",
      name: "Test Project",
      chainId: 4663,
    };

    const statusWithBanners: HolderStatusResponse = {
      ...MOCK_STATUS,
      kill_switch: true,
      budget: {
        ...MOCK_STATUS.budget,
        exhausted: true,
      },
      pending: {
        target_tier: "Fleet Admiral",
        message: "Fleet Admiral unlocks after the next snapshot (~12h)",
        next_snapshot_at: "2026-10-25T00:00:00.000Z",
      },
    };

    const view = renderHolders({ session: mockSession, status: statusWithBanners });

    await waitFor(() => {
      expect(view.getByText("Holder runs are paused.")).toBeDefined();
      expect(view.getByText("Today's platform holder budget is used up.")).toBeDefined();
      expect(
        view.getByText("Fleet Admiral unlocks after the next snapshot (~12h)"),
      ).toBeDefined();
    });
  });

  test("responsive 360px: elemen utama memiliki kelas container yang sesuai", () => {
    const view = renderHolders({ session: null });
    const main = view.container.querySelector("main");
    expect(main).toBeDefined();
    expect(main?.classList.contains("holders-page")).toBe(true);
  });
});
