import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useConnection, useConnect, useConnectors } from "wagmi";
import { Link } from "@/lib/router";
import { api } from "@/lib/api";
import { formatShortDateTime } from "@/lib/format";
import { useLogin, useSession } from "@/lib/use-session";
import { useDocumentMeta } from "@/site/useSite";
import type {
  HolderPublicTiersResponse,
  HolderStatusResponse,
} from "@/lib/types";
import "../holders.css";

const PONS_DEX_URL =
  "https://robinhoodchain.blockscout.com/token/0x863019e2e676164fcfaab6e14dcd6568eb6deb1f";

function formatTokenDisplay(val: string | number): string {
  const num = typeof val === "string" ? parseFloat(val) : val;
  if (isNaN(num)) return "-";
  return num.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function useUtcCountdown(targetIso: string | null): string {
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    if (!targetIso) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [targetIso]);

  if (!targetIso) return "--:--:--";
  const end = new Date(targetIso).getTime();
  const diffMs = Math.max(0, end - now);
  const totalSeconds = Math.floor(diffMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${String(hours).padStart(2, "0")}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
}

export function HoldersPage() {
  useDocumentMeta({
    title: "GATTAI: Holder Tiers",
    description:
      "Hold $GATTAI to use AI formations for free with stake-free onchain snapshot verification.",
    image: "https://www.gattai.tech/logo_gattai.png",
    url: "https://www.gattai.tech/holders",
  });

  const { session } = useSession();
  const isAuthenticated = Boolean(session?.projectId);

  const { isConnected } = useConnection();
  const { mutate: connect, isPending: isConnecting } = useConnect();
  const connectors = useConnectors();
  const { login, isPending: isLoggingIn } = useLogin();

  // 1. Definisi tiers publik (selalu diambil untuk panduan)
  const publicTiersQuery = useQuery({
    queryKey: ["public", "holder", "tiers"],
    queryFn: () => api<HolderPublicTiersResponse>("/v1/public/holder/tiers"),
    staleTime: 60_000,
  });

  // 2. Status holder pribadi (hanya diambil bila user sudah login)
  const statusQuery = useQuery({
    queryKey: ["holder", "status"],
    queryFn: () => api<HolderStatusResponse>("/v1/holder/status"),
    enabled: isAuthenticated,
    refetchInterval: 15_000,
  });

  const tiersData = publicTiersQuery.data?.tiers ?? [];
  const status = statusQuery.data;

  // Countdown reset ke 00:00 UTC
  const resetTarget = status?.free_runs?.resets_at ?? null;
  const countdownText = useUtcCountdown(resetTarget);

  function handleConnect() {
    if (!isConnected) {
      const connector = connectors[0];
      if (connector) connect({ connector });
    } else {
      void login();
    }
  }

  const activeTierId = status?.tier?.id ?? null;

  return (
    <main className="holders-page">
      {/* ── Hero Section ──────────────────────────────────────────────────── */}
      <section className="holders-hero">
        <span className="holders-eyebrow">Utility Protocol</span>
        <h1 className="holders-title">Hold $GATTAI. Use AI for free.</h1>
        <p className="holders-subtitle">
          Stake-free tier quotas powered by Robinhood Chain token holding snapshots.
          No locking, no contracts, no yield claims. Pure AI compute platform utility.
        </p>

        {!isAuthenticated && (
          <div className="holders-cta-bar">
            <button
              type="button"
              className="btn btn-light"
              disabled={isConnecting || isLoggingIn}
              onClick={handleConnect}
            >
              {isConnecting
                ? "Connecting…"
                : isLoggingIn
                  ? "Signing in…"
                  : !isConnected
                    ? "Connect wallet"
                    : "Sign in with Ethereum"}
            </button>
            <a
              href={PONS_DEX_URL}
              target="_blank"
              rel="noreferrer"
              className="btn btn-dark"
            >
              Get $GATTAI on Pons ↗
            </a>
          </div>
        )}
      </section>

      {/* ── Special State Banners (Authenticated) ─────────────────────────── */}
      {isAuthenticated && status?.kill_switch && (
        <div className="holders-banner pause" role="alert">
          <span>⚠️</span>
          <span>
            <strong>Holder runs are paused.</strong> Tier holding data is displayed normally,
            but new runs will use standard billing until platform maintenance concludes.
          </span>
        </div>
      )}

      {isAuthenticated && status?.budget?.exhausted && (
        <div className="holders-banner warning" role="alert">
          <span>⏳</span>
          <span>
            <strong>Today's platform holder budget is used up.</strong> Resets in{" "}
            {countdownText} (00:00 UTC).
          </span>
        </div>
      )}

      {isAuthenticated && status?.snapshot_status === "unavailable" && (
        <div className="holders-banner warning" role="alert">
          <span>📡</span>
          <span>
            <strong>Snapshot service is temporarily unavailable.</strong> Your tier and quota
            will update after the next successful wallet scan. Nothing is wrong with your
            holdings.
          </span>
        </div>
      )}

      {isAuthenticated && status?.snapshot_status === "stale" && (
        <div className="holders-banner warning" role="alert">
          <span>🕒</span>
          <span>
            <strong>Your holder snapshot is older than expected.</strong> Tier data may be
            delayed until the next snapshot cycle completes.
          </span>
        </div>
      )}

      {isAuthenticated && status?.pending?.message && (
        <div className="holders-banner pending">
          <span>⚡</span>
          <span>
            <strong>Holding detected:</strong> {status.pending.message}
          </span>
        </div>
      )}

      {/* ── Authenticated User Dashboard Cards ─────────────────────────────── */}
      {isAuthenticated && (
        <div className="holders-grid">
          {/* Card 1: Tier & Free Runs Quota */}
          <div className="holders-card">
            <div>
              <div className="holders-card-head">
                <span className="holders-card-label">Current Tier</span>
                <span className={`tier-badge ${status?.tier?.badge ?? "none"}`}>
                  {status?.tier?.badge ?? "Unranked"}
                </span>
              </div>
              <h3 className="holders-tier-name">{status?.tier?.name ?? "No tier yet"}</h3>
              <div className="holders-quota-stat">
                {status ? status.free_runs.remaining : "-"}{" "}
                <small>/ {status ? status.free_runs.limit : 0} runs left today</small>
              </div>
              {status && status.free_runs.media_limit > 0 && (
                <p className="holders-progress-copy">
                  Media runs: {status.free_runs.media_remaining} of{" "}
                  {status.free_runs.media_limit} left today
                </p>
              )}
            </div>
            <div className="holders-countdown-wrap">
              <span>Resets in:</span>
              <strong>{countdownText} (00:00 UTC)</strong>
            </div>
          </div>

          {/* Card 2: 24h Snapshot Balance */}
          <div className="holders-card">
            <div>
              <div className="holders-card-head">
                <span className="holders-card-label">Verified Snapshot</span>
                {status?.snapshot && (
                  <span className="holders-card-label">
                    Block #{status.snapshot.block_number}
                  </span>
                )}
              </div>
              <div className="holders-snapshot-bal">
                {status?.snapshot
                  ? `${formatTokenDisplay(status.snapshot.balance)} $GATTAI`
                  : statusQuery.isLoading
                    ? "Loading…"
                    : status?.snapshot_status === "unavailable"
                      ? "Snapshot data temporarily unavailable"
                      : "Waiting for first snapshot"}
              </div>
              <div className="holders-snapshot-meta">
                {status?.snapshot ? (
                  <>
                    <span>
                      Snapshot time: {formatShortDateTime(status.snapshot.taken_at)}
                    </span>
                    <a
                      href={status.snapshot.explorer_url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      View on Blockscout ↗
                    </a>
                  </>
                ) : status?.snapshot_status === "unavailable" ? (
                  <span>We could not reach the snapshot service. We will retry automatically.</span>
                ) : (
                  <span>Snapshot balance will record upon your first wallet scan.</span>
                )}
              </div>
            </div>
            <div className="holders-rule-note">
              Tier qualification requires maintaining balance across two consecutive snapshots.
            </div>
          </div>

          {/* Card 3: Next Tier Progress */}
          <div className="holders-card">
            <div>
              <div className="holders-card-head">
                <span className="holders-card-label">Milestone Progress</span>
                {status?.next_tier && (
                  <span className="holders-card-label">
                    {status.next_tier.progress_pct}%
                  </span>
                )}
              </div>
              {status?.next_tier ? (
                <>
                  <h3 className="holders-tier-name" style={{ fontSize: "20px" }}>
                    Next: {status.next_tier.name}
                  </h3>
                  <div className="holders-progress-bar-wrap">
                    <div
                      className="holders-progress-bar"
                      style={{ width: `${status.next_tier.progress_pct}%` }}
                    />
                  </div>
                  <p className="holders-progress-copy">
                    Hold{" "}
                    <strong>
                      {formatTokenDisplay(status.next_tier.tokens_needed)} more $GATTAI
                    </strong>{" "}
                    to reach {status.next_tier.name}.
                  </p>
                </>
              ) : status?.tier?.id === "admiral" ? (
                <>
                  <h3 className="holders-tier-name" style={{ fontSize: "20px" }}>
                    Maximum Tier Active
                  </h3>
                  <div className="holders-progress-bar-wrap">
                    <div className="holders-progress-bar" style={{ width: "100%" }} />
                  </div>
                  <p className="holders-progress-copy">
                    You have unlocked Fleet Admiral privileges with maximum daily runs.
                  </p>
                </>
              ) : (
                <>
                  <h3 className="holders-tier-name" style={{ fontSize: "20px" }}>
                    Unlock Pilot Tier
                  </h3>
                  <p className="holders-progress-copy">
                    Hold at least 10,000 $GATTAI to unlock 5 daily free text runs.
                  </p>
                </>
              )}
            </div>
            <div style={{ marginTop: "14px" }}>
              <a
                href={PONS_DEX_URL}
                target="_blank"
                rel="noreferrer"
                style={{ fontSize: "12px", color: "#ff5b1f", textDecoration: "none" }}
              >
                Top up $GATTAI on Pons ↗
              </a>
            </div>
          </div>
        </div>
      )}

      {/* ── Tier Comparison Table ─────────────────────────────────────────── */}
      <h2 className="holders-section-title">
        <span>Formation Tiers</span>
      </h2>
      <div className="holders-table-wrap">
        <table className="holders-table">
          <thead>
            <tr>
              <th>Tier</th>
              <th>Holding Required</th>
              <th>Daily Text Runs</th>
              <th>Daily Media Runs</th>
              <th>Benefits & Perks</th>
            </tr>
          </thead>
          <tbody>
            {tiersData.map((t) => {
              const isActive = activeTierId === t.id;
              return (
                <tr key={t.id} className={isActive ? "active-tier-row" : undefined}>
                  <td>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <span className={`tier-badge ${t.badge}`}>{t.badge}</span>
                      <strong>{t.name}</strong>
                      {isActive && <small style={{ color: "#ff5b1f" }}>(Active)</small>}
                    </div>
                  </td>
                  <td>
                    <strong>{formatTokenDisplay(t.min_tokens)}</strong> $GATTAI
                  </td>
                  <td>{t.free_runs_per_day} runs / day</td>
                  <td>{t.free_media_per_day > 0 ? `${t.free_media_per_day} / day` : "-"}</td>
                  <td>
                    <ul className="holders-perk-list">
                      {t.perks.map((p, idx) => (
                        <li key={idx}>{p}</li>
                      ))}
                    </ul>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* ── Today's Activity (Authenticated) ──────────────────────────────── */}
      {isAuthenticated && (
        <>
          <h2 className="holders-section-title">
            <span>Today's Holder Runs</span>
          </h2>
          <div className="holders-table-wrap">
            {status?.today_runs && status.today_runs.length > 0 ? (
              <table className="holders-table">
                <thead>
                  <tr>
                    <th>Formation</th>
                    <th>Time (UTC)</th>
                    <th>Status</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {status.today_runs.map((r) => (
                    <tr key={r.id}>
                      <td>
                        <strong>{r.formation_name}</strong>
                      </td>
                      <td>{formatShortDateTime(r.created_at)}</td>
                      <td>
                        <span className="holders-card-label">{r.status}</span>
                      </td>
                      <td>
                        {r.share_slug ? (
                          <Link to={`/run/${r.share_slug}`} style={{ color: "#ff5b1f" }}>
                            View share ↗
                          </Link>
                        ) : (
                          <Link to="/app/chat" style={{ color: "#c4c9d6" }}>
                            Open app
                          </Link>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="holders-activity-empty">
                No holder runs used today yet. Start creating with your daily quota!
              </div>
            )}
          </div>
        </>
      )}

      {/* ── Protocol Rules Explanation ─────────────────────────────────────── */}
      <section className="holders-protocol-box">
        <h3 style={{ margin: "0 0 8px", fontSize: "16px", color: "#ffffff" }}>
          How the 24-Hour Snapshot Protocol Works
        </h3>
        <p style={{ margin: 0, fontSize: "13px", color: "#8c93a8", lineHeight: "1.6" }}>
          GATTAI holder privileges are verifiable onchain without requiring you to lock or
          transfer your tokens into any contract. You retain 100% self-custody in your own wallet.
        </p>

        <div className="holders-protocol-steps">
          <div className="protocol-step">
            <div className="protocol-step-num">1</div>
            <div>
              <h4>Hold in Wallet</h4>
              <p>Keep $GATTAI in your wallet on Robinhood Chain mainnet.</p>
            </div>
          </div>
          <div className="protocol-step">
            <div className="protocol-step-num">2</div>
            <div>
              <h4>Two Snapshots</h4>
              <p>
                Platform takes periodic snapshots. Tier unlocks after maintaining balance
                over two consecutive scans.
              </p>
            </div>
          </div>
          <div className="protocol-step">
            <div className="protocol-step-num">3</div>
            <div>
              <h4>Daily AI Compute</h4>
              <p>
                Enjoy free AI runs every day. Daily quotas refresh at 00:00 UTC automatically.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ── Bottom CTAs ───────────────────────────────────────────────────── */}
      <div className="holders-cta-bar">
        <Link to="/app/chat" className="btn btn-light">
          Start a free run →
        </Link>
        <a
          href={PONS_DEX_URL}
          target="_blank"
          rel="noreferrer"
          className="btn btn-dark"
        >
          Get $GATTAI on Pons ↗
        </a>
      </div>
    </main>
  );
}
