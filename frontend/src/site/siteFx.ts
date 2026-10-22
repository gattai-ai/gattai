/**
 * Perilaku bersama situs statis, diadaptasi ke React (tanpa script global).
 * Di-vendor dari gattai-site/assets/gattai.js: toast, copy, reveal, counters.
 */

export function formatCount(value: number, decimals = 0): string {
  return Number(value).toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

let toastEl: HTMLDivElement | null = null;
let toastTimer: number | undefined;

export function showToast(message: string): void {
  if (!toastEl) {
    toastEl = document.createElement("div");
    toastEl.className = "toast";
    toastEl.setAttribute("role", "status");
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = message;
  toastEl.classList.add("on");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl?.classList.remove("on"), 2200);
}

export async function copyText(text: string): Promise<boolean> {
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    ok = false;
  }
  showToast(ok ? "Copied to clipboard" : "Copy not available here");
  return ok;
}

/** Delegasi klik global untuk [data-copy] dan [data-copy-code]. */
export function installCopyDelegation(): () => void {
  const onClick = (event: MouseEvent) => {
    const target = event.target as HTMLElement | null;
    if (!target || typeof target.closest !== "function") return;
    const direct = target.closest("[data-copy]");
    if (direct instanceof HTMLElement && direct.dataset.copy !== undefined) {
      void copyText(direct.dataset.copy);
      return;
    }
    const code = target.closest("[data-copy-code]");
    if (code instanceof HTMLElement) {
      const container = code.closest(".code");
      const pre = container?.querySelector("pre");
      if (pre) void copyText(pre.innerText);
    }
  };
  document.addEventListener("click", onClick);
  return () => document.removeEventListener("click", onClick);
}

function animateCount(el: HTMLElement, reduceMotion: boolean): void {
  const to = Number(el.dataset.count || "0");
  const decimals = Number(el.dataset.dec || "0");
  if (reduceMotion) {
    el.textContent = formatCount(to, decimals);
    return;
  }
  const duration = 2000;
  const start = performance.now();
  const step = (now: number) => {
    const progress = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - progress, 4);
    el.textContent = formatCount(to * eased, decimals);
    if (progress < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/**
 * Amati [data-r] (reveal) dan [data-count] (counter) di dalam scope.
 * Dipanggil ulang setiap halaman mount karena konten baru ter-render.
 */
export function observeReveals(scope: ParentNode = document): () => void {
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const revealObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add("in");
          revealObserver.unobserve(entry.target);
        }
      }
    },
    { threshold: 0.12, rootMargin: "0px 0px -6% 0px" },
  );

  const countObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const el = entry.target as HTMLElement;
        animateCount(el, reduceMotion);
        countObserver.unobserve(el);
      }
    },
    { threshold: 0.4 },
  );

  for (const el of scope.querySelectorAll("[data-r]")) revealObserver.observe(el);
  for (const el of scope.querySelectorAll("[data-count]")) {
    countObserver.observe(el);
  }

  return () => {
    revealObserver.disconnect();
    countObserver.disconnect();
  };
}
