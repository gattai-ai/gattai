import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { api } from "@/lib/api";
import {
  amount2,
  compactAmount,
  compactNumber,
  exactAmount,
  fmtPercent,
  toTokenNumber,
} from "@/lib/burn-format";
import { explorerAddressUrl, explorerTxUrl, shortAddress } from "@/lib/explorer";
import { useDocumentMeta, useSiteReveal } from "@/site/useSite";
import type { BurnEpoch, BurnKind, BurnsResponse } from "@/lib/types";
import "../burns.css";

/**
 * Burn dashboard.
 *
 * Angka utama berasal dari indexer onchain (`token_burns`): total, team,
 * epoch, dan community. Backend mengirim base-unit integer string; halaman ini
 * yang membulatkan untuk tampilan dan menyediakan angka exact di tooltip.
 */

function fmtDate(value: string | null): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function fmtDateTime(value: string | null): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtAxis(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(0)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(0)}K`;
  return String(Math.round(value));
}

function kindLabel(kind: BurnKind): string {
  if (kind === "team") return "Team";
  if (kind === "epoch") return "Epoch";
  return "Community";
}

function kindClass(kind: BurnKind): string {
  if (kind === "team") return "acc";
  if (kind === "epoch") return "ok";
  return "dim";
}

function epochLengthMs(epochs: BurnEpoch[]): number | null {
  if (epochs.length === 0) return null;
  const last = epochs[epochs.length - 1];
  const length = new Date(last.period_end).getTime() - new Date(last.period_start).getTime();
  return Number.isFinite(length) && length > 0 ? length : null;
}

function nextCloseMs(epochs: BurnEpoch[]): number {
  const now = Date.now();
  const length = epochLengthMs(epochs);
  if (epochs.length > 0 && length) {
    const lastEnd = new Date(epochs[epochs.length - 1].period_end).getTime();
    if (Number.isFinite(lastEnd)) {
      let next = lastEnd;
      while (next <= now) next += length;
      return next;
    }
  }
  // Fallback: Senin 00:00 UTC berikutnya (seperti situs statis).
  const date = new Date();
  const next = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  next.setUTCDate(next.getUTCDate() + ((8 - next.getUTCDay()) % 7 || 7));
  return next.getTime();
}

function useCountdown(targetMs: number | null): { d: number; h: string; m: string; s: string } {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  if (targetMs == null) return { d: 0, h: "00", m: "00", s: "00" };
  let diff = Math.max(0, Math.floor((targetMs - now) / 1000));
  const d = Math.floor(diff / 86400);
  diff %= 86400;
  const h = String(Math.floor(diff / 3600)).padStart(2, "0");
  diff %= 3600;
  const m = String(Math.floor(diff / 60)).padStart(2, "0");
  const s = String(diff % 60).padStart(2, "0");
  return { d, h, m, s };
}

function statusClass(status: string): string {
  if (status === "executed") return "ok";
  if (status === "pending") return "acc";
  if (status === "failed") return "bad";
  return "dim";
}

interface ChartTip {
  x: number;
  y: number;
  title: string;
  lines: string[];
}

export function BurnsPage() {
  useSiteReveal();

  const { data, isError } = useQuery({
    queryKey: ["burns"],
    queryFn: () => api<BurnsResponse>("/v1/public/burns"),
    staleTime: 60_000,
    refetchInterval: 60_000,
  });

  const decimals = data?.token?.decimals ?? 18;
  const symbol = data?.token?.symbol ?? "GATTAI";
  const burns = useMemo(() => {
    const list = [...(data?.burns ?? [])];
    list.sort((a, b) => b.block_number - a.block_number || b.log_index - a.log_index);
    return list;
  }, [data]);
  const epochs = useMemo(() => {
    const list = [...(data?.epochs ?? [])];
    list.sort((a, b) => a.period_start.localeCompare(b.period_start));
    return list;
  }, [data]);

  const totalRaw = data?.total_tokens_burned_raw ?? "0";
  const teamRaw = data?.team_tokens_burned_raw ?? "0";
  const epochRaw = data?.epoch_tokens_burned_raw ?? "0";
  const communityRaw = data?.community_tokens_burned_raw ?? "0";
  const total = toTokenNumber(totalRaw, decimals);
  const percent = data?.burned_percent ?? "0";
  const counts = data?.burn_counts ?? { team: 0, epoch: 0, community: 0 };
  const totalEvents = counts.team + counts.epoch + counts.community;
  const tokenAddress = data?.token?.address ?? null;
  const totalSupply = data?.token
    ? compactAmount(data.token.total_supply_raw, data.token.decimals)
    : "1B";

  useDocumentMeta({
    title: data
      ? `GATTAI Burns — ${compactAmount(totalRaw, decimals)} $GATTAI burned`
      : "GATTAI Burns — Onchain burn dashboard",
    description:
      "Onchain burn dashboard for $GATTAI: team burns, epoch buybacks, and community burns settled on Robinhood Chain. Every amount links to its transaction.",
    image: "https://www.gattai.tech/logo_gattai.png",
    url: "https://www.gattai.tech/burns",
  });

  const target = useMemo(() => (data ? nextCloseMs(epochs) : null), [data, epochs]);
  const countdown = useCountdown(target);

  // Animasi angka hero menuju total nyata (token unit).
  const [displayTotal, setDisplayTotal] = useState(0);
  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      setDisplayTotal(total);
      return;
    }
    const start = performance.now();
    const duration = 1800;
    let frame = 0;
    const step = (now: number) => {
      const progress = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - progress, 4);
      setDisplayTotal(total * eased);
      if (progress < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [total]);

  const [tip, setTip] = useState<ChartTip | null>(null);

  const chartBurns = useMemo(() => {
    const list = [...burns];
    list.sort((a, b) => a.block_number - b.block_number || a.log_index - b.log_index);
    return list;
  }, [burns]);

  const chart = useMemo(() => {
    const W = 1000;
    const H = 320;
    const L = 64;
    const B = 34;
    const T = 10;
    const values = chartBurns.map((burn) => toTokenNumber(burn.amount_raw, burn.decimals ?? decimals));
    const rawMax = Math.max(...values, 1);
    const step = rawMax >= 1_000_000 ? 1_000_000 : 1_000;
    const max = Math.ceil(rawMax / step) * step;
    const slot = (W - L) / Math.max(1, chartBurns.length);
    const bw = Math.min(slot * 0.64, 180);
    const grid = Array.from({ length: 5 }, (_, index) => H - B - (index / 4) * (H - B - T));
    return { W, H, L, B, T, max, bw, slot, grid, values };
  }, [chartBurns, decimals]);

  // Kalkulator edukasi (parameter launch dari brief).
  const [pay, setPay] = useState<"stable" | "gattai">("stable");
  const [list, setList] = useState(100);
  const [prov, setProv] = useState(65);
  const paid = pay === "gattai" ? list * 0.85 : list;
  const share = pay === "gattai" ? 0.5 : 0.3;
  const margin = Math.max(0, paid - prov);
  const burnAmount = margin * share;
  const treasury = margin - burnAmount;
  const money = (n: number) => `$${n.toFixed(2)}`;

  return (
    <>
      <header className="phead">
        <div className="wrap">
          <div className="bhero">
            <div>
              <span className="eyebrow" data-r>
                Buyback &amp; burn
              </span>
              <div className="bigN" data-r="2">
                <span id="totalN" title={exactAmount(totalRaw, decimals)}>
                  {compactNumber(displayTotal)}
                </span>
                <small>
                  <span className="flame"></span>${symbol} BURNED ONCHAIN · {fmtPercent(percent)} OF SUPPLY
                </small>
              </div>
            </div>
            <div className="next" data-r="3">
              <h4
                className="mono"
                style={{ fontWeight: 500, fontSize: 11, letterSpacing: ".16em", color: "var(--muted)" }}
              >
                NEXT EPOCH CLOSES IN
              </h4>
              <div className="cd">
                <div>
                  <b id="cdD">{countdown.d}</b>
                  <span>DAYS</span>
                </div>
                <div>
                  <b id="cdH">{countdown.h}</b>
                  <span>HRS</span>
                </div>
                <div>
                  <b id="cdM">{countdown.m}</b>
                  <span>MIN</span>
                </div>
                <div>
                  <b id="cdS">{countdown.s}</b>
                  <span>SEC</span>
                </div>
              </div>
              <p>
                Epoch length, burn shares and discount are config values; changes are announced publicly.
              </p>
            </div>
          </div>
        </div>
        <div className="jpbg" aria-hidden="true">
          燃
        </div>
      </header>

      <section className="wrap">
        {isError && (
          <p className="muted" style={{ marginTop: 24 }}>
            Burn data is temporarily unavailable. The indexer keeps retrying; try again in a minute.
          </p>
        )}

        <div className="stats">
          <div className="stat" data-r>
            <small>Total burned</small>
            <b title={exactAmount(totalRaw, decimals)}>{compactAmount(totalRaw, decimals)}</b>
            <span>
              {fmtPercent(percent)} of {totalSupply} supply
            </span>
          </div>
          <div className="stat" data-r="2">
            <small>Team burns</small>
            <b title={exactAmount(teamRaw, decimals)}>{compactAmount(teamRaw, decimals)}</b>
            <span>
              {counts.team} transfer{counts.team === 1 ? "" : "s"} from treasury
            </span>
          </div>
          <div className="stat" data-r="3">
            <small>Epoch burns</small>
            <b title={exactAmount(epochRaw, decimals)}>{compactAmount(epochRaw, decimals)}</b>
            <span>
              {counts.epoch} buyback burn{counts.epoch === 1 ? "" : "s"}
            </span>
          </div>
          <div className="stat" data-r="4">
            <small>Community burns</small>
            <b title={exactAmount(communityRaw, decimals)}>{compactAmount(communityRaw, decimals)}</b>
            <span>
              {counts.community} external transfer{counts.community === 1 ? "" : "s"}
            </span>
          </div>
        </div>

        <div className="box chartbox" data-r>
          <div className="hd">
            <h4>Burn events</h4>
            <div className="legend">
              <span>
                <i style={{ background: "var(--acc)" }}></i>${symbol} burned
              </span>
            </div>
          </div>
          <svg id="chart" viewBox="0 0 1000 320" role="img" aria-label={`Bar chart of ${symbol} burn events`}>
            {chart.grid.map((yy, index) => {
              const value = (index / 4) * chart.max;
              return (
                <g key={index}>
                  <line className="gl" x1={chart.L} x2={chart.W} y1={yy} y2={yy} />
                  <text className="ax" x={chart.L - 10} y={Number(yy) + 3} textAnchor="end">
                    {fmtAxis(value)}
                  </text>
                </g>
              );
            })}
            {chartBurns.map((burn, index) => {
              const value = chart.values[index];
              const x = chart.L + index * chart.slot + (chart.slot - chart.bw) / 2;
              const height = (value / chart.max) * (chart.H - chart.B - chart.T);
              const last = index === chartBurns.length - 1;
              return (
                <g
                  key={burn.id}
                  className="bar"
                  onPointerMove={(event) => {
                    setTip({
                      x: Math.min(event.clientX + 14, window.innerWidth - 240),
                      y: event.clientY + 14,
                      title: `${kindLabel(burn.kind)} burn`,
                      lines: [
                        fmtDateTime(burn.block_timestamp ?? burn.created_at),
                        `${amount2(burn.amount_raw, burn.decimals ?? decimals)} ${symbol}`,
                        shortAddress(burn.tx_hash, 8),
                      ],
                    });
                  }}
                  onPointerLeave={() => setTip(null)}
                >
                  <rect
                    x={x}
                    y={chart.H - chart.B - height}
                    width={chart.bw}
                    height={Math.max(height, 2)}
                    rx="2"
                    fill={last ? "#ff8a4c" : "#ff5b1f"}
                  >
                    <animate
                      attributeName="height"
                      from="0"
                      to={Math.max(height, 2)}
                      dur=".9s"
                      begin={`${0.3 + index * 0.05}s`}
                      fill="freeze"
                    />
                    <animate
                      attributeName="y"
                      from={chart.H - chart.B}
                      to={chart.H - chart.B - height}
                      dur=".9s"
                      begin={`${0.3 + index * 0.05}s`}
                      fill="freeze"
                    />
                  </rect>
                  <rect
                    x={chart.L + index * chart.slot}
                    y={chart.T}
                    width={chart.slot}
                    height={chart.H - chart.B - chart.T}
                    fill="transparent"
                  />
                  <text className="ax" x={x + chart.bw / 2} y={chart.H - 12} textAnchor="middle">
                    #{index + 1}
                  </text>
                </g>
              );
            })}
          </svg>
          {chartBurns.length === 0 && (
            <p className="muted" style={{ fontSize: 13.5, marginTop: 8 }}>
              No burns indexed yet. The chart fills in as transfer events are confirmed.
            </p>
          )}
        </div>

        <div className="box" style={{ marginTop: 14, paddingBottom: 6 }} data-r>
          <div className="hd" style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
            <h4>Burn history</h4>
            <span className="muted" style={{ font: "500 11px var(--mono)" }}>
              {burns.length < totalEvents
                ? `Showing latest ${burns.length} of ${totalEvents} events`
                : `${totalEvents} indexed event${totalEvents === 1 ? "" : "s"}`}
            </span>
          </div>
          <div className="tscroll" style={{ marginTop: 12 }}>
            <table className="tbl burn-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Type</th>
                  <th className="num">Amount</th>
                  <th>Transaction</th>
                </tr>
              </thead>
              <tbody>
                {burns.map((burn) => (
                  <tr key={burn.id}>
                    <td className="m" data-label="Date">
                      {fmtDateTime(burn.block_timestamp ?? burn.created_at)}
                    </td>
                    <td data-label="Type">
                      <span className={`st ${kindClass(burn.kind)}`}>{kindLabel(burn.kind)}</span>
                    </td>
                    <td
                      className="num m"
                      data-label="Amount"
                      title={exactAmount(burn.amount_raw, burn.decimals ?? decimals)}
                    >
                      {amount2(burn.amount_raw, burn.decimals ?? decimals)}
                    </td>
                    <td className="m" data-label="Transaction">
                      <a
                        className="tx"
                        href={explorerTxUrl(burn.tx_hash)}
                        target="_blank"
                        rel="noreferrer"
                        title={burn.tx_hash}
                      >
                        {shortAddress(burn.tx_hash, 6)}
                      </a>
                    </td>
                  </tr>
                ))}
                {burns.length === 0 && (
                  <tr>
                    <td colSpan={4} className="muted">
                      No burns indexed yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {epochs.length > 0 && (
          <div className="box" style={{ marginTop: 14, paddingBottom: 6 }} data-r>
            <h4>Epoch log</h4>
            <div className="tscroll" style={{ marginTop: 12 }}>
              <table className="tbl burn-table">
                <thead>
                  <tr>
                    <th>Epoch</th>
                    <th>Period</th>
                    <th className="num">Budget (USD)</th>
                    <th className="num">Burned</th>
                    <th>Transactions</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {[...epochs].reverse().map((epoch, reverseIndex) => (
                    <tr key={epoch.id}>
                      <td className="m" data-label="Epoch">
                        #{epochs.length - reverseIndex}
                      </td>
                      <td className="m" data-label="Period">
                        {fmtDate(epoch.period_start)} – {fmtDate(epoch.period_end)}
                      </td>
                      <td className="num m" data-label="Budget (USD)">
                        ${Number(epoch.budget_usd || 0).toLocaleString("en-US", { maximumFractionDigits: 2 })}
                      </td>
                      <td className="num m" data-label="Burned">
                        {Number(epoch.tokens_burned || 0).toLocaleString("en-US", {
                          maximumFractionDigits: 2,
                        })}
                      </td>
                      <td className="m" data-label="Transactions">
                        {epoch.tx_hashes.length === 0
                          ? "-"
                          : epoch.tx_hashes.map((hash) => (
                              <a
                                key={hash}
                                className="tx"
                                href={explorerTxUrl(hash)}
                                target="_blank"
                                rel="noreferrer"
                                title={hash}
                              >
                                {shortAddress(hash, 4)}{" "}
                              </a>
                            ))}
                      </td>
                      <td data-label="Status">
                        <span className={`st ${statusClass(epoch.status)}`}>{epoch.status.toUpperCase()}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <div className="calc">
          <div className="box" data-r>
            <h4>Burn calculator</h4>
            <p className="muted" style={{ fontSize: 14, marginTop: 10 }}>
              See how one settled run feeds the burn. Uses the launch parameters from the brief.
            </p>
            <div className="fields">
              <div className="field">
                <label>Paid with</label>
                <div className="seg" id="paySeg">
                  <button className={pay === "stable" ? "on" : undefined} onClick={() => setPay("stable")}>
                    ETH / USDG
                  </button>
                  <button className={pay === "gattai" ? "on" : undefined} onClick={() => setPay("gattai")}>
                    ${symbol}
                  </button>
                </div>
              </div>
              <div className="field">
                <label htmlFor="list">List price of usage (USD)</label>
                <input
                  className="inp"
                  id="list"
                  type="number"
                  value={list}
                  min={0}
                  step={1}
                  onChange={(event) => setList(Math.max(0, Number(event.target.value) || 0))}
                />
              </div>
              <div className="field">
                <label htmlFor="prov">Provider cost (USD)</label>
                <input
                  className="inp"
                  id="prov"
                  type="number"
                  value={prov}
                  min={0}
                  step={1}
                  onChange={(event) => setProv(Math.max(0, Number(event.target.value) || 0))}
                />
              </div>
            </div>
          </div>
          <div className="box res" data-r="2">
            <h4>Where the money goes</h4>
            <div className="flowbar">
              <div className="p" id="fbP" style={{ flexGrow: Math.min(prov, paid) / Math.max(paid, 0.0001) }}>
                {prov / Math.max(paid, 0.0001) > 0.15 ? "PROVIDERS" : ""}
              </div>
              <div className="b" id="fbB" style={{ flexGrow: burnAmount / Math.max(paid, 0.0001) }}>
                {burnAmount / Math.max(paid, 0.0001) > 0.1
                  ? `BURN ${Math.round((burnAmount / Math.max(paid, 0.0001)) * 100)}%`
                  : ""}
              </div>
              <div className="t" id="fbT" style={{ flexGrow: treasury / Math.max(paid, 0.0001) }}>
                {treasury / Math.max(paid, 0.0001) > 0.12 ? "TREASURY" : ""}
              </div>
            </div>
            <div className="rows">
              <div>
                <span>You pay</span>
                <b id="rPay">
                  {money(paid)}
                  {pay === "gattai" ? ` in $${symbol}` : ""}
                </b>
              </div>
              <div>
                <span>Provider cost</span>
                <b id="rProv">{money(Math.min(prov, paid))}</b>
              </div>
              <div>
                <span>Margin</span>
                <b id="rMar">{money(margin)}</b>
              </div>
              <div>
                <span>Burn share</span>
                <b id="rShare">{Math.round(share * 100)}%</b>
              </div>
              <div className="hl">
                <span>Burned (est.)</span>
                <b id="rBurn">{money(burnAmount)}</b>
              </div>
              <div>
                <span>Treasury</span>
                <b id="rTre">{money(treasury)}</b>
              </div>
            </div>
            <p className="muted" style={{ fontSize: 12.5, marginTop: 12 }} id="rNote">
              {paid < prov
                ? "Provider cost exceeds what was paid, no margin, nothing to burn."
                : pay === "gattai"
                  ? `Burned directly from treasury $${symbol}, no buyback needed. $${symbol} needed for provider costs is sold gradually.`
                  : `Executed as a buyback of $${symbol} on the pool, split into small transactions, then burned.`}
            </p>
          </div>
        </div>

        <div className="verify" id="contract">
          <div className="box" data-r>
            <span className="n">01</span>
            <h3>Check the contract</h3>
            <p>Fixed supply, no mint function, ownership renounced.</p>
            <p className="mono" style={{ color: "var(--text)", wordBreak: "break-all" }}>
              {tokenAddress ? (
                <a
                  href={explorerAddressUrl(tokenAddress)}
                  target="_blank"
                  rel="noreferrer"
                  title={tokenAddress}
                  style={{ color: "var(--acc2)" }}
                >
                  {shortAddress(tokenAddress, 10)}
                </a>
              ) : (
                "CA · TBA"
              )}
            </p>
          </div>
          <div className="box" data-r="2">
            <span className="n">02</span>
            <h3>Follow the tx hashes</h3>
            <p>
              Every burn lists its transaction. Each one is an ERC-20 <code className="mono">Transfer</code> to{" "}
              <code className="mono">0x…dEaD</code>.
            </p>
          </div>
          <div className="box" data-r="3">
            <span className="n">03</span>
            <h3>Pull the raw data</h3>
            <p>
              The same numbers are served unauthenticated at{" "}
              <code className="mono">/v1/public/burns</code>. See the{" "}
              <Link to="/docs#burns" style={{ color: "var(--acc)" }}>
                docs
              </Link>
              .
            </p>
          </div>
        </div>
      </section>

      {tip && (
        <div className="tip" style={{ opacity: 1, left: tip.x, top: tip.y }}>
          <b>{tip.title}</b>
          {tip.lines.map((line, index) => (
            <span key={index} style={{ display: "block" }}>
              {line}
            </span>
          ))}
        </div>
      )}
    </>
  );
}
