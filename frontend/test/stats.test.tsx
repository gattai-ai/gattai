import { afterEach, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { RouterContext } from "../src/lib/router-context";
import { StatsPage } from "../src/site/pages/StatsPage";
import type { StatsResponse } from "../src/lib/types";

afterEach(cleanup);

const MOCK_STATS: StatsResponse = {
  usage: {
    total_runs: 1234,
    runs_24h: 12,
    runs_7d: 80,
    by_formation: [
      { recipe: "refine", name: "Refine", count: 900 },
      { recipe: "research", name: "Research", count: 334 },
    ],
    daily: [
      { date: "2026-10-23", count: 8 },
      { date: "2026-10-24", count: 12 },
    ],
    updated_at: "2026-10-24T10:00:00.000Z",
  },
  revenue: {
    deposits_usdg: "0.000000",
    settled_credits: "900.000000",
    settled_usd: "9.00000000",
    deposits_daily: [
      { date: "2026-10-23", usd: "0.00000000" },
      { date: "2026-10-24", usd: "0.00000000" },
    ],
    updated_at: "2026-10-24T10:00:00.000Z",
  },
  burns: {
    total_tokens_burned: "28061822.210522966378459998",
    total_tokens_burned_raw: "28061822210522966378459998",
    team_tokens_burned: "28061822.210522966378459998",
    team_tokens_burned_raw: "28061822210522966378459998",
    epoch_tokens_burned: "0",
    epoch_tokens_burned_raw: "0",
    community_tokens_burned: "0",
    community_tokens_burned_raw: "0",
    decimals: 18,
    total_supply: "1000000000",
    daily: [{ date: "2026-10-23", tokens: "28061822.210522966378459998" }],
    updated_at: "2026-10-24T10:00:00.000Z",
  },
  contracts: {
    chain_id: 4663,
    deposit_manager: {
      address: "0xbf1F9ea84820B619EdC58eD15304Eb22547fBC07",
      paused: false,
      explorer_url: "https://robinhoodchain.blockscout.com/address/0xbf1F9ea84820B619EdC58eD15304Eb22547fBC07",
    },
    treasury: {
      address: "0x5a777DAB051a2D05638b851330E7360C9333B905",
      explorer_url: "https://robinhoodchain.blockscout.com/address/0x5a777DAB051a2D05638b851330E7360C9333B905",
    },
    token: {
      address: "0x863019e2e676164fcfaab6e14dcd6568eb6deb1f",
      symbol: "GATTAI",
      decimals: 18,
      explorer_url: "https://robinhoodchain.blockscout.com/address/0x863019e2e676164fcfaab6e14dcd6568eb6deb1f",
    },
    updated_at: "2026-10-24T10:00:00.000Z",
  },
  holders: {
    total_runs: 45,
    runs_24h: 6,
    runs_7d: 28,
    subsidized_cost_usd: "0.24500000",
    allocated_pool_usd: "500.000000",
    by_tier: [
      { tier: "pilot", name: "Pilot", count: 20 },
      { tier: "commander", name: "Commander", count: 18 },
      { tier: "admiral", name: "Fleet Admiral", count: 7 },
    ],
    daily: [
      { date: "2026-10-23", count: 4, subsidized_usd: "0.02000000" },
      { date: "2026-10-24", count: 6, subsidized_usd: "0.03500000" },
    ],
    updated_at: "2026-10-24T10:00:00.000Z",
  },
};

function renderStats(response: unknown = MOCK_STATS, ok = true) {
  globalThis.fetch = (async () => {
    return new Response(JSON.stringify(response), {
      status: ok ? 200 : 500,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={client}>
      <RouterContext.Provider value={{ location: "/stats", navigate: () => {} }}>
        <StatsPage />
      </RouterContext.Provider>
    </QueryClientProvider>,
  );
}

describe("StatsPage", () => {
  test("merender hero, contracts, usage, revenue, dan burns", async () => {
    renderStats();

    await waitFor(() => {
      expect(screen.getByText("Product & Flywheel Stats")).toBeDefined();
      expect(screen.getByText("DepositManager")).toBeDefined();
      expect(screen.getByText("Treasury (Safe)")).toBeDefined();
      expect(screen.getByText("$GATTAI Token")).toBeDefined();
      expect(screen.getByText("Total Settled Runs")).toBeDefined();
      expect(screen.getByText("1,234")).toBeDefined();
      expect(screen.getByText("Revenue & Settlement")).toBeDefined();
      expect(screen.getByText("Onchain Token Burns")).toBeDefined();
    });

    // Formations breakdown
    expect(screen.getByText("Refine")).toBeDefined();
    expect(screen.getByText("900 runs")).toBeDefined();
    expect(screen.getByText("Research")).toBeDefined();
    expect(screen.getByText("334 runs")).toBeDefined();

    // Holder runs section
    expect(screen.getByText("Holder Runs & Protocol Subsidies")).toBeDefined();
    expect(screen.getByText("Total Holder Runs")).toBeDefined();
    expect(screen.getByText("45")).toBeDefined();
    expect(screen.getByText("Fleet Admiral")).toBeDefined();
    expect(screen.getByText("7 runs")).toBeDefined();
    expect(screen.getByText("Explore Holder Tiers & Quotas →")).toBeDefined();

    // Honest note saat deposits 0
    expect(
      screen.getByText("Deposits open after the mainnet smoke test."),
    ).toBeDefined();

    // Link ke /burns dashboard
    expect(
      screen.getByText("View Full Burn Dashboard & Verification →"),
    ).toBeDefined();
  });

  test("holder runs empty state menampilkan catatan jujur", async () => {
    const emptyHolderStats = {
      ...MOCK_STATS,
      holders: {
        ...MOCK_STATS.holders,
        total_runs: 0,
        runs_24h: 0,
        runs_7d: 0,
        subsidized_cost_usd: "0.00000000",
        allocated_pool_usd: "0.000000",
        by_tier: [
          { tier: "pilot", name: "Pilot", count: 0 },
          { tier: "commander", name: "Commander", count: 0 },
          { tier: "admiral", name: "Fleet Admiral", count: 0 },
        ],
      },
    };

    renderStats(emptyHolderStats);

    await waitFor(() => {
      expect(
        screen.getByText("Holders unlock free quotas via 2-snapshot verification."),
      ).toBeDefined();
    });
  });

  test("status DepositManager menampilkan badge yang sesuai", async () => {
    renderStats();

    await waitFor(() => {
      expect(screen.getByText("Active")).toBeDefined();
    });
  });

  test("menangani error fetch dan menampilkan tombol Retry", async () => {
    renderStats({ error: "Server down" }, false);

    await waitFor(() => {
      expect(screen.getByText("Failed to load statistics")).toBeDefined();
      expect(screen.getByText("Retry")).toBeDefined();
    });
  });
});
