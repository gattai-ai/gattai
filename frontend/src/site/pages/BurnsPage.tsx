import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatUnits } from "viem";
import { Link } from "@/lib/router";
import { api } from "@/lib/api";
import { useDocumentTitle, useSiteReveal } from "@/site/useSite";
import type { BurnEpoch, BurnsResponse } from "@/lib/types";
import "../burns.css";

/**
 * Burn dashboard dengan tampilan situs statis. Angka preview diganti data
 * nyata `/v1/public/burns`; kalkulator edukasi dan countdown dipertahankan.
 */

function tokensToNumber(raw: string): number {
  try {
    const value = Number(formatUnits(BigInt(raw), 18));
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

function fmtInt(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function fmtDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
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

export function BurnsPage() {
  useDocumentTitle("GATTAI Burns");
  useSiteReveal();

  const { data } = useQuery({
    queryKey: ["burns"],
    queryFn: () => api<BurnsResponse>("/v1/public/burns"),
    refetchInterval: 20_000,
  });

  const epochs = useMemo(() => {
    const list = [...(data?.epochs ?? [])];
    list.sort((a, b) => a.period_start.localeCompare(b.period_start));
    return list;
  }, [data]);

  const total = data ? tokensToNumber(data.total_tokens_burned) : 0;
  const executed = epochs.filter((epoch) => epoch.status === "executed");
  const lastExecuted = executed[executed.length - 1];
  const pending = epochs.filter((epoch) => epoch.status === "pending").length;
  const totalBudget = epochs.reduce((sum, epoch) => sum + (Number(epoch.budget_usd) || 0), 0);

  const target = useMemo(() => (data ? nextCloseMs(epochs) : null), [data, epochs]);
  const countdown = useCountdown(target);

  // Animasi angka hero menuju total nyata.
  const [displayTotal, setDisplayTotal] = useState(0);
  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      setDisplayTotal(total);
      return;
    }
    const from = 0;
    const start = performance.now();
    const duration = 2200;
    let frame = 0;
    const step = (now: number) => {
      const progress = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - progress, 4);
      setDisplayTotal(from + (total - from) * eased);
      if (progress < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [total]);

  // Tooltip chart.
  const [tip, setTip] = useState<{ x: number; y: number; html: string } | null>(null);

  const chart = useMemo(() => {
    const W = 1000;
    const H = 320;
    const L = 56;
    const B = 34;
    const T = 10;
    const values = epochs.map((epoch) => tokensToNumber(epoch.tokens_burned));
    const max = values.length > 0 ? Math.ceil(Math.max(...values, 1) / 20000) * 20000 : 20000;
    const bw = (W - L) / Math.max(1, epochs.length);
    const grid: string[] = [];
    for (let y = 0; y <= max; y += max / 4) {
      const yy = H - B - (y / max) * (H - B - T);
      grid.push(yy.toFixed(1));
    }
    return { W, H, L, B, T, max, bw, grid, values };
  }, [epochs]);

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
                <span id="totalN">{fmtInt(displayTotal)}</span>
                <small>
                  <span className="flame"></span>$GATTAI BURNED FROM REAL USAGE
                </small>
              </div>
            </div>
            <div className="next" data-r="3">
              <h4 className="mono" style={{ fontWeight: 500, fontSize: 11, letterSpacing: ".16em", color: "var(--muted)" }}>
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
        <div className="stats">
          <div className="stat" data-r>
            <small>Epochs settled</small>
            <b id="sEp">{executed.length}</b>
            <span>executed onchain</span>
          </div>
          <div className="stat" data-r="2">
            <small>Last epoch</small>
            <b id="sLast">{lastExecuted ? fmtInt(tokensToNumber(lastExecuted.tokens_burned)) : "0"}</b>
            <span>GATTAI</span>
          </div>
          <div className="stat" data-r="3">
            <small>Total budget</small>
            <b id="sBuy">${fmtInt(totalBudget)}</b>
            <span>across epochs</span>
          </div>
          <div className="stat" data-r="4">
            <small>Pending</small>
            <b id="sDir">{pending}</b>
            <span>epochs awaiting execution</span>
          </div>
        </div>

        <div className="box chartbox" data-r>
          <div className="hd">
            <h4>Burned per epoch</h4>
            <div className="legend">
              <span>
                <i style={{ background: "var(--acc)" }}></i>GATTAI burned
              </span>
            </div>
          </div>
          <svg id="chart" viewBox="0 0 1000 320" role="img" aria-label="Bar chart of GATTAI burned per epoch">
            {chart.grid.map((yy, index) => {
              const y = (index / 4) * chart.max;
              return (
                <g key={index}>
                  <line className="gl" x1={chart.L} x2={chart.W} y1={yy} y2={yy} />
                  <text className="ax" x={chart.L - 10} y={Number(yy) + 3} textAnchor="end">
                    {y >= 1000 ? `${Math.round(y / 1000)}k` : y}
                  </text>
                </g>
              );
            })}
            {epochs.map((epoch, index) => {
              const value = chart.values[index];
              const x = chart.L + index * chart.bw + chart.bw * 0.18;
              const width = chart.bw * 0.64;
              const height = (value / chart.max) * (chart.H - chart.B - chart.T);
              const last = index === epochs.length - 1;
              return (
                <g
                  key={epoch.id}
                  className="bar"
                  onPointerMove={(event) => {
                    setTip({
                      x: Math.min(event.clientX + 14, window.innerWidth - 200),
                      y: event.clientY + 14,
                      html: `<b>Epoch</b><br>${fmtDate(epoch.period_start)} – ${fmtDate(epoch.period_end)}<br>Burned ${fmtInt(value)}<br>Status ${epoch.status}`,
                    });
                  }}
                  onPointerLeave={() => setTip(null)}
                >
                  <rect
                    x={x}
                    y={chart.H - chart.B - height}
                    width={width}
                    height={Math.max(height, 2)}
                    rx="2"
                    fill={last ? "#ff8a4c" : "#ff5b1f"}
                  >
                    <animate attributeName="height" from="0" to={Math.max(height, 2)} dur=".9s" begin={`${0.3 + index * 0.05}s`} fill="freeze" />
                    <animate attributeName="y" from={chart.H - chart.B} to={chart.H - chart.B - height} dur=".9s" begin={`${0.3 + index * 0.05}s`} fill="freeze" />
                  </rect>
                  <rect x={chart.L + index * chart.bw} y={chart.T} width={chart.bw} height={chart.H - chart.B - chart.T} fill="transparent" />
                  <text className="ax" x={x + width / 2} y={chart.H - 12} textAnchor="middle">
                    E{index + 1}
                  </text>
                </g>
              );
            })}
          </svg>
          {epochs.length === 0 && (
            <p className="muted" style={{ fontSize: 13.5, marginTop: 8 }}>
              No epochs recorded yet: the chart fills in as burn epochs settle.
            </p>
          )}
        </div>

        <div className="box" style={{ marginTop: 14, paddingBottom: 6 }} data-r>
          <h4>Epoch log</h4>
          <div className="tscroll" style={{ marginTop: 12 }}>
            <table className="tbl">
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
              <tbody id="eRows">
                {[...epochs].reverse().map((epoch, reverseIndex) => (
                  <tr key={epoch.id}>
                    <td className="m">#{epochs.length - reverseIndex}</td>
                    <td className="m">
                      {fmtDate(epoch.period_start)} – {fmtDate(epoch.period_end)}
                    </td>
                    <td className="num m">${fmtInt(Number(epoch.budget_usd) || 0)}</td>
                    <td className="num m">{fmtInt(tokensToNumber(epoch.tokens_burned))}</td>
                    <td className="m">
                      {epoch.tx_hashes.length === 0
                        ? "-"
                        : epoch.tx_hashes.map((hash) => (
                            <span key={hash} className="tx">
                              0x{hash.slice(2, 6)}…{hash.slice(-4)}{" "}
                            </span>
                          ))}
                    </td>
                    <td>
                      <span className={`st ${statusClass(epoch.status)}`}>{epoch.status.toUpperCase()}</span>
                    </td>
                  </tr>
                ))}
                {epochs.length === 0 && (
                  <tr>
                    <td colSpan={6} className="muted">
                      No epochs yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

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
                    $GATTAI
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
                {burnAmount / Math.max(paid, 0.0001) > 0.1 ? `BURN ${Math.round((burnAmount / Math.max(paid, 0.0001)) * 100)}%` : ""}
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
                  {pay === "gattai" ? " in $GATTAI" : ""}
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
                <span>Burned</span>
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
                  ? "Burned directly from treasury $GATTAI, no buyback needed. $GATTAI needed for provider costs is sold gradually."
                  : "Executed as a buyback of $GATTAI on the pool, split into small transactions, then burned."}
            </p>
          </div>
        </div>

        <div className="verify" id="contract">
          <div className="box" data-r>
            <span className="n">01</span>
            <h3>Check the contract</h3>
            <p>Fixed supply, no mint function, ownership renounced. Address published here at launch.</p>
            <p className="mono" style={{ color: "var(--text)" }}>
              CA · TBA
            </p>
          </div>
          <div className="box" data-r="2">
            <span className="n">02</span>
            <h3>Follow the tx hashes</h3>
            <p>
              Every epoch lists its burn transactions. Each one sends tokens to the burn address or calls{" "}
              <code className="mono">burn()</code>.
            </p>
          </div>
          <div className="box" data-r="3">
            <span className="n">03</span>
            <h3>Pull the raw data</h3>
            <p>
              The same numbers are served unauthenticated at <code className="mono">/v1/public/burns</code>.
              See the <Link to="/docs#burns" style={{ color: "var(--acc)" }}>
                docs
              </Link>
              .
            </p>
          </div>
        </div>
      </section>

      {tip && (
        <div
          className="tip"
          id="tip"
          style={{ opacity: 1, left: tip.x, top: tip.y }}
          dangerouslySetInnerHTML={{ __html: tip.html }}
        ></div>
      )}
    </>
  );
}
