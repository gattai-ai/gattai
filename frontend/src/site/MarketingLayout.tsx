import { useEffect, useState, type ReactNode } from "react";
import { Link } from "@/lib/router";
import { matchPath, useRouter } from "@/lib/router-context";

/**
 * Kerangka halaman marketing: top nav + ruler + mobile menu + footer.
 * Di-vendor dari gattai-site (header/footer setiap halaman statis).
 */
export function MarketingLayout({ children }: { children: ReactNode }) {
  const { location } = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);

  const current = matchPath(location, "/docs")
    ? "docs"
    : matchPath(location, "/burns")
      ? "burns"
      : null;

  // Tutup menu mobile setiap pindah rute.
  useEffect(() => {
    setMenuOpen(false);
  }, [location]);

  // Jam + ruler + sembunyikan nav saat scroll (seperti gattai.js).
  useEffect(() => {
    const clock = document.getElementById("clock");
    const ticks = document.getElementById("ticks");
    const top = document.getElementById("top");
    const label = document.getElementById("rlabr");

    const tickClock = () => {
      if (clock) {
        clock.textContent = new Date()
          .toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
          .toUpperCase();
      }
    };
    tickClock();
    const clockTimer = window.setInterval(tickClock, 5000);

    let lastY = 0;
    const onScroll = () => {
      const y = window.scrollY;
      if (ticks) ticks.style.setProperty("--rx", `${-y * 0.6}px`);
      const max = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
      if (label) {
        label.textContent = `SCROLL ${String(Math.round(Math.min(1, Math.max(0, y / max)) * 100)).padStart(3, "0")}%`;
      }
      if (top) {
        if (y > 300 && y > lastY + 4) top.classList.add("hide");
        if (y < lastY - 4 || y < 300) top.classList.remove("hide");
      }
      lastY = y;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();

    return () => {
      window.clearInterval(clockTimer);
      window.removeEventListener("scroll", onScroll);
    };
  }, [location]);

  return (
    <>
      <header className="top" id="top">
        <nav className="main">
          <Link to="/" className="brand" aria-label="GATTAI home">
            <svg>
              <use href="#logo" />
            </svg>
            GATTAI
          </Link>
          <div className="navlinks">
            <Link to="/#how">How it works</Link>
            <Link to="/#recipes">Formations</Link>
            <Link to="/docs" className={current === "docs" ? "cur" : undefined}>
              Docs
            </Link>
            <Link to="/burns" className={current === "burns" ? "cur" : undefined}>
              Burns
            </Link>
            <Link to="/#token">$GATTAI</Link>
            <Link to="/#faq">FAQ</Link>
          </div>
          <div className="navcta">
            <Link to="/app/keys" className="btn btn-dark">
              Get your key
            </Link>
            <Link to="/app/chat" className="btn btn-light">
              Launch App
            </Link>
            <button className="burger" aria-label="Menu" onClick={() => setMenuOpen((open) => !open)}>
              <i></i>
            </button>
          </div>
        </nav>
        <div className="ruler" aria-hidden="true">
          <div className="ticks" id="ticks"></div>
          <div className="needle"></div>
          <div className="clock" id="clock">
            --:-- --
          </div>
          <span className="rlab l">FORMATION CLOCK</span>
          <span className="rlab r" id="rlabr">
            SCROLL 000%
          </span>
        </div>
      </header>
      <div className={`mmenu${menuOpen ? " on" : ""}`} id="mmenu">
        <Link to="/#how" onClick={() => setMenuOpen(false)}>
          How it works
        </Link>
        <Link to="/#recipes" onClick={() => setMenuOpen(false)}>
          Formations
        </Link>
        <Link to="/docs" onClick={() => setMenuOpen(false)}>
          Docs
        </Link>
        <Link to="/burns" onClick={() => setMenuOpen(false)}>
          Burns
        </Link>
        <Link to="/#token" onClick={() => setMenuOpen(false)}>
          $GATTAI
        </Link>
        <Link to="/#faq" onClick={() => setMenuOpen(false)}>
          FAQ
        </Link>
        <Link to="/app/chat" onClick={() => setMenuOpen(false)}>
          Launch App →
        </Link>
      </div>

      {children}

      <footer className="site">
        <div className="wrap">
          <div className="fgrid">
            <div>
              <Link to="/" className="brand">
                <svg>
                  <use href="#logo" />
                </svg>
                GATTAI
              </Link>
              <p>Separate machines. One formation. Settled on Robinhood Chain. Powered by $GATTAI.</p>
            </div>
            <div>
              <h6>Product</h6>
              <Link to="/app/chat">App</Link>
              <Link to="/docs">Docs</Link>
              <Link to="/#recipes">Formations</Link>
              <Link to="/app/keys">API keys</Link>
            </div>
            <div>
              <h6>Token</h6>
              <Link to="/burns">Burn dashboard</Link>
              <Link to="/#token">$GATTAI</Link>
              <Link to="/#roadmap">Roadmap</Link>
              <Link to="/burns#contract">Explorer (contract)</Link>
            </div>
            <div>
              <h6>Community</h6>
              <a href="https://x.com/gattai_ai" target="_blank" rel="noreferrer">
                X / Twitter
              </a>
              <Link to="/legal#terms">Terms</Link>
              <Link to="/legal#privacy">Privacy</Link>
              <Link to="/legal#risk">Risk disclosure</Link>
            </div>
          </div>
          <div className="wm" data-r aria-hidden="true">
            <div className="wmtop">
              <span className="jp">合体</span>
              <span className="mid"></span>
              <span>Separate machines · One formation</span>
              <span className="mid"></span>
              <span>MMXXVI</span>
            </div>
            <svg viewBox="0 0 1000 178" preserveAspectRatio="xMidYMax meet">
              <text
                className="wmtext base"
                x="500"
                y="168"
                textAnchor="middle"
                fontSize="212"
                textLength="996"
                lengthAdjust="spacingAndGlyphs"
              >
                GATTAI
              </text>
              <text
                className="wmtext sheen"
                x="500"
                y="168"
                textAnchor="middle"
                fontSize="212"
                textLength="996"
                lengthAdjust="spacingAndGlyphs"
                opacity=".55"
              >
                GATTAI
              </text>
            </svg>
            <div className="floor"></div>
          </div>
          <div className="legal">
            <span>© 2026 GATTAI. Not financial advice.</span>
            <span>Built on Robinhood Chain</span>
          </div>
        </div>
      </footer>
    </>
  );
}
