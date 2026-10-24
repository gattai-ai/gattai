import { z } from "zod";

export type LeaderboardWeek = "current" | "previous";

export const leaderboardWeekSchema = z.enum(["current", "previous"]).default("current");

export interface LeaderboardWindow {
  label: LeaderboardWeek;
  /** Senin 00:00:00 UTC, inklusif. */
  start: Date;
  /** Senin berikutnya 00:00:00 UTC, eksklusif. */
  end: Date;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Window mingguan UTC: Senin 00:00 sampai Minggu 23:59:59.999.
 *
 * `previous` digeser tepat satu minggu ke belakang dari window `current`.
 * Perhitungan memakai komponen UTC, bukan timezone server, supaya batas minggu
 * konsisten di mesin mana pun.
 */
export function weekWindow(label: LeaderboardWeek, now = new Date()): LeaderboardWindow {
  const sinceMonday = (now.getUTCDay() + 6) % 7;
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - sinceMonday),
  );
  if (label === "previous") {
    start.setUTCDate(start.getUTCDate() - 7);
  }
  return {
    label,
    start,
    end: new Date(start.getTime() + WEEK_MS),
  };
}

export function serializeWeek(window: LeaderboardWindow): {
  start: string;
  end: string;
  label: LeaderboardWeek;
} {
  return {
    start: window.start.toISOString(),
    end: window.end.toISOString(),
    label: window.label,
  };
}
