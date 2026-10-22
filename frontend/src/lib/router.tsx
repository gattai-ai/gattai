import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type AnchorHTMLAttributes,
  type ReactNode,
} from "react";
import { RouterContext, currentLocation, hashOf, resolveLegacy, useRouter } from "./router-context";

/** Komponen router: provider + tautan. Logika ada di ./router-context. */

function scrollToLocation(location: string) {
  const hash = hashOf(location);
  if (hash.length > 1) {
    // Tunggu satu frame agar rute baru sempat ter-render.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const target = document.getElementById(hash.slice(1));
        if (target) target.scrollIntoView({ block: "start" });
        else window.scrollTo({ top: 0 });
      });
    });
    return;
  }
  window.scrollTo({ top: 0 });
}

export function RouterProvider({ children }: { children: ReactNode }) {
  const [location, setLocation] = useState(currentLocation);

  useEffect(() => {
    const onPopState = () => {
      const next = currentLocation();
      const legacy = resolveLegacy(next);
      if (legacy && legacy !== next) {
        window.history.replaceState(null, "", legacy);
        setLocation(legacy);
        scrollToLocation(legacy);
        return;
      }
      setLocation(next);
      scrollToLocation(next);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const navigate = useCallback((to: string, options?: { replace?: boolean }) => {
    const current = currentLocation();
    const legacy = resolveLegacy(to.startsWith("#") ? current.split("#")[0] + to : to);
    const dest = legacy ?? to;
    if (dest === current) {
      scrollToLocation(dest);
      return;
    }
    if (options?.replace) window.history.replaceState(null, "", dest);
    else window.history.pushState(null, "", dest);
    setLocation(currentLocation());
    scrollToLocation(dest);
  }, []);

  // Redirect legacy saat mount awal (mis. dibuka langsung dari bookmark .html).
  useEffect(() => {
    const legacy = resolveLegacy(currentLocation());
    if (legacy && legacy !== currentLocation()) {
      window.history.replaceState(null, "", legacy);
      setLocation(legacy);
    }
  }, []);

  const value = useMemo(() => ({ location, navigate }), [location, navigate]);

  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

interface LinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  to: string;
  children: ReactNode;
}

export function Link({ to, children, onClick, ...rest }: LinkProps) {
  const { navigate } = useRouter();
  return (
    <a
      href={to}
      onClick={(event) => {
        onClick?.(event);
        // Biarkan buka-tab-baru (ctrl/cmd/klik tengah) berjalan normal.
        if (event.defaultPrevented) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        // Tautan eksternal/anchor non-rute dibiarkan ke browser.
        if (/^(https?:|mailto:|tel:)/.test(to)) return;
        event.preventDefault();
        navigate(to);
      }}
      {...rest}
    >
      {children}
    </a>
  );
}
