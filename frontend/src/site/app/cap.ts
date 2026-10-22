import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "@/lib/api";
import { useSession } from "@/lib/use-session";
import type { UsageResponse } from "@/lib/types";

/**
 * Daily spending cap (penjagaan sisi klien). Backend tidak punya fitur cap,
 * jadi pengaturan disimpan lokal dan pemeriksaan dilakukan sebelum run dibuat.
 */

export interface CapSettings {
  on: boolean;
  value: number;
}

const STORAGE_KEY = "gattai:cap";

export function readCapSettings(): CapSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<CapSettings>;
      return { on: Boolean(parsed.on), value: Math.max(0, Number(parsed.value) || 0) };
    }
  } catch {
    // abaikan
  }
  return { on: false, value: 500 };
}

export function writeCapSettings(settings: CapSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // abaikan
  }
}

/** Total credits yang di-settle dalam 24 jam terakhir (untuk cap harian). */
export function useSpentToday(): number {
  const { session } = useSession();
  const { data } = useQuery({
    queryKey: ["usage", "cap", session?.projectId],
    queryFn: () => api<UsageResponse>("/v1/usage?limit=200"),
    enabled: Boolean(session),
    staleTime: 30_000,
  });
  const cutoff = Date.now() - 24 * 3600 * 1000;
  let spent = 0;
  for (const entry of data?.entries ?? []) {
    if (entry.type !== "SETTLE") continue;
    if (new Date(entry.created_at).getTime() < cutoff) continue;
    spent += Math.abs(entry.amount_credits);
  }
  return spent;
}

export function useCapSettings(): {
  settings: CapSettings;
  setSettings: (settings: CapSettings) => void;
} {
  const [settings, setSettingsState] = useState<CapSettings>(readCapSettings);
  const setSettings = (next: CapSettings) => {
    setSettingsState(next);
    writeCapSettings(next);
  };
  return { settings, setSettings };
}
