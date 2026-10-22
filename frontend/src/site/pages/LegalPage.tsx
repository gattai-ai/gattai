import { Link } from "@/lib/router";
import { hashOf, useRouter } from "@/lib/router-context";
import { useDocumentTitle, useSiteReveal } from "@/site/useSite";
import "../legal.css";

/**
 * Legal dengan tampilan situs statis: tab terms/privacy/risk.
 * Disalin verbatim dari gattai-site/legal.html (draft).
 */

const TABS = [
  { id: "terms", label: "Terms of service" },
  { id: "privacy", label: "Privacy policy" },
  { id: "risk", label: "Risk disclosure" },
] as const;

export function LegalPage() {
  useDocumentTitle("GATTAI Legal");
  useSiteReveal();
  const { location } = useRouter();
  const hash = hashOf(location).replace(/^#/, "");
  const active = (TABS.map((tab) => tab.id) as readonly string[]).includes(hash) ? hash : "terms";

  return (
    <>
      <header className="phead">
        <div className="wrap">
          <span className="eyebrow" data-r>
            Legal
          </span>
          <h1 className="h1" data-r="2">
            The fine print,<br />
            <em>in plain words.</em>
          </h1>
          <p className="lede" data-r="3">
            Terms of service, privacy and risk disclosure for GATTAI and $GATTAI.
          </p>
        </div>
        <div className="jpbg" aria-hidden="true">
          規約
        </div>
      </header>

      <div className="lw">
        <nav className="ltabs" aria-label="Legal pages">
          {TABS.map((tab) => (
            <Link
              key={tab.id}
              to={`/legal#${tab.id}`}
              data-t={tab.id}
              className={active === tab.id ? "on" : undefined}
            >
              {tab.label}
            </Link>
          ))}
        </nav>
        <div>
          <div className="draft">
            <span>⚠</span>
            <span>
              <b>Draft: not yet in force.</b> These pages are working drafts prepared before launch and
              must be reviewed by legal counsel. Items marked <span className="tbd">TBD</span> are open
              decisions.
            </span>
          </div>

          <article className={`lpage${active === "terms" ? " on" : ""}`} id="terms">
            <h2>Terms of service</h2>
            <div className="upd">Draft · last edited Oct 2026</div>
            <h3>
              <span>01</span>The service
            </h3>
            <p>
              GATTAI runs your requests through a chain of third-party AI models and returns a combined
              result. Output is generated automatically and may be inaccurate, incomplete or unsuitable for
              your purpose. Review it before relying on it.
            </p>
            <h3>
              <span>02</span>Accounts, projects and keys
            </h3>
            <p>
              You are responsible for keeping your API keys secret and for all usage made with them. Revoke
              a key immediately if you think it has been exposed.
            </p>
            <h3>
              <span>03</span>Credits
            </h3>
            <ul>
              <li>
                Credits are a prepaid usage unit (1 credit = $0.01 list price) and are not money, securities
                or a deposit.
              </li>
              <li>
                Credits are non-refundable and non-withdrawable, except where required by law. Unused
                credits remain available for use in the service.
              </li>
              <li>
                If a run fails, you are charged only for provider steps that actually completed, plus
                the applicable markup. Steps that did not run are not charged. If no provider step
                completed, there is no usage charge for that run.
              </li>
              <li>
                Deposits below the minimum (dust) or above the configured cap are not credited
                automatically. The funds have already been forwarded to the treasury by the contract.
                Contact support with the transaction hash for manual review; do not send again.
              </li>
              <li>
                Only send assets shown in the app. Do not send tokens directly to the contract address;
                unsupported or direct transfers may be unrecoverable.
              </li>
            </ul>
            <h3>
              <span>04</span>Acceptable use
            </h3>
            <p>
              You agree not to use GATTAI in ways that break the law or the usage policies of the
              underlying model providers, including Anthropic, OpenAI, Perplexity and Higgsfield.
            </p>
            <h3>
              <span>05</span>Availability
            </h3>
            <p>
              Formations depend on external providers. If a provider is unavailable, formations that depend
              on it may be temporarily disabled while others keep working.
            </p>
            <h3>
              <span>06</span>Changes
            </h3>
            <p>
              Pricing parameters (markup, discount, burn shares, epoch length) are configuration values and
              may change. Changes will be announced publicly.
            </p>
          </article>

          <article className={`lpage${active === "privacy" ? " on" : ""}`} id="privacy">
            <h2>Privacy policy</h2>
            <div className="upd">Draft · last edited Oct 2026</div>
            <h3>
              <span>01</span>What we process
            </h3>
            <ul>
              <li>Your prompts and the outputs generated for them.</li>
              <li>Usage records: runs, steps, costs, timestamps.</li>
              <li>Wallet addresses and onchain deposit transactions linked to your project.</li>
              <li>Hashed API keys (the full key is never stored).</li>
            </ul>
            <h3>
              <span>02</span>Model providers
            </h3>
            <p>
              To produce a result, your request is sent to the model providers in the formation you run.
              Their handling of that data is governed by their own terms.
            </p>
            <h3>
              <span>03</span>Retention
            </h3>
            <p>
              Prompt and output retention period: <span className="tbd">TBD</span>. Logging scope:{" "}
              <span className="tbd">TBD</span>. Whether data is used for training:{" "}
              <span className="tbd">TBD</span>.
            </p>
            <h3>
              <span>04</span>Onchain data
            </h3>
            <p>
              Deposits, burns and token transfers happen on a public blockchain and cannot be deleted by
              anyone, including us.
            </p>
            <h3>
              <span>05</span>Media
            </h3>
            <p>
              Generated images and video are stored in object storage and served through signed, expiring
              links.
            </p>
          </article>

          <article className={`lpage${active === "risk" ? " on" : ""}`} id="risk">
            <h2>Risk disclosure</h2>
            <div className="upd">Draft · last edited Oct 2026</div>
            <p>
              Nothing on this site is financial, investment, legal or tax advice. Read this before buying or
              holding $GATTAI.
            </p>
            <h3>
              <span>01</span>Token price
            </h3>
            <p>
              The price of $GATTAI can fall sharply, including to zero. Buyback and burn depends on actual
              product usage and margin, which may be small or nothing. Past burns do not predict future
              burns.
            </p>
            <h3>
              <span>02</span>Liquidity
            </h3>
            <p>Liquidity may be thin, especially early. Large trades can move the price significantly.</p>
            <h3>
              <span>03</span>Smart contracts
            </h3>
            <p>
              Contracts will be audited before mainnet, but audits do not guarantee the absence of bugs.
              Transactions on a blockchain are final.
            </p>
            <h3>
              <span>04</span>Third-party dependencies
            </h3>
            <p>
              GATTAI relies on external AI providers and on Robinhood Chain. Changes to their pricing, terms
              or availability can affect the service.
            </p>
            <h3>
              <span>05</span>Regulation
            </h3>
            <p>
              The legal treatment of tokens and of revenue-funded buybacks varies by jurisdiction and may
              change. It is your responsibility to check whether you may hold or use $GATTAI where you live.
            </p>
            <h3>
              <span>06</span>Brand
            </h3>
            <p>
              GATTAI is built on Robinhood Chain and is not affiliated with or endorsed by Robinhood Markets,
              Inc. unless stated otherwise.
            </p>
          </article>
        </div>
      </div>
    </>
  );
}
