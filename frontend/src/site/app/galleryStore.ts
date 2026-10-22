import { useEffect, useState } from "react";

/**
 * Galeri lokal berisi run media nyata (visual/video/launch_kit) yang sudah
 * selesai. Detail tiap run diambil dari API (`GET /v1/runs/{id}`) saat
 * dibuka, jadi yang disimpan di sini hanya referensinya.
 */

export interface GalleryEntry {
  id: string;
  recipe: string;
  prompt: string;
  finishedAt: number;
}

const STORAGE_KEY = "gattai:gallery";
const listeners = new Set<() => void>();

function readEntries(): GalleryEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as GalleryEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeEntries(entries: GalleryEntry[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(0, 200)));
  } catch {
    // Penyimpanan penuh/dibatasi: galeri tetap jalan di memori sesi ini.
  }
  for (const notify of listeners) notify();
}

export function addGalleryEntry(entry: GalleryEntry): void {
  const entries = readEntries().filter((item) => item.id !== entry.id);
  entries.unshift(entry);
  writeEntries(entries);
}

export function useGalleryEntries(): GalleryEntry[] {
  const [entries, setEntries] = useState<GalleryEntry[]>(readEntries);

  useEffect(() => {
    const refresh = () => setEntries(readEntries());
    listeners.add(refresh);
    refresh();
    return () => {
      listeners.delete(refresh);
    };
  }, []);

  return entries;
}
