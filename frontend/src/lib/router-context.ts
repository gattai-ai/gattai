import { createContext, useContext } from "react";

/**
 * Inti router (tanpa komponen) agar file komponen tetap ramah Fast Refresh.
 * Mendukung path + query + hash, karena situs statis memakai tautan seperti
 * `app.html#keys` dan `app.html?f=refine`.
 */

export interface RouterValue {
  /** Lokasi penuh: pathname + search + hash. */
  location: string;
  navigate: (to: string, options?: { replace?: boolean }) => void;
}

export const RouterContext = createContext<RouterValue | null>(null);

export function currentLocation(): string {
  return window.location.pathname + window.location.search + window.location.hash;
}

export function useRouter(): RouterValue {
  const value = useContext(RouterContext);
  if (!value) throw new Error("useRouter must be used inside <RouterProvider>.");
  return value;
}

/** Ambil pathname tanpa query/hash untuk pencocokan rute. */
export function pathnameOf(location: string): string {
  return location.split("?")[0].split("#")[0] || "/";
}

/** Ambil query string (?...) dari lokasi. */
export function searchOf(location: string): string {
  const withoutHash = location.split("#")[0];
  const index = withoutHash.indexOf("?");
  return index >= 0 ? withoutHash.slice(index) : "";
}

/** Ambil hash (#...) dari lokasi. */
export function hashOf(location: string): string {
  const index = location.indexOf("#");
  return index >= 0 ? location.slice(index) : "";
}

/** Cocokkan lokasi saat ini dengan pola path sederhana ("/", "/app/chat"). */
export function matchPath(location: string, pattern: string): boolean {
  const clean = pathnameOf(location);
  if (clean === pattern) return true;
  if (pattern !== "/" && clean.startsWith(`${pattern}/`)) return true;
  return false;
}

/**
 * Petakan URL legacy situs statis (*.html + hash view) ke rute SPA.
 * Mengembalikan null bila bukan URL legacy.
 */
export function resolveLegacy(location: string): string | null {
  const pathname = pathnameOf(location);
  const search = searchOf(location);
  const hash = hashOf(location).replace(/^#/, "");

  if (pathname === "/index.html" || pathname === "/index") return `/${hash ? `#${hash}` : ""}`;
  if (pathname === "/burns.html") return `/burns${hash ? `#${hash}` : ""}`;
  if (pathname === "/docs.html") return `/docs${hash ? `#${hash}` : ""}`;
  if (pathname === "/legal.html") return `/legal${hash ? `#${hash}` : ""}`;
  if (pathname === "/app.html" || pathname === "/app") {
    const views = new Set(["chat", "history", "gallery", "balance", "keys", "usage"]);
    const view = views.has(hash) ? hash : "chat";
    return `/app/${view}${search}`;
  }
  return null;
}
