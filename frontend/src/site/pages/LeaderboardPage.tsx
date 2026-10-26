import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { api, ApiError } from "@/lib/api";
import { formatShortDateTime } from "@/lib/format";
import { useSession } from "@/lib/use-session";
import { showToast } from "@/site/siteFx";
import { useDocumentMeta, useSiteReveal } from "@/site/useSite";
import type {
  LeaderboardEntry,
  LeaderboardMeResponse,
  LeaderboardOptOutResponse,
  LeaderboardResponse,
  LeaderboardWeek,
  LeaderboardWeekLabel,
} from "@/lib/types";
import "../leaderboard.css";

function weekLabel(label: LeaderboardWeekLabel): string {
  return label === "previous" ? "Last week" : "This week";
}

function fmtWeekDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function fmtWeekRange(week: LeaderboardWeek): string {
  const start = new Date(week.start);
  const end = new Date(week.end);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return "-";
  return `${fmtWeekDate(week.start)} – ${fmtWeekDate(new Date(end.getTime() - 1).toISOString())}`;
}

function useCountdown(target: string | null): { d: number; h: string; m: string; s: string } {
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    if (!target) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [target]);

  if (!target) return { d: 0, h: "00", m: "00", s: "00" };
  const end = new Date(target).getTime();
  if (!Number.isFinite(end)) return { d: 0, h: "00", m: "00", s: "00" };
  let seconds = Math.max(0, Math.floor((end - now) / 1000));
  const d = Math.floor(seconds / 86_400);
  seconds %= 86_400;
  const h = String(Math.floor(seconds / 3600)).padStart(2, "0");
  seconds %= 3600;
  const m = String(Math.floor(seconds / 60)).padStart(2, "0");
  return { d, h, m, s: String(seconds % 60).padStart(2, "0") };
}

/**
 * Peringkat mingguan publik.
 *
 * Data publik dan data "saya" sengaja dipisah: endpoint publik di-cache 60
 * detik dan tidak boleh berbeda per sesi. Rank pribadi diambil dari endpoint
 * terautentikasi, jadi user tetap bisa melihat posisinya di luar top 20.
 */
export function LeaderboardPage() {
  useSiteReveal();

  const [week, setWeek] = useState<LeaderboardWeekLabel>("current");
  const { session } = useSession();
  const queryClient = useQueryClient();

  const board = useQuery({
    queryKey: ["leaderboard", week],
    queryFn: () => api<LeaderboardResponse>(`/v1/public/leaderboard?week=${week}`),
    staleTime: 60_000,
    refetchInterval: 60_000,
  });

  const me = useQuery({
    queryKey: ["leaderboard-me", week, session?.projectId],
    queryFn: () => api<LeaderboardMeResponse>(`/v1/leaderboard/me?week=${week}`),
    enabled: Boolean(session),
    staleTime: 30_000,
    retry: (count, error) =>
      !(error instanceof ApiError && error.status === 401) && count < 1,
  });

  const optOut = useMutation({
    mutationFn: (next: boolean) =>
      api<LeaderboardOptOutResponse>("/v1/leaderboard/opt-out", {
        method: "POST",
        body: { opted_out: next },
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["leaderboard"] }),
        queryClient.invalidateQueries({ queryKey: ["leaderboard-me"] }),
      ]);
      showToast("Leaderboard preference saved.");
    },
    onError: () => showToast("Could not save your leaderboard preference."),
  });

  const data = board.data;
  const entries = data?.entries ?? [];
  const meData = me.data?.me ?? null;
  const target = week === "current" ? (data?.week.end ?? null) : null;
  const countdown = useCountdown(target);
  const range = data ? fmtWeekRange(data.week) : "";

  useDocumentMeta({
    title: "GATTAI Leaderboard: Weekly builders",
    description:
      "Weekly leaderboard of settled GATTAI runs. See the most active projects, your own rank, and opt out at any time. No wallets exposed.",
    image: "https://www.gattai.tech/og-default.png",
    url: `https://www.gattai.tech/leaderboard?week=${week}`,
  });

  const isMe = (entry: LeaderboardEntry) =>
    meData !== null &&
    meData.rank === entry.rank &&
    meData.display_name === entry.display_name;

  return (
    <main className="lb-page">
      <section className="wrap lb-hero">
        <span className="eyebrow" data-r="1">
          Leaderboard
        </span>
        <h1 className="h1" data-r="2">
          The formation that ships most.
        </h1>
        <p className="lede" data-r="3">
          Weekly ranking of settled runs across GATTAI. One project per row, capped per day,
          and no wallet addresses exposed.
        </p>
        <div className="lb-hero-meta" data-r="4">
          <span className="lb-live-dot" aria-hidden="true" />
          <span>Monday 00:00 UTC reset</span>
          <span className="lb-sep">/</span>
          <span>{range || "Loading week…"}</span>
        </div>
      </section>

      <section className="wrap lb-board">
        <div className="lb-toolbar">
          <div className="lb-tabs" role="tablist" aria-label="Leaderboard week">
            {(["current", "previous"] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={week === value}
                className={`lb-tab${week === value ? " on" : ""}`}
                onClick={() => setWeek(value)}
              >
                {weekLabel(value)}
              </button>
            ))}
          </div>
          <div className="lb-updated">
            {week === "current" ? (
              <>
                <span>Closes in</span>
                <strong>
                  {countdown.d}d {countdown.h}:{countdown.m}:{countdown.s}
                </strong>
              </>
            ) : (
              <span>Final standings</span>
            )}
            {data ? <span className="lb-updated-at">Updated {formatShortDateTime(data.updated_at)}</span> : null}
          </div>
        </div>

        <div className="lb-grid">
          <div className="lb-table-card">
            {board.isPending ? (
              <div className="lb-empty">Loading leaderboard…</div>
            ) : board.isError ? (
              <div className="lb-empty">
                <p>Could not load the leaderboard.</p>
                <button type="button" className="btn btn-dark" onClick={() => void board.refetch()}>
                  Try again
                </button>
              </div>
            ) : entries.length === 0 ? (
              <div className="lb-empty">
                <span className="eyebrow">No runs yet</span>
                <p>No settled runs {week === "previous" ? "last week" : "this week"}. Be the first formation on the board.</p>
                <Link to="/app/chat" className="btn btn-acc">
                  Open the app
                </Link>
              </div>
            ) : (
              <div className="lb-table">
                <div className="lb-row lb-head" aria-hidden="true">
                  <span>#</span>
                  <span>Project</span>
                  <span>Runs</span>
                </div>
                {entries.map((entry) => (
                  <div
                    className={`lb-row${isMe(entry) ? " me" : ""}`}
                    key={`${entry.rank}-${entry.display_name}`}
                  >
                    <span className="lb-rank">{entry.rank}</span>
                    <span className="lb-name">
                      {entry.display_name}
                      {isMe(entry) ? <span className="lb-you">You</span> : null}
                      {isMe(entry) && meData?.tier ? (
                        <span className="lb-entry-tier">{meData.tier.name}</span>
                      ) : null}
                    </span>
                    <span className="lb-runs">{entry.runs.toLocaleString("en-US")}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <aside className="lb-me-card">
            <span className="eyebrow">Your rank</span>
            {!session ? (
              <>
                <p className="lb-me-copy">
                  Sign in to see your position and manage whether you appear on the public
                  leaderboard.
                </p>
                <Link to="/app/chat" className="btn btn-acc">
                  Sign in
                </Link>
              </>
            ) : me.isPending ? (
              <p className="lb-me-copy">Loading your rank…</p>
            ) : me.isError ? (
              <p className="lb-me-copy">Could not load your rank. Try again shortly.</p>
            ) : meData ? (
              <>
                <div className="lb-me-rank">{meData.rank !== null ? `#${meData.rank}` : "-"}</div>
                <p className="lb-me-copy">
                  {meData.runs.toLocaleString("en-US")} settled run
                  {meData.runs === 1 ? "" : "s"} {week === "previous" ? "last week" : "this week"}
                </p>
                {meData.tier ? (
                  <div className={`lb-tier-badge tier-${meData.tier.id}`}>
                    ★ {meData.tier.name}
                  </div>
                ) : null}
                <p className="lb-me-name">{meData.display_name}</p>
                {meData.opted_out ? (
                  <p className="lb-note">
                    You are hidden from the public leaderboard. Your runs still count, and
                    your rank is shown only to you.
                  </p>
                ) : meData.rank === null ? (
                  <p className="lb-note">
                    No public rank {week === "previous" ? "last week" : "this week"}. Only
                    settled runs count; team, treasury, and internal wallets are excluded.
                  </p>
                ) : null}
                <button
                  type="button"
                  className="btn btn-dark"
                  disabled={optOut.isPending}
                  onClick={() => optOut.mutate(!meData.opted_out)}
                >
                  {optOut.isPending
                    ? "Saving…"
                    : meData.opted_out
                      ? "Join leaderboard"
                      : "Opt out"}
                </button>
              </>
            ) : null}
          </aside>
        </div>

        <p className="lb-footnote">
          Only settled runs count. Each project is capped at 200 runs per UTC day. Display
          names are aliases, never wallets.
        </p>
      </section>
    </main>
  );
}
