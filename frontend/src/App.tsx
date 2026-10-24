import { useEffect } from "react";
import { matchPath, pathnameOf, searchOf, useRouter } from "@/lib/router-context";
import { Link } from "@/lib/router";
import { installCopyDelegation } from "@/site/siteFx";
import { SiteSvgDefs } from "@/site/SiteDefs";
import { MarketingLayout } from "@/site/MarketingLayout";
import { AppShell } from "@/site/app/AppShell";
import { ChatView } from "@/site/app/ChatView";
import { HistoryView } from "@/site/app/HistoryView";
import { GalleryView } from "@/site/app/GalleryView";
import { BalanceView } from "@/site/app/BalanceView";
import { KeysView } from "@/site/app/KeysView";
import { UsageView } from "@/site/app/UsageView";
import { LandingPage } from "@/site/pages/LandingPage";
import { BurnsPage } from "@/site/pages/BurnsPage";
import { HoldersPage } from "@/site/pages/HoldersPage";
import { LeaderboardPage } from "@/site/pages/LeaderboardPage";
import { StatsPage } from "@/site/pages/StatsPage";
import { RunPage } from "@/site/pages/RunPage";
import { DocsPage } from "@/site/pages/DocsPage";
import { LegalPage } from "@/site/pages/LegalPage";

/**
 * Rute GATTAI mengikuti struktur situs statis:
 * `/` landing, `/app/*` aplikasi, `/burns`, `/docs`, `/legal`.
 */
function Routes() {
  const { location, navigate } = useRouter();
  const pathname = pathnameOf(location);

  useEffect(() => {
    if (pathname === "/app" || pathname === "/app/") {
      navigate(`/app/chat${searchOf(location)}`, { replace: true });
    }
  }, [pathname, location, navigate]);

  // Static hosting (Railway / Nginx) tidak memproses rewrites SPA, jadi
  // `404.html` menyimpan path yang hilang lalu kembali ke `/`. Baca di sini
  // agar router merender blok 404 branded, bukan landing page.
  useEffect(() => {
    if (pathname !== "/") return;
    let stored: string | null = null;
    try {
      stored = window.sessionStorage.getItem("gattai:redirect");
      if (stored) window.sessionStorage.removeItem("gattai:redirect");
    } catch {
      return;
    }
    if (!stored || stored === "/" || !stored.startsWith("/")) return;
    navigate(stored, { replace: true });
  }, [pathname, navigate]);

  if (pathname === "/") {
    return (
      <MarketingLayout>
        <LandingPage />
      </MarketingLayout>
    );
  }
  if (matchPath(location, "/burns")) {
    return (
      <MarketingLayout>
        <BurnsPage />
      </MarketingLayout>
    );
  }
  if (matchPath(location, "/holders")) {
    return (
      <MarketingLayout>
        <HoldersPage />
      </MarketingLayout>
    );
  }
  if (matchPath(location, "/stats")) {
    return (
      <MarketingLayout>
        <StatsPage />
      </MarketingLayout>
    );
  }
  if (matchPath(location, "/leaderboard")) {
    return (
      <MarketingLayout>
        <LeaderboardPage />
      </MarketingLayout>
    );
  }
  if (matchPath(location, "/run")) {
    const slug = pathname.split("/").filter(Boolean)[1] ?? "";
    return (
      <MarketingLayout>
        <RunPage slug={slug} />
      </MarketingLayout>
    );
  }
  if (matchPath(location, "/docs")) {
    return (
      <MarketingLayout>
        <DocsPage />
      </MarketingLayout>
    );
  }
  if (matchPath(location, "/legal")) {
    return (
      <MarketingLayout>
        <LegalPage />
      </MarketingLayout>
    );
  }
  if (matchPath(location, "/app/chat")) {
    return (
      <AppShell>
        <ChatView />
      </AppShell>
    );
  }
  if (matchPath(location, "/app/history")) {
    return (
      <AppShell>
        <HistoryView />
      </AppShell>
    );
  }
  if (matchPath(location, "/app/gallery")) {
    return (
      <AppShell>
        <GalleryView />
      </AppShell>
    );
  }
  if (matchPath(location, "/app/balance")) {
    return (
      <AppShell>
        <BalanceView />
      </AppShell>
    );
  }
  if (matchPath(location, "/app/keys")) {
    return (
      <AppShell>
        <KeysView />
      </AppShell>
    );
  }
  if (matchPath(location, "/app/usage")) {
    return (
      <AppShell>
        <UsageView />
      </AppShell>
    );
  }
  if (pathname === "/app" || pathname === "/app/") return null;

  return (
    <MarketingLayout>
      <section className="wrap" style={{ padding: "160px 16px 80px", textAlign: "center" }}>
        <span className="eyebrow">404</span>
        <h1 className="h1">Lost in formation.</h1>
        <p className="lede" style={{ marginLeft: "auto", marginRight: "auto" }}>
          This page does not exist. Head back to the app or the docs.
        </p>
        <div style={{ display: "flex", gap: 10, justifyContent: "center", marginTop: 24 }}>
          <Link to="/app/chat" className="btn btn-acc">
            Open the app
          </Link>
          <Link to="/docs" className="btn btn-dark">
            Read the docs
          </Link>
        </div>
      </section>
    </MarketingLayout>
  );
}

function App() {
  useEffect(() => installCopyDelegation(), []);

  return (
    <>
      <SiteSvgDefs />
      <Routes />
    </>
  );
}

export default App;
