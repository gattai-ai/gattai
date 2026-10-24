import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { api } from "@/lib/api";
import { shortAddress } from "@/lib/explorer";
import { formatCredits, formatRelativeTime } from "@/lib/format";
import { compactAmount, exactAmount } from "@/lib/burn-format";
import { useDocumentMeta } from "@/site/useSite";
import type { StatsResponse } from "@/lib/types";
import "../stats.css";

interface ChartPoint {
  date: string;
  value: number;
  label?: string;
}

function SimpleLineChart({
  points,
  unit = "",
  formatValue,
  color = "#ff5b1f",
}: {
  points: ChartPoint[];
  unit?: string;
  formatValue?: (val: number) => string;
  color?: string;
}) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const W = 640;
  const H = 180;
  const L = 46;
  const R = 16;
  const T = 16;
  const B = 26;

  const { maxVal, pathD, areaD, coords } = useMemo(() => {
    if (points.length === 0) {
      return { maxVal: 1, pathD: "", areaD: "", coords: [] };
    }
    const rawMax = Math.max(...points.map((p) => p.value), 0);
    const maxVal = rawMax === 0 ? 10 : Math.ceil(rawMax * 1.15);

    const coords = points.map((p, i) => {
      const x = L + (i / Math.max(1, points.length - 1)) * (W - L - R);
      const y = H - B - (p.value / maxVal) * (H - B - T);
      return { x, y, ...p };
    });

    const pathD = coords.reduce(
      (acc, curr, i) => (i === 0 ? `M ${curr.x} ${curr.y}` : `${acc} L ${curr.x} ${curr.y}`),
      "",
    );

    const areaD = coords.length > 0
      ? `${pathD} L ${coords[coords.length - 1].x} ${H - B} L ${coords[0].x} ${H - B} Z`
      : "";

    return { maxVal, pathD, areaD, coords };
  }, [points]);

  const yTicks = [0, Math.round(maxVal / 2), maxVal];

  return (
    <div className="stats-svg-wrap" onMouseLeave={() => setHoverIdx(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        <defs>
          <linearGradient id={`grad-${color.replace("#", "")}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.28" />
            <stop offset="100%" stopColor={color} stopOpacity="0.00" />
          </linearGradient>
        </defs>

        {/* Grid lines */}
        {yTicks.map((tick) => {
          const y = H - B - (tick / maxVal) * (H - B - T);
          return (
            <g key={tick}>
              <line
                x1={L}
                y1={y}
                x2={W - R}
                y2={y}
                stroke="var(--line2)"
                strokeDasharray="3 3"
                strokeWidth="1"
              />
              <text
                x={L - 6}
                y={y + 3}
                fill="var(--dim)"
                fontSize="10"
                fontFamily="var(--mono)"
                textAnchor="end"
              >
                {formatValue ? formatValue(tick) : tick}
              </text>
            </g>
          );
        })}

        {/* X-axis dates: first, middle, last */}
        {points.length > 0 && (
          <>
            <text
              x={L}
              y={H - 8}
              fill="var(--dim)"
              fontSize="10"
              fontFamily="var(--mono)"
              textAnchor="start"
            >
              {points[0].date.slice(5)}
            </text>
            {points.length > 2 && (
              <text
                x={L + (W - L - R) / 2}
                y={H - 8}
                fill="var(--dim)"
                fontSize="10"
                fontFamily="var(--mono)"
                textAnchor="middle"
              >
                {points[Math.floor(points.length / 2)].date.slice(5)}
              </text>
            )}
            <text
              x={W - R}
              y={H - 8}
              fill="var(--dim)"
              fontSize="10"
              fontFamily="var(--mono)"
              textAnchor="end"
            >
              {points[points.length - 1].date.slice(5)}
            </text>
          </>
        )}

        {/* Area & line */}
        {areaD && <path d={areaD} fill={`url(#grad-${color.replace("#", "")})`} />}
        {pathD && (
          <path
            d={pathD}
            fill="none"
            stroke={color}
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}

        {/* Hover targets & points */}
        {coords.map((pt, i) => (
          <g key={pt.date} onMouseEnter={() => setHoverIdx(i)}>
            <circle
              cx={pt.x}
              cy={pt.y}
              r={hoverIdx === i ? 4.5 : 2}
              fill={color}
              stroke="var(--panel)"
              strokeWidth={hoverIdx === i ? 2 : 1}
              style={{ transition: "r 0.15s ease" }}
            />
            {/* Hit area */}
            <rect
              x={pt.x - (W - L - R) / points.length / 2}
              y={T}
              width={(W - L - R) / points.length}
              height={H - T - B}
              fill="transparent"
              style={{ cursor: "crosshair" }}
            />
          </g>
        ))}

        {/* Active Tooltip */}
        {hoverIdx !== null && coords[hoverIdx] && (
          <g>
            <line
              x1={coords[hoverIdx].x}
              y1={T}
              x2={coords[hoverIdx].x}
              y2={H - B}
              stroke="var(--line)"
              strokeWidth="1"
            />
            <rect
              x={Math.min(W - 130, Math.max(L, coords[hoverIdx].x - 60))}
              y={Math.max(T, coords[hoverIdx].y - 38)}
              width="120"
              height="28"
              rx="6"
              fill="var(--ink)"
              stroke="var(--line2)"
            />
            <text
              x={Math.min(W - 130, Math.max(L, coords[hoverIdx].x - 60)) + 60}
              y={Math.max(T, coords[hoverIdx].y - 38) + 18}
              fill="var(--text)"
              fontSize="11"
              fontFamily="var(--mono)"
              fontWeight="600"
              textAnchor="middle"
            >
              {coords[hoverIdx].date}: {formatValue ? formatValue(coords[hoverIdx].value) : coords[hoverIdx].value} {unit}
            </text>
          </g>
        )}
      </svg>
    </div>
  );
}

export function StatsPage() {
  useDocumentMeta({
    title: "GATTAI Stats — Onchain usage, revenue & burns",
    description:
      "Verifiable product usage, settled revenue, and token burn metrics for GATTAI settled on Robinhood Chain.",
    image: "https://www.gattai.tech/logo_gattai.png",
    url: "https://www.gattai.tech/stats",
  });

  const { data, isLoading, error, refetch } = useQuery<StatsResponse>({
    queryKey: ["stats"],
    queryFn: () => api<StatsResponse>("/v1/public/stats"),
    staleTime: 60_000,
  });

  const [copied, setCopied] = useState<string | null>(null);
  const copyAddress = (addr: string) => {
    navigator.clipboard?.writeText(addr);
    setCopied(addr);
    setTimeout(() => setCopied(null), 2000);
  };

  const usageDailyPoints: ChartPoint[] = useMemo(() => {
    if (!data?.usage?.daily) return [];
    return data.usage.daily.map((d) => ({
      date: d.date,
      value: d.count,
    }));
  }, [data?.usage?.daily]);

  const revenueDailyPoints: ChartPoint[] = useMemo(() => {
    if (!data?.revenue?.deposits_daily) return [];
    return data.revenue.deposits_daily.map((d) => ({
      date: d.date,
      value: Number(d.usd) || 0,
    }));
  }, [data?.revenue?.deposits_daily]);

  const burnDailyPoints: ChartPoint[] = useMemo(() => {
    if (!data?.burns?.daily) return [];
    return data.burns.daily.map((d) => ({
      date: d.date,
      value: Number(d.tokens) || 0,
    }));
  }, [data?.burns?.daily]);

  const holderDailyPoints: ChartPoint[] = useMemo(() => {
    if (!data?.holders?.daily) return [];
    return data.holders.daily.map((d) => ({
      date: d.date,
      value: d.count,
    }));
  }, [data?.holders?.daily]);

  return (
    <main className="stats-page wrap">
      {/* Hero Header */}
      <section className="stats-hero">
        <span className="eyebrow">Public Flywheel</span>
        <h1 className="h1" style={{ marginTop: 12 }}>
          Product &amp; Flywheel Stats
        </h1>
        <p className="lede" style={{ marginTop: 14 }}>
          Every metric is verifiable onchain or derived directly from settled execution ledgers.
          Zero projections, zero synthetic vanity metrics.
        </p>

        <div className="stats-hero-meta">
          <span className="stats-live-dot" />
          <span>Settled on Robinhood Chain</span>
          <span className="stats-sep">·</span>
          <span>Chain ID {data?.contracts?.chain_id ?? 4663}</span>
          <span className="stats-sep">·</span>
          <span>Cache: 60s</span>
        </div>
      </section>

      {/* Loading state */}
      {isLoading && (
        <div style={{ padding: "64px 0", color: "var(--muted)", textAlign: "center" }}>
          <p className="mono">Loading verifiable platform statistics…</p>
        </div>
      )}

      {/* Error state */}
      {error && (
        <div className="stats-card" style={{ marginTop: 32, borderColor: "rgba(255, 91, 31, .4)" }}>
          <h4 style={{ color: "var(--acc2)" }}>Failed to load statistics</h4>
          <p style={{ marginTop: 8, color: "var(--muted)", fontSize: 14 }}>
            Could not fetch data from the public stats endpoint.
          </p>
          <button
            type="button"
            className="btn btn-outline"
            style={{ marginTop: 16, width: "fit-content" }}
            onClick={() => refetch()}
          >
            Retry
          </button>
        </div>
      )}

      {data && (
        <>
          {/* Contracts Section */}
          <section className="stats-section">
            <div className="stats-section-head">
              <h2>Onchain Contracts</h2>
              <span className="stats-updated">
                Updated {formatRelativeTime(data.contracts.updated_at)}
              </span>
            </div>

            <div className="stats-contracts-grid">
              {/* DepositManager */}
              <div className="stats-contract-card">
                <div className="stats-contract-title">
                  <span className="stats-contract-name">DepositManager</span>
                  {data.contracts.deposit_manager.paused === false ? (
                    <span className="stats-badge ok">Active</span>
                  ) : data.contracts.deposit_manager.paused === true ? (
                    <span className="stats-badge warn">Paused</span>
                  ) : (
                    <span className="stats-badge dim" title="RPC call timed out or unverified">
                      Status Pending
                    </span>
                  )}
                </div>
                <div className="stats-contract-addr">
                  <a
                    href={data.contracts.deposit_manager.explorer_url}
                    target="_blank"
                    rel="noreferrer"
                    title={data.contracts.deposit_manager.address}
                  >
                    {shortAddress(data.contracts.deposit_manager.address)}
                  </a>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    style={{ padding: "2px 6px", fontSize: 10, fontFamily: "var(--mono)" }}
                    onClick={() => copyAddress(data.contracts.deposit_manager.address)}
                  >
                    {copied === data.contracts.deposit_manager.address ? "Copied" : "Copy"}
                  </button>
                </div>
              </div>

              {/* Safe Treasury */}
              <div className="stats-contract-card">
                <div className="stats-contract-title">
                  <span className="stats-contract-name">Treasury (Safe)</span>
                  <span className="stats-badge ok">Multisig</span>
                </div>
                <div className="stats-contract-addr">
                  <a
                    href={data.contracts.treasury.explorer_url}
                    target="_blank"
                    rel="noreferrer"
                    title={data.contracts.treasury.address}
                  >
                    {shortAddress(data.contracts.treasury.address)}
                  </a>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    style={{ padding: "2px 6px", fontSize: 10, fontFamily: "var(--mono)" }}
                    onClick={() => copyAddress(data.contracts.treasury.address)}
                  >
                    {copied === data.contracts.treasury.address ? "Copied" : "Copy"}
                  </button>
                </div>
              </div>

              {/* Token $GATTAI */}
              <div className="stats-contract-card">
                <div className="stats-contract-title">
                  <span className="stats-contract-name">${data.contracts.token.symbol} Token</span>
                  <span className="stats-badge ok">{data.contracts.token.decimals} Decimals</span>
                </div>
                <div className="stats-contract-addr">
                  <a
                    href={data.contracts.token.explorer_url}
                    target="_blank"
                    rel="noreferrer"
                    title={data.contracts.token.address}
                  >
                    {shortAddress(data.contracts.token.address)}
                  </a>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    style={{ padding: "2px 6px", fontSize: 10, fontFamily: "var(--mono)" }}
                    onClick={() => copyAddress(data.contracts.token.address)}
                  >
                    {copied === data.contracts.token.address ? "Copied" : "Copy"}
                  </button>
                </div>
              </div>
            </div>
          </section>

          {/* Usage Section */}
          <section className="stats-section">
            <div className="stats-section-head">
              <h2>Product Usage</h2>
              <span className="stats-updated">
                Updated {formatRelativeTime(data.usage.updated_at)}
              </span>
            </div>

            <div className="stats-grid-4">
              <div className="stats-card">
                <span className="stats-card-label">Total Settled Runs</span>
                <span className="stats-card-num">{data.usage.total_runs.toLocaleString("en-US")}</span>
                <span className="stats-card-sub">All-time completions</span>
              </div>
              <div className="stats-card">
                <span className="stats-card-label">Runs (Last 24 Hours)</span>
                <span className="stats-card-num">{data.usage.runs_24h.toLocaleString("en-US")}</span>
                <span className="stats-card-sub">Daily run velocity</span>
              </div>
              <div className="stats-card">
                <span className="stats-card-label">Runs (Last 7 Days)</span>
                <span className="stats-card-num">{data.usage.runs_7d.toLocaleString("en-US")}</span>
                <span className="stats-card-sub">Weekly completions</span>
              </div>
              <div className="stats-card">
                <span className="stats-card-label">Active Formations</span>
                <span className="stats-card-num">{data.usage.by_formation.length}</span>
                <span className="stats-card-sub">Configured workflows</span>
              </div>
            </div>

            {/* Daily Runs 30-Day Line Chart */}
            <div className="stats-chart-card">
              <div className="stats-chart-head">
                <span className="stats-chart-title">Settled Runs (Past 30 Days)</span>
                <span className="stats-chart-meta">Daily UTC Activity</span>
              </div>
              <SimpleLineChart
                points={usageDailyPoints}
                unit="runs"
                formatValue={(v) => Math.round(v).toString()}
                color="#ff5b1f"
              />
            </div>

            {/* Formation breakdown */}
            {data.usage.by_formation.length > 0 && (
              <div style={{ marginTop: 24 }}>
                <h4 style={{ fontSize: 14, color: "var(--dim)", textTransform: "uppercase", letterSpacing: ".08em" }}>
                  Runs By Formation
                </h4>
                <div className="stats-formation-list">
                  {data.usage.by_formation.map((f) => (
                    <div key={f.recipe} className="stats-formation-row">
                      <div className="stats-formation-info">
                        <span className="stats-formation-name">{f.name ?? f.recipe}</span>
                        <span className="stats-formation-id">({f.recipe})</span>
                      </div>
                      <span className="stats-formation-count">{f.count.toLocaleString("en-US")} runs</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>

          {/* Revenue Section */}
          <section className="stats-section">
            <div className="stats-section-head">
              <h2>Revenue &amp; Settlement</h2>
              <span className="stats-updated">
                Updated {formatRelativeTime(data.revenue.updated_at)}
              </span>
            </div>

            <div className="stats-grid-3">
              <div className="stats-card">
                <span className="stats-card-label">USDG Deposits</span>
                <span className="stats-card-num">
                  ${Number(data.revenue.deposits_usdg).toLocaleString("en-US", { minimumFractionDigits: 2 })}
                </span>
                <span className="stats-card-sub">Total onchain deposits</span>
                {Number(data.revenue.deposits_usdg) === 0 && (
                  <div className="stats-honest-note">
                    Deposits open after the mainnet smoke test.
                  </div>
                )}
              </div>

              <div className="stats-card">
                <span className="stats-card-label">Settled Revenue</span>
                <span className="stats-card-num">
                  {formatCredits(data.revenue.settled_credits)}
                </span>
                <span className="stats-card-sub">Credits consumed by settled runs</span>
              </div>

              <div className="stats-card">
                <span className="stats-card-label">Settled USD Equivalent</span>
                <span className="stats-card-num">
                  ${Number(data.revenue.settled_usd).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}
                </span>
                <span className="stats-card-sub">Valued at 100 credits = $1.00 USD</span>
              </div>
            </div>

            {/* Daily Deposits 30-Day Line Chart */}
            <div className="stats-chart-card">
              <div className="stats-chart-head">
                <span className="stats-chart-title">Deposit Volume (Past 30 Days)</span>
                <span className="stats-chart-meta">USD Equivalent</span>
              </div>
              <SimpleLineChart
                points={revenueDailyPoints}
                unit="USD"
                formatValue={(v) => `$${v.toFixed(0)}`}
                color="#7fd1a0"
              />
            </div>
          </section>

          {/* Holder Runs & Subsidies Section */}
          <section className="stats-section">
            <div className="stats-section-head">
              <h2>Holder Runs &amp; Protocol Subsidies</h2>
              <span className="stats-updated">
                Updated {formatRelativeTime(data.holders.updated_at)}
              </span>
            </div>

            <div className="stats-grid-4">
              <div className="stats-card">
                <span className="stats-card-label">Total Holder Runs</span>
                <span className="stats-card-num">{data.holders.total_runs.toLocaleString("en-US")}</span>
                <span className="stats-card-sub">AI formations run free by token holders</span>
                {data.holders.total_runs === 0 && (
                  <div className="stats-honest-note">
                    Holders unlock free quotas via 2-snapshot verification.
                  </div>
                )}
              </div>

              <div className="stats-card">
                <span className="stats-card-label">Runs (Last 24 Hours)</span>
                <span className="stats-card-num">{data.holders.runs_24h.toLocaleString("en-US")}</span>
                <span className="stats-card-sub">Daily holder velocity</span>
              </div>

              <div className="stats-card">
                <span className="stats-card-label">Subsidized AI Cost</span>
                <span className="stats-card-num">
                  ${Number(data.holders.subsidized_cost_usd).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}
                </span>
                <span className="stats-card-sub">Provider compute funded by protocol</span>
              </div>

              <div className="stats-card">
                <span className="stats-card-label">Allocated Fee Pool</span>
                <span className="stats-card-num">
                  ${Number(data.holders.allocated_pool_usd).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
                <span className="stats-card-sub">Ecosystem fee split reserve</span>
              </div>
            </div>

            {/* Daily Holder Runs 30-Day Line Chart */}
            <div className="stats-chart-card">
              <div className="stats-chart-head">
                <span className="stats-chart-title">Holder Free Runs (Past 30 Days)</span>
                <span className="stats-chart-meta">Daily Execution Volume</span>
              </div>
              <SimpleLineChart
                points={holderDailyPoints}
                unit="runs"
                formatValue={(v) => Math.round(v).toString()}
                color="#7fd1a0"
              />
            </div>

            {/* By Tier Breakdown */}
            {data.holders.by_tier.length > 0 && (
              <div style={{ marginTop: 24 }}>
                <h4 style={{ fontSize: 14, color: "var(--dim)", textTransform: "uppercase", letterSpacing: ".08em" }}>
                  Usage By Tier
                </h4>
                <div className="stats-formation-list">
                  {data.holders.by_tier.map((t) => (
                    <div key={t.tier} className="stats-formation-row">
                      <div className="stats-formation-info">
                        <span className="stats-formation-name">{t.name}</span>
                        <span className="stats-formation-id">({t.tier})</span>
                      </div>
                      <span className="stats-formation-count">{t.count.toLocaleString("en-US")} runs</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div style={{ marginTop: 24 }}>
              <Link to="/holders" className="btn btn-outline" style={{ display: "inline-flex" }}>
                Explore Holder Tiers &amp; Quotas →
              </Link>
            </div>
          </section>

          {/* Burns Section */}
          <section className="stats-section">
            <div className="stats-section-head">
              <h2>Onchain Token Burns</h2>
              <span className="stats-updated">
                Updated {formatRelativeTime(data.burns.updated_at)}
              </span>
            </div>

            <div className="stats-grid-4">
              <div className="stats-card">
                <span className="stats-card-label">Total Burned</span>
                <span
                  className="stats-card-num"
                  title={exactAmount(data.burns.total_tokens_burned_raw, data.burns.decimals)}
                >
                  {compactAmount(data.burns.total_tokens_burned_raw, data.burns.decimals)}
                </span>
                <span className="stats-card-sub">GATTAI tokens burned permanently</span>
              </div>

              <div className="stats-card">
                <span className="stats-card-label">Team Burns</span>
                <span
                  className="stats-card-num"
                  title={exactAmount(data.burns.team_tokens_burned_raw, data.burns.decimals)}
                >
                  {compactAmount(data.burns.team_tokens_burned_raw, data.burns.decimals)}
                </span>
                <span className="stats-card-sub">Onchain team allocations</span>
              </div>

              <div className="stats-card">
                <span className="stats-card-label">Epoch Buybacks</span>
                <span
                  className="stats-card-num"
                  title={exactAmount(data.burns.epoch_tokens_burned_raw, data.burns.decimals)}
                >
                  {compactAmount(data.burns.epoch_tokens_burned_raw, data.burns.decimals)}
                </span>
                <span className="stats-card-sub">From revenue margin</span>
                {Number(data.burns.epoch_tokens_burned) === 0 && (
                  <div className="stats-honest-note">First revenue epoch pending.</div>
                )}
              </div>

              <div className="stats-card">
                <span className="stats-card-label">Community Burns</span>
                <span
                  className="stats-card-num"
                  title={exactAmount(data.burns.community_tokens_burned_raw, data.burns.decimals)}
                >
                  {compactAmount(data.burns.community_tokens_burned_raw, data.burns.decimals)}
                </span>
                <span className="stats-card-sub">Voluntary transfers to dead</span>
              </div>
            </div>

            {/* Daily Burn Chart if burns exist */}
            {burnDailyPoints.length > 0 && (
              <div className="stats-chart-card">
                <div className="stats-chart-head">
                  <span className="stats-chart-title">Token Burn History</span>
                  <span className="stats-chart-meta">Indexed Events</span>
                </div>
                <SimpleLineChart
                  points={burnDailyPoints}
                  unit="GATTAI"
                  formatValue={(v) => compactAmount(v.toString(), 0)}
                  color="#ff5b1f"
                />
              </div>
            )}

            <div style={{ marginTop: 24 }}>
              <Link to="/burns" className="btn btn-outline" style={{ display: "inline-flex" }}>
                View Full Burn Dashboard &amp; Verification →
              </Link>
            </div>
          </section>
        </>
      )}
    </main>
  );
}
