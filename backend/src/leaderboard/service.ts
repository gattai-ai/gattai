import { createHash } from "node:crypto";
import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { db } from "../db";
import { leaderboardOptOuts, projects, runs } from "../db/schema";
import { leaderboardExcludedWallets } from "./exclusions";
import type { LeaderboardWindow } from "./week";

/** Batas kontribusi satu project per hari UTC. */
export const DAILY_RUN_CAP = 200;
export const LEADERBOARD_LIMIT = 20;

export interface ProjectWeekStat {
  projectId: string;
  displayName: string;
  runs: number;
  optedOut: boolean;
  /** Tim/treasury/kontrak atau project non-aktif. */
  excluded: boolean;
}

/** Baris top-20 publik; tidak membawa project id ke response. */
export interface LeaderboardTopEntry {
  projectId: string;
  displayName: string;
  runs: number;
}

export interface LeaderboardRanking {
  window: LeaderboardWindow;
  /** Hanya project yang eligible, sudah diurutkan. */
  ranked: ProjectWeekStat[];
  /** Semua project yang punya run minggu ini, termasuk opt-out/excluded. */
  stats: ProjectWeekStat[];
  updatedAt: Date;
}

/** Alias publik stabil tanpa membocorkan project id atau wallet. */
export function leaderboardDisplayName(projectId: string): string {
  const hash = createHash("sha256").update(projectId).digest("hex").slice(0, 8);
  return `Project ${hash}`;
}

/**
 * Hitung peringkat satu minggu.
 *
 * Cap dilakukan per hari UTC sebelum dijumlahkan, bukan pada total mingguan:
 * project yang sangat aktif tetap dibatasi 200 run/hari. Query harian sengaja
 * dipisah dari query project agar `least()` hanya dihitung sekali di aplikasi
 * dan mudah diuji tanpa SQL dinamis.
 */
export async function getLeaderboardRanking(
  window: LeaderboardWindow,
): Promise<LeaderboardRanking> {
  const daily = await db
    .select({
      projectId: runs.projectId,
      day: sql<string>`date(${runs.finishedAt} at time zone 'UTC')`.as("day"),
      count: sql<number>`count(*)::int`.as("count"),
    })
    .from(runs)
    .where(
      and(
        eq(runs.status, "SETTLED"),
        gte(runs.finishedAt, window.start),
        lt(runs.finishedAt, window.end),
      ),
    )
    .groupBy(runs.projectId, sql`date(${runs.finishedAt} at time zone 'UTC')`);

  const capped = new Map<string, number>();
  for (const row of daily) {
    const runsToday = Math.min(Number(row.count), DAILY_RUN_CAP);
    capped.set(row.projectId, (capped.get(row.projectId) ?? 0) + runsToday);
  }

  const projectIds = [...capped.keys()];
  let stats: ProjectWeekStat[] = [];
  if (projectIds.length > 0) {
    const excludedWallets = leaderboardExcludedWallets();
    const rows = await db
      .select({
        id: projects.id,
        ownerWallet: projects.ownerWallet,
        status: projects.status,
        optedOut: sql<boolean>`${leaderboardOptOuts.projectId} is not null`.as("opted_out"),
      })
      .from(projects)
      .leftJoin(leaderboardOptOuts, eq(leaderboardOptOuts.projectId, projects.id))
      .where(inArray(projects.id, projectIds));

    stats = rows.map((row) => ({
      projectId: row.id,
      displayName: leaderboardDisplayName(row.id),
      runs: capped.get(row.id) ?? 0,
      optedOut: Boolean(row.optedOut),
      excluded:
        row.status !== "active" || excludedWallets.has(row.ownerWallet.toLowerCase()),
    }));
  }

  // Tie-break memakai `project_id`, bukan hash display. `project_id` sudah
  // deterministik, tidak perlu kolom baru, dan bisa dipakai sama persis oleh
  // query SQL top-20. Hash display tetap hanya untuk nama publik.
  const ranked = stats
    .filter((stat) => !stat.optedOut && !stat.excluded)
    .sort((a, b) => b.runs - a.runs || a.projectId.localeCompare(b.projectId));

  return { window, ranked, stats, updatedAt: new Date() };
}

/**
 * Top-20 publik langsung di SQL.
 *
 * Query penuh tetap dipakai untuk `/v1/leaderboard/me` karena rank user bisa
 * berada di luar top-20. Fungsi ini hanya mengambil 20 baris yang benar-benar
 * tampil, dengan tie-break `project_id` yang sama dengan
 * `getLeaderboardRanking`.
 */
export async function getLeaderboardTop(
  window: LeaderboardWindow,
  limit: number = LEADERBOARD_LIMIT,
): Promise<LeaderboardTopEntry[]> {
  const safeLimit = Number.isFinite(limit)
    ? Math.max(1, Math.min(100, Math.trunc(limit)))
    : LEADERBOARD_LIMIT;
  const excluded = [...leaderboardExcludedWallets()];
  // Alias `p` dipakai di query di bawah; jangan interpolasi `${projects.ownerWallet}`
  // karena Drizzle akan menghasilkan nama tabel asli, bukan alias.
  const excludedClause =
    excluded.length === 0
      ? sql``
      : sql`and lower(p.owner_wallet) not in (${sql.join(
          excluded.map((wallet) => sql`${wallet}`),
          sql`, `,
        )})`;

  const result = await db.execute(sql`
    with daily as (
      select
        ${runs.projectId} as project_id,
        date(${runs.finishedAt} at time zone 'UTC') as day,
        least(count(*), ${DAILY_RUN_CAP})::int as capped
      from ${runs}
      where ${runs.status} = 'SETTLED'
        and ${runs.finishedAt} >= ${window.start}
        and ${runs.finishedAt} < ${window.end}
      group by ${runs.projectId}, date(${runs.finishedAt} at time zone 'UTC')
    ),
    totals as (
      select project_id, sum(capped)::int as runs
      from daily
      group by project_id
    )
    select p.id as id, t.runs as runs
    from totals t
    join ${projects} p on p.id = t.project_id
    left join ${leaderboardOptOuts} o on o.project_id = p.id
    where p.status = 'active'
      and o.project_id is null
      ${excludedClause}
    order by t.runs desc, p.id asc
    limit ${safeLimit}
  `);

  return result.rows.map((row) => {
    const projectId = String(row.id);
    return {
      projectId,
      displayName: leaderboardDisplayName(projectId),
      runs: Number(row.runs),
    };
  });
}

export async function isProjectOptedOut(projectId: string): Promise<boolean> {
  const rows = await db
    .select({ projectId: leaderboardOptOuts.projectId })
    .from(leaderboardOptOuts)
    .where(eq(leaderboardOptOuts.projectId, projectId))
    .limit(1);
  return rows.length > 0;
}

/** Idempotent: insert saat opt-out, delete saat ikut lagi. */
export async function setProjectOptedOut(projectId: string, optedOut: boolean): Promise<void> {
  if (optedOut) {
    await db
      .insert(leaderboardOptOuts)
      .values({ projectId })
      .onConflictDoNothing({ target: leaderboardOptOuts.projectId });
    return;
  }
  await db.delete(leaderboardOptOuts).where(eq(leaderboardOptOuts.projectId, projectId));
}

/** Posisi 1-based di daftar eligible, atau null bila tidak masuk peringkat. */
export function leaderboardRankOf(ranking: LeaderboardRanking, projectId: string): number | null {
  const index = ranking.ranked.findIndex((stat) => stat.projectId === projectId);
  return index === -1 ? null : index + 1;
}

/**
 * Rank untuk halaman "me".
 *
 * Project yang opt-out tidak ada di `ranking.ranked`, tetapi user tetap boleh
 * melihat posisinya sendiri. Rank dihitung terhadap daftar publik + dirinya
 * (project opt-out lain tetap tersembunyi), memakai tie-break yang sama dengan
 * `getLeaderboardRanking`.
 */
export function leaderboardMeRank(ranking: LeaderboardRanking, projectId: string): number | null {
  const stat = ranking.stats.find((entry) => entry.projectId === projectId);
  if (!stat || stat.excluded) return null;
  if (!stat.optedOut) return leaderboardRankOf(ranking, projectId);

  let rank = 1;
  for (const other of ranking.ranked) {
    if (
      other.runs > stat.runs ||
      (other.runs === stat.runs && other.projectId.localeCompare(stat.projectId) < 0)
    ) {
      rank += 1;
    }
  }
  return rank;
}
