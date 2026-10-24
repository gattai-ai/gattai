import { useEffect } from "react";
import { observeReveals } from "./siteFx";

/** Pasang observer reveal/counter untuk konten yang baru ter-render. */
export function useSiteReveal(): void {
  useEffect(() => observeReveals(document), []);
}

/** Set judul dokumen per rute (head statis hanya punya satu title default). */
export function useDocumentTitle(title: string): void {
  useEffect(() => {
    const previous = document.title;
    document.title = title;
    return () => {
      document.title = previous;
    };
  }, [title]);
}

export interface DocumentMeta {
  title: string;
  description: string;
  /** URL absolut; crawler tidak menerima path relatif. */
  image?: string;
  url?: string;
  type?: "article" | "website";
  /** Halaman 404/share yang dicabut tidak boleh masuk indeks. */
  noindex?: boolean;
}

/**
 * Set title + meta description + Open Graph/Twitter per rute.
 *
 * Head statis hanya berisi metadata landing. Tanpa hook ini, halaman publik
 * seperti `/burns` akan dibagikan dengan judul/deskripsi landing — dan crawler
 * tidak menjalankan React, jadi nilai awal di `index.html` tetap penting.
 */
export function useDocumentMeta(meta: DocumentMeta): void {
  const { title, description, image, url, type = "website", noindex = false } = meta;

  useEffect(() => {
    if (typeof document === "undefined") return;
    const previousTitle = document.title;
    document.title = title;

    const touchedMeta = new Map<HTMLMetaElement, string | null>();
    const setMeta = (attribute: "name" | "property", name: string, content: string) => {
      let element = document.head.querySelector<HTMLMetaElement>(`meta[${attribute}="${name}"]`);
      if (!element) {
        element = document.createElement("meta");
        element.setAttribute(attribute, name);
        document.head.appendChild(element);
        touchedMeta.set(element, null);
      } else if (!touchedMeta.has(element)) {
        touchedMeta.set(element, element.getAttribute("content"));
      }
      element.setAttribute("content", content);
    };

    setMeta("name", "description", description);
    setMeta("property", "og:type", type);
    setMeta("property", "og:site_name", "GATTAI");
    setMeta("property", "og:title", title);
    setMeta("property", "og:description", description);
    if (image) {
      setMeta("property", "og:image", image);
      setMeta("property", "og:image:width", "1200");
      setMeta("property", "og:image:height", "630");
      setMeta("name", "twitter:image", image);
    }
    if (url) {
      setMeta("property", "og:url", url);
    }
    if (noindex) {
      setMeta("name", "robots", "noindex, nofollow");
    }
    setMeta("name", "twitter:card", "summary_large_image");
    setMeta("name", "twitter:title", title);
    setMeta("name", "twitter:description", description);

    let canonical: HTMLLinkElement | null = null;
    let previousCanonical: string | null = null;
    if (url) {
      canonical = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
      if (!canonical) {
        canonical = document.createElement("link");
        canonical.rel = "canonical";
        document.head.appendChild(canonical);
      } else {
        previousCanonical = canonical.getAttribute("href");
      }
      canonical.setAttribute("href", url);
    }

    return () => {
      document.title = previousTitle;
      for (const [element, previous] of touchedMeta) {
        if (previous === null) element.remove();
        else element.setAttribute("content", previous);
      }
      if (canonical) {
        if (previousCanonical === null) canonical.remove();
        else canonical.setAttribute("href", previousCanonical);
      }
    };
  }, [title, description, image, url, type, noindex]);
}
