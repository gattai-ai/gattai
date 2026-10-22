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
