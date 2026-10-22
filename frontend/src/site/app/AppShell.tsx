import { useEffect, type ReactNode } from "react";
import { useConnection, useConnect, useConnectors, useDisconnect } from "wagmi";
import { Link } from "@/lib/router";
import { useLogin, useLogout, useSession } from "@/lib/use-session";
import { useBodyClass } from "@/lib/use-body-class";
import { useBalance } from "@/features/balance/useBalance";
import { showToast } from "@/site/siteFx";
import { shortenAddress } from "@/lib/format";
import { useAppView, useGalleryCount, useKeysCount, useProjectName, useTrialQuota, type AppViewId } from "./useAppShell";
import "../app.css";

/**
 * Shell aplikasi GATTAI: sidebar + topbar + tab mobile.
 * Di-vendor dari gattai-site/app.html; data demo diganti data backend nyata.
 */

const VIEW_TITLES: Array<{ id: AppViewId; title: string }> = [
  { id: "chat", title: "Chat" },
  { id: "history", title: "History" },
  { id: "gallery", title: "Gallery" },
  { id: "balance", title: "Balance & top-up" },
  { id: "keys", title: "Keys" },
  { id: "usage", title: "Usage" },
];

function WalletButton() {
  const { address, isConnected } = useConnection();
  const { mutate: connect, isPending: isConnecting } = useConnect();
  const connectors = useConnectors();
  const { disconnect } = useDisconnect();
  const { session } = useSession();
  const { login, isPending: isLoggingIn } = useLogin();
  const { logout, error: logoutError } = useLogout();

  useEffect(() => {
    if (logoutError) showToast(logoutError);
  }, [logoutError]);

  if (!isConnected) {
    const connector = connectors[0];
    return (
      <button
        className="btn btn-dark btn-sm"
        id="walletBtn"
        disabled={!connector || isConnecting}
        onClick={() => connector && connect({ connector })}
      >
        {connector ? (isConnecting ? "Connecting…" : "Connect wallet") : "No wallet"}
      </button>
    );
  }

  if (!session) {
    return (
      <button className="btn btn-dark btn-sm" id="walletBtn" disabled={isLoggingIn} onClick={() => void login()}>
        {isLoggingIn ? "Signing…" : "Sign in"}
      </button>
    );
  }

  return (
    <button
      className="btn btn-dark btn-sm"
      id="walletBtn"
      title={`${address ?? ""} : click to sign out`}
      onClick={() => {
        // Keluar dulu di server, baru lepas wallet. Kalau logout gagal, wallet
        // tetap terhubung dan sesi tetap terlihat aktif — UI tidak boleh tampak
        // sudah keluar sementara sesinya masih hidup.
        void (async () => {
          if (await logout()) disconnect();
        })();
      }}
    >
      {address ? shortenAddress(address) : "Connected"}
    </button>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const view = useAppView();
  const projectName = useProjectName();
  const keysCount = useKeysCount();
  const galleryCount = useGalleryCount();
  const trial = useTrialQuota();
  const { data: balance } = useBalance();
  const { address } = useConnection();
  const { session } = useSession();

  const title = VIEW_TITLES.find((item) => item.id === view)?.title ?? "Chat";

  useEffect(() => {
    // Grid app dipasang di #root (lihat app.css): body hanya punya satu anak.
    const root = document.getElementById("root");
    root?.classList.add("app");
    return () => root?.classList.remove("app");
  }, []);

  // `body.chatmode` dipasang/dibuang lewat hook yang selalu cleanup; tanpa itu
  // kelas tertinggal saat keluar dari `/app/chat` dan halaman tujuan terkunci
  // (tidak bisa di-scroll).
  useBodyClass("chatmode", view === "chat");

  const credits = session ? balance?.balance_credits ?? 0 : 0;
  const creditsText = Number.isInteger(credits) ? credits.toLocaleString("en-US") : credits.toFixed(2);
  const trialPct = trial ? Math.round((trial.remaining / Math.max(1, trial.limit)) * 100) : 0;

  return (
    <>
      <aside className="side">
        <Link to="/" className="brand">
          <svg>
            <use href="#logo" />
          </svg>
          GATTAI
        </Link>
        <div className="proj">
          <small>Project</small>
          <b id="projName">{projectName}</b>
          <div className={`w${session ? " on" : ""}`} id="wState">
            <i></i>
            <span>{session && address ? `${shortenAddress(address)}` : "Wallet not connected"}</span>
          </div>
        </div>
        <nav className="snav" aria-label="App">
          <Link to="/app/chat" data-v="chat" className={view === "chat" ? "on" : undefined}>
            <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M3 4h12v8H8l-4 3v-3H3z" />
            </svg>
            Chat
          </Link>
          <Link to="/app/history" data-v="history" className={view === "history" ? "on" : undefined}>
            <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="9" cy="9" r="6.5" />
              <path d="M9 5.5V9l2.5 1.5" />
            </svg>
            History
          </Link>
          <Link to="/app/gallery" data-v="gallery" className={view === "gallery" ? "on" : undefined}>
            <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="2.5" y="2.5" width="5.5" height="5.5" />
              <rect x="10" y="2.5" width="5.5" height="5.5" />
              <rect x="2.5" y="10" width="5.5" height="5.5" />
              <rect x="10" y="10" width="5.5" height="5.5" fill="currentColor" />
            </svg>
            Gallery<span className="cnt" id="galCnt">{galleryCount}</span>
          </Link>
          <Link to="/app/balance" data-v="balance" className={view === "balance" ? "on" : undefined}>
            <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="2" y="4.5" width="14" height="10" rx="2" />
              <path d="M2 8h14M12 11.5h2" />
            </svg>
            Balance &amp; top-up
          </Link>
          <Link to="/app/keys" data-v="keys" className={view === "keys" ? "on" : undefined}>
            <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="6" cy="9" r="3.2" />
              <path d="M9.2 9H16M13.5 9v3M16 9v2" />
            </svg>
            Keys<span className="cnt" id="keyCnt">{keysCount}</span>
          </Link>
          <Link to="/app/usage" data-v="usage" className={view === "usage" ? "on" : undefined}>
            <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M2.5 15.5h13M4.5 12V8M8 12V4.5M11.5 12V7M15 12V9.5" />
            </svg>
            Usage
          </Link>
        </nav>
        <div className="foot">
          {trial && (trial.remaining > 0 || (trial.mediaLeft ?? 0) > 0) && (
            <div className="trialcard" id="trialCard">
              <small>Free trial</small>
              <div className="n">
                <em className="balN" style={{ fontStyle: "normal" }}>
                  {trial.remaining}
                </em>
                <span>of {trial.limit} prompts</span>
              </div>
              <div
                className="bar"
                role="img"
                aria-label={`${trial.remaining} of ${trial.limit} free prompts left`}
              >
                <i style={{ width: `${trialPct}%` }}></i>
              </div>
              {trial.mediaLeft != null && (
                // Kuota teks dan jatah media mandiri: 0 prompt teks tidak berarti
                // jatah media ikut hilang, jadi baris ini di-highlight saat hanya
                // media yang tersisa.
                <div className={trial.remaining === 0 && trial.mediaLeft > 0 ? "u hot" : "u"}>
                  {trial.mediaLeft > 0
                    ? `${trial.mediaLeft} media ${trial.mediaLeft === 1 ? "run" : "runs"} left`
                    : "media runs used up"}
                </div>
              )}
            </div>
          )}
          <div className="balcard">
            <small>Balance</small>
            <div className="n">
              <em className="balN" style={{ fontStyle: "normal" }}>
                {creditsText}
              </em>
              <span>cr</span>
            </div>
            <div className="u">
              ≈ $<span className="balU">{(credits / 100).toFixed(2)}</span> · 1 cr = $0.01
            </div>
            <Link to="/app/balance" className="btn btn-acc btn-sm">
              Top up
            </Link>
          </div>
        </div>
      </aside>

      <main className="appmain">
        <header className="topbar">
          <Link to="/" className="brand">
            <svg>
              <use href="#logo" />
            </svg>
            GATTAI
          </Link>
          <div>
            <div className="crumb">{projectName} /</div>
            <h1 id="vTitle">{title}</h1>
          </div>
          <div className="sp"></div>
          {trial && (trial.remaining > 0 || (trial.mediaLeft ?? 0) > 0) && (
            <span className="balpill" id="trialPill" title="Free trial left on this wallet">
              {trial.remaining > 0 ? (
                <>
                  <b className="balN">{trial.remaining}</b> free
                  {trial.mediaLeft != null && trial.mediaLeft > 0 && (
                    <>
                      {" · "}
                      <b className="balN">{trial.mediaLeft}</b> media
                    </>
                  )}
                </>
              ) : (
                <>
                  <b className="balN">{trial.mediaLeft ?? 0}</b> media free
                </>
              )}
            </span>
          )}
          <span className="balpill">
            <b className="balN">{creditsText}</b> cr
          </span>
          <WalletButton />
          <nav className="mtabs" aria-label="App sections">
            {VIEW_TITLES.map((item) => (
              <Link
                key={item.id}
                to={`/app/${item.id}`}
                data-v={item.id}
                className={view === item.id ? "on" : undefined}
              >
                {item.id === "balance" ? "Balance" : item.title}
              </Link>
            ))}
          </nav>
        </header>
        {children}
      </main>
    </>
  );
}

/** Pengganti demo offline: tampilkan ajakan login bergaya situs bila belum ada sesi. */
export function NeedLogin({ action }: { action: string }) {
  const { isConnected } = useConnection();
  const { login, isPending, error } = useLogin();
  return (
    <section className="view on" style={{ alignItems: "center", justifyContent: "center" }}>
      <div className="empty" style={{ maxWidth: 520 }}>
        <p style={{ fontSize: 15, color: "var(--text)", marginBottom: 8 }}>Connect to {action}</p>
        <p className="muted" style={{ fontSize: 13.5, marginBottom: 16 }}>
          {isConnected
            ? "Sign the login message with your wallet. No transaction, no gas."
            : "Connect a wallet first, then sign in. No transaction, no gas."}
        </p>
        {isConnected ? (
          <button className="btn btn-acc" disabled={isPending} onClick={() => void login()}>
            {isPending ? "Waiting for signature…" : "Sign in"}
          </button>
        ) : (
          <span className="muted" style={{ fontSize: 13 }}>
            Use the “Connect wallet” button above.
          </span>
        )}
        {error && (
          <p style={{ color: "#ff8a8a", fontSize: 12.5, marginTop: 12 }}>{error}</p>
        )}
      </div>
    </section>
  );
}
