import { useEffect, useMemo, useState } from "react";
import { Link } from "@/lib/router";
import { useDocumentTitle, useSiteReveal } from "@/site/useSite";
import "../docs.css";

/**
 * Developer docs dengan tampilan situs statis: TOC + scrollspy + filter +
 * konten referensi API. Disalin verbatim dari gattai-site/docs.html.
 */

/** Teks carian statis per section (agar filter tidak bergantung DOM live). */
const SEARCH_TEXT: Record<string, string> = {
  intro: "introduction project key credits formation step run recipe chain balance ledger",
  quickstart: "quickstart app key top up eth usdg gattai openai client model stream",
  auth: "authentication bearer token idempotency key hash revoke rate limit label never ship client side",
  formations: "formations refine research code visual video launch kit gpt claude perplexity higgsfield interpret execute gather sources write review fix art direction script shots copy pack render",
  orchestration: "run flows refine interpreter brief executor original message pass through conflict failed step input",
  chat: "chat completions openai compatible post streaming usage provider cursor claude code",
  runs: "runs api native post get events sse stream confirm media estimate recipes balance usage keys revoke delete burns",
  states: "run states created reserved step pending complete settled failed released awaiting confirmation insufficient balance media",
  errors: "errors limits 401 invalid key 402 insufficient balance 409 idempotency conflict 429 rate limited spend cap 503 formation unavailable",
  billing: "credits billing estimate reserve buffer run settle charge markup fifo lots failed runs",
  topups: "top-ups deposit eth usdg gattai robinhood chain confirmations credit lot price feed time weighted discount",
  burns: "public burns epoch margin buyback treasury transaction hashes total burned",
};
const SECTIONS = [
  { id: "intro", group: "Start", label: "Introduction" },
  { id: "quickstart", group: "Start", label: "Quickstart" },
  { id: "auth", group: "Start", label: "Authentication" },
  { id: "formations", group: "Formations", label: "Formations" },
  { id: "orchestration", group: "Formations", label: "How a run flows" },
  { id: "chat", group: "API", label: "Chat completions" },
  { id: "runs", group: "API", label: "Runs API" },
  { id: "states", group: "API", label: "Run states" },
  { id: "errors", group: "API", label: "Errors & limits" },
  { id: "billing", group: "Money", label: "Credits & billing" },
  { id: "topups", group: "Money", label: "Top-ups" },
  { id: "burns", group: "Money", label: "Public burns" },
] as const;

export function DocsPage() {
  useDocumentTitle("GATTAI Docs");
  useSiteReveal();
  const [filter, setFilter] = useState("");
  const [active, setActive] = useState("intro");

  useEffect(() => {
    const onScroll = () => {
      let current: string = SECTIONS[0].id;
      for (const section of SECTIONS) {
        const el = document.getElementById(section.id);
        if (el && el.getBoundingClientRect().top < 160) current = section.id;
      }
      setActive(current);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const query = filter.toLowerCase().trim();
  // Visibilitas dihitung dari peta teks statis (bukan DOM live): section yang
  // di-unmount oleh filter sebelumnya harus tetap bisa ditemukan lagi.
  const visible = useMemo(() => {
    if (!query) return new Set(SECTIONS.map((section) => section.id));
    const matches = new Set<string>();
    for (const section of SECTIONS) {
      const text = `${section.label} ${SEARCH_TEXT[section.id] ?? ""}`.toLowerCase();
      if (text.includes(query)) matches.add(section.id);
    }
    return matches;
  }, [query]);

  const groups = useMemo(() => {
    const result: Array<{ name: string; sections: Array<(typeof SECTIONS)[number]> }> = [];
    for (const section of SECTIONS) {
      if (!visible.has(section.id)) continue;
      const group = result.find((item) => item.name === section.group);
      if (group) group.sections.push(section);
      else result.push({ name: section.group, sections: [section] });
    }
    return result;
  }, [visible]);

  return (
    <>
      <header className="phead">
        <div className="wrap">
          <span className="eyebrow" data-r>
            Developer docs · v1
          </span>
          <h1 className="h1" data-r="2">
            Call a formation<br />like <em>any model.</em>
          </h1>
          <p className="lede" data-r="3">
            One key, one balance, six formations. Drop GATTAI into any OpenAI-compatible client, or use
            the native runs API for media and step-level detail.
          </p>
        </div>
        <div className="jpbg" aria-hidden="true">
          合体
        </div>
      </header>

      <div className="docs">
        <aside className="toc" id="toc">
          <div className="search">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="#8d929a" strokeWidth="1.5">
              <circle cx="6" cy="6" r="4.5" />
              <path d="M9.5 9.5 13 13" />
            </svg>
            <input
              className="inp"
              id="docFilter"
              placeholder="Filter sections…"
              aria-label="Filter sections"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
          </div>
          {groups.map((group) => (
            <span key={group.name}>
              <h6>{group.name}</h6>
              {group.sections.map((section) => (
                <Link
                  key={section.id}
                  to={`#${section.id}`}
                  className={active === section.id ? "on" : undefined}
                >
                  {section.label}
                </Link>
              ))}
            </span>
          ))}
        </aside>

        <main className="doc">
          <div className="call w">
            <b>Pre-launch reference.</b> Endpoints and examples describe the planned v1 API. The base
            URL <code>api.gattai.example</code> is a placeholder until launch.
          </div>

          {visible.has("intro") && (
            <section id="intro">
              <h2>
                <span className="n">01</span>Introduction
              </h2>
              <p>
                GATTAI runs every request through a <b>formation</b>: an ordered chain of AI models, each
                with one job. A project holds <b>one key</b> and <b>one credit balance</b>. You see one
                result, and you can inspect every step of the chain and what it cost.
              </p>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Term</th>
                    <th>Meaning</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className="m">Project</td>
                    <td>Owns the key, the balance and the ledger. Can be tied to a wallet.</td>
                  </tr>
                  <tr>
                    <td className="m">Key</td>
                    <td>
                      Project API key, <code>gtt_live_…</code>. Used by the app and by your code.
                    </td>
                  </tr>
                  <tr>
                    <td className="m">Credits</td>
                    <td>Usage unit. 1 credit = $0.01 list price.</td>
                  </tr>
                  <tr>
                    <td className="m">Formation</td>
                    <td>A recipe: an ordered list of steps.</td>
                  </tr>
                  <tr>
                    <td className="m">Step</td>
                    <td>
                      One model call with a role, e.g. <code>interpret</code>, <code>execute</code>,{" "}
                      <code>render_video</code>.
                    </td>
                  </tr>
                  <tr>
                    <td className="m">Run</td>
                    <td>One execution of a formation for one request. Has a unique ID.</td>
                  </tr>
                </tbody>
              </table>
            </section>
          )}

          {visible.has("quickstart") && (
            <section id="quickstart">
              <h2>
                <span className="n">02</span>Quickstart
              </h2>
              <ol>
                <li>
                  Open the <Link to="/app/chat" style={{ color: "var(--acc)" }}>app</Link> and create a
                  key under <b>Keys</b>.
                </li>
                <li>Top up credits with ETH, USDG or $GATTAI.</li>
                <li>
                  Point any OpenAI-compatible client at the GATTAI base URL and pick a formation as the
                  model.
                </li>
              </ol>
              <div className="code">
                <div className="ch">
                  <span>TypeScript · openai sdk</span>
                  <button data-copy-code>Copy</button>
                </div>
                <pre>
                  <span className="c4">import</span> OpenAI <span className="c4">from</span>{" "}
                  <span className="c3">&quot;openai&quot;</span>;{"\n\n"}
                  <span className="c4">const</span> gattai = <span className="c4">new</span> OpenAI({"{\n"}
                  {"  "}baseURL: <span className="c3">&quot;https://api.gattai.example/v1&quot;</span>,{"\n"}
                  {"  "}apiKey: process.env.GATTAI_KEY,{"\n"}
                  {"}"});{"\n\n"}
                  <span className="c4">const</span> stream = <span className="c4">await</span>{" "}
                  gattai.chat.completions.create({"{\n"}
                  {"  "}model: <span className="c3">&quot;gattai/refine&quot;</span>,{"\n"}
                  {"  "}stream: <span className="c4">true</span>,{"\n"}
                  {"  "}messages: [{"{{"} role: <span className="c3">&quot;user&quot;</span>, content:{" "}
                  <span className="c3">&quot;Sharpen this headline: …&quot;</span> {"}}"}"],{"\n"}
                  {"}"});{"\n"}
                  <span className="c4">for await</span> (<span className="c4">const</span> chunk{" "}
                  <span className="c4">of</span> stream) process.stdout.write(chunk.choices[0]?.delta?.content ??{" "}
                  <span className="c3">&quot;&quot;</span>);
                </pre>
              </div>
              <div className="code">
                <div className="ch">
                  <span>Python · openai sdk</span>
                  <button data-copy-code>Copy</button>
                </div>
                <pre>
                  <span className="c4">from</span> openai <span className="c4">import</span> OpenAI{"\n"}
                  <span className="c4">import</span> os{"\n\n"}
                  gattai = OpenAI(base_url=<span className="c3">&quot;https://api.gattai.example/v1&quot;</span>,
                  api_key=os.environ[<span className="c3">&quot;GATTAI_KEY&quot;</span>]){"\n"}
                  res = gattai.chat.completions.create({"\n"}
                  {"    "}model=<span className="c3">&quot;gattai/research&quot;</span>,{"\n"}
                  {"    "}messages=[{"{{"} <span className="c3">&quot;role&quot;</span>:{" "}
                  <span className="c3">&quot;user&quot;</span>, <span className="c3">&quot;content&quot;</span>:{" "}
                  <span className="c3">&quot;State of L2 fee markets, cited&quot;</span> {"}}"}],{"\n"}
                  ){"\n"}
                  print(res.choices[0].message.content)
                </pre>
              </div>
            </section>
          )}

          {visible.has("auth") && (
            <section id="auth">
              <h2>
                <span className="n">03</span>Authentication
              </h2>
              <p>
                Send your key as a bearer token. Add an <code>Idempotency-Key</code> on any request that
                charges credits: retries with the same key never double-charge.
              </p>
              <div className="code">
                <div className="ch">
                  <span>Headers</span>
                  <button data-copy-code>Copy</button>
                </div>
                <pre>
                  Authorization: Bearer gtt_live_••••••••{"\n"}
                  Idempotency-Key: 6f1c2a9e-3b2d-4a8e-9f10-7c2b4c1d0e55
                </pre>
              </div>
              <ul>
                <li>Keys are stored as hashes. The full key is shown once, when created.</li>
                <li>Keys can be labelled and revoked at any time from the app.</li>
                <li>Rate limits and an optional daily spending cap apply per key and per project.</li>
                <li>Never ship a key in client-side code.</li>
              </ul>
            </section>
          )}

          {visible.has("formations") && (
            <section id="formations">
              <h2>
                <span className="n">04</span>Formations
              </h2>
              <p>
                Each formation is exposed by ID. Text formations are also available as virtual models on
                the chat endpoint.
              </p>
              <div className="formgrid">
                <div>
                  <b>gattai/refine</b>
                  <p>
                    GPT <code>interpret</code> → Claude <code>execute</code>. Default chat. Streaming.
                  </p>
                </div>
                <div>
                  <b>gattai/research</b>
                  <p>
                    Perplexity <code>gather_sources</code> → Claude <code>write</code>. Report with
                    citations.
                  </p>
                </div>
                <div>
                  <b>gattai/code</b>
                  <p>
                    Claude <code>write</code> → GPT <code>review</code> → Claude <code>fix</code>.
                    Reviewed code.
                  </p>
                </div>
                <div>
                  <b>visual</b>
                  <p>
                    Claude <code>art_direction</code> → Higgsfield image. Async job.
                  </p>
                </div>
                <div>
                  <b>video</b>
                  <p>
                    Claude <code>script_and_shots</code> → Higgsfield video (e.g. Veo 3.1, Kling 3.0).
                    Async job.
                  </p>
                </div>
                <div>
                  <b>launch_kit</b>
                  <p>
                    Claude <code>copy_pack</code> → Higgsfield banner/PFP. Mixed.
                  </p>
                </div>
              </div>
              <div className="call">
                <b>Media formations</b> (<code>visual</code>, <code>video</code>, <code>launch_kit</code>)
                return a cost estimate first and only run after you confirm. They&apos;re available on the
                native runs API, not the chat endpoint.
              </div>
            </section>
          )}

          {visible.has("orchestration") && (
            <section id="orchestration">
              <h2>
                <span className="n">05</span>How a run flows
              </h2>
              <p>
                In <code>refine</code>, the interpreter turns your message into a structured brief. The
                executor always receives <b>your original message</b>, with the brief attached as advisory
                context. If the two conflict, your original request wins. If your prompt is already clear,
                the interpreter can pass it straight through.
              </p>
              <div className="code">
                <div className="ch">
                  <span>Interpreter brief (step 1 output)</span>
                  <button data-copy-code>Copy</button>
                </div>
                <pre>
                  {"{\n"}
                  {"  "}<span className="c2">&quot;pass_through&quot;</span>: <span className="c4">false</span>,
                  {"\n"}
                  {"  "}<span className="c2">&quot;goal&quot;</span>:{" "}
                  <span className="c3">&quot;What the user actually wants&quot;</span>,{"\n"}
                  {"  "}<span className="c2">&quot;deliverable&quot;</span>:{" "}
                  <span className="c3">&quot;Concrete output form&quot;</span>,{"\n"}
                  {"  "}<span className="c2">&quot;context&quot;</span>: [
                  <span className="c3">&quot;Relevant facts from the conversation&quot;</span>],{"\n"}
                  {"  "}<span className="c2">&quot;constraints&quot;</span>: [
                  <span className="c3">&quot;Stated or implied constraints&quot;</span>],{"\n"}
                  {"  "}<span className="c2">&quot;preserve_verbatim&quot;</span>: [
                  <span className="c3">&quot;Names, numbers, quotes&quot;</span>],{"\n"}
                  {"  "}<span className="c2">&quot;open_questions&quot;</span>: [],{"\n"}
                  {"  "}<span className="c2">&quot;style&quot;</span>: <span className="c3">&quot;Tone/format&quot;</span>,
                  {"\n"}
                  {"  "}<span className="c2">&quot;success_criteria&quot;</span>: [
                  <span className="c3">&quot;What a good answer looks like&quot;</span>]
                  {"\n}"}
                </pre>
              </div>
              <p>
                If a step fails, the next step never receives incomplete input. The one exception: in{" "}
                <code>refine</code>, a failed interpreter falls back to pass-through.
              </p>
            </section>
          )}

          {visible.has("chat") && (
            <section id="chat">
              <h2>
                <span className="n">06</span>Chat completions
              </h2>
              <div className="ep">
                <span className="m post">POST</span>
                <span>/v1/chat/completions</span>
                <span>OpenAI-compatible</span>
              </div>
              <p>
                Models: <code>gattai/refine</code>, <code>gattai/research</code>, <code>gattai/code</code>
                . Streaming is supported; final usage comes from the provider&apos;s usage report at the
                end of the stream.
              </p>
              <div className="code">
                <div className="ch">
                  <span>cURL</span>
                  <button data-copy-code>Copy</button>
                </div>
                <pre>
                  curl https://api.gattai.example/v1/chat/completions \{"\n"}
                  {"  "}-H <span className="c3">&quot;Authorization: Bearer $GATTAI_KEY&quot;</span> \{"\n"}
                  {"  "}-H <span className="c3">&quot;Idempotency-Key: $(uuidgen)&quot;</span> \{"\n"}
                  {"  "}-H <span className="c3">&quot;Content-Type: application/json&quot;</span> \{"\n"}
                  {"  "}-d <span className="c3">&apos;&#123;&quot;model&quot;:&quot;gattai/code&quot;,&quot;stream&quot;:true,&quot;messages&quot;:[&#123;&#123;&quot;role&quot;:&quot;user&quot;,&quot;content&quot;:&quot;debounce hook with cancel()&quot;&#125;&#125;]&apos;</span>
                </pre>
              </div>
              <div className="call">
                Compatibility with specific tools (Cursor, Claude Code and others) will be listed once each
                has been tested.
              </div>
            </section>
          )}

          {visible.has("runs") && (
            <section id="runs">
              <h2>
                <span className="n">07</span>Runs API
              </h2>
              <p>The native API runs any formation, including media, and exposes each step.</p>
              <div className="ep">
                <span className="m post">POST</span>
                <span>/v1/runs</span>
                <span>Run any formation, returns run_id</span>
              </div>
              <div className="ep">
                <span className="m get">GET</span>
                <span>/v1/runs/{"{id}"}</span>
                <span>Status, per-step output and cost</span>
              </div>
              <div className="ep">
                <span className="m get">GET</span>
                <span>/v1/runs/{"{id}"}/events</span>
                <span>SSE stream of step progress</span>
              </div>
              <div className="ep">
                <span className="m post">POST</span>
                <span>/v1/runs/{"{id}"}/confirm</span>
                <span>Confirm a media cost estimate</span>
              </div>
              <div className="ep">
                <span className="m get">GET</span>
                <span>/v1/recipes</span>
                <span>Formations (+ availability), price estimates</span>
              </div>
              <div className="ep">
                <span className="m get">GET</span>
                <span>/v1/public/formations</span>
                <span>Formation availability (no auth)</span>
              </div>
              <div className="ep">
                <span className="m get">GET</span>
                <span>/v1/balance</span>
                <span>Balance and credit lots</span>
              </div>
              <div className="ep">
                <span className="m get">GET</span>
                <span>/v1/usage</span>
                <span>Ledger and usage history</span>
              </div>
              <div className="ep">
                <span className="m post">POST</span>
                <span>/v1/keys</span>
                <span>Create a key</span>
              </div>
              <div className="ep">
                <span className="m del">DELETE</span>
                <span>/v1/keys/{"{id}"}</span>
                <span>Revoke a key</span>
              </div>
              <div className="ep">
                <span className="m get">GET</span>
                <span>/v1/public/burns</span>
                <span>Public burn stats (no auth)</span>
              </div>
              <div className="code">
                <div className="ch">
                  <span>Create a video run</span>
                  <button data-copy-code>Copy</button>
                </div>
                <pre>
                  curl https://api.gattai.example/v1/runs \{"\n"}
                  {"  "}-H <span className="c3">&quot;Authorization: Bearer $GATTAI_KEY&quot;</span> \{"\n"}
                  {"  "}-H <span className="c3">&quot;Idempotency-Key: $(uuidgen)&quot;</span> \{"\n"}
                  {"  "}-d <span className="c3">&apos;{"{"}&quot;recipe&quot;:&quot;video&quot;,&quot;input&quot;:&quot;8s teaser: modules docking into one core, 9:16&quot;{"}"}&apos;</span>
                  {"\n\n"}
                  <span className="c1"># → {"{ id: run_…, status: AWAITING_CONFIRMATION, estimate_credits: 120 }"}</span>
                  {"\n"}
                  curl -X POST https://api.gattai.example/v1/runs/run_…/confirm -H{" "}
                  <span className="c3">&quot;Authorization: Bearer $GATTAI_KEY&quot;</span>
                </pre>
              </div>
            </section>
          )}

          {visible.has("states") && (
            <section id="states">
              <h2>
                <span className="n">08</span>Run states
              </h2>
              <div className="states">
                <span>CREATED</span>
                <em>→</em>
                <span>RESERVED</span>
                <em>→</em>
                <span>STEP_n_PENDING</span>
                <em>→</em>
                <span>STEP_n_COMPLETE</span>
                <em>→</em>
                <span className="ok">SETTLED</span>
              </div>
              <div className="states">
                <span>STEP_n_PENDING</span>
                <em>↘</em>
                <span className="bad">STEP_n_FAILED</span>
                <em>→</em>
                <span>RELEASED</span>
              </div>
              <div className="states">
                <span>AWAITING_CONFIRMATION</span>
                <span style={{ borderStyle: "dashed" }}>media, before RESERVED</span>
                <span className="bad">INSUFFICIENT_BALANCE</span>
                <span style={{ borderStyle: "dashed" }}>rejected before running</span>
              </div>
            </section>
          )}

          {visible.has("errors") && (
            <section id="errors">
              <h2>
                <span className="n">09</span>Errors &amp; limits
              </h2>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Status</th>
                    <th>Code</th>
                    <th>When</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className="m">401</td>
                    <td className="m">invalid_key</td>
                    <td>Missing, malformed or revoked key.</td>
                  </tr>
                  <tr>
                    <td className="m">402</td>
                    <td className="m">insufficient_balance</td>
                    <td>Not enough credits for the estimate. Response includes a top-up link.</td>
                  </tr>
                  <tr>
                    <td className="m">409</td>
                    <td className="m">idempotency_conflict</td>
                    <td>Same Idempotency-Key reused with a different body.</td>
                  </tr>
                  <tr>
                    <td className="m">429</td>
                    <td className="m">rate_limited / spend_cap</td>
                    <td>Per-key rate limit or your daily cap was reached.</td>
                  </tr>
                  <tr>
                    <td className="m">503</td>
                    <td className="m">formation_unavailable</td>
                    <td>A provider this formation needs is down. Other formations keep working.</td>
                  </tr>
                </tbody>
              </table>
            </section>
          )}

          {visible.has("billing") && (
            <section id="billing">
              <h2>
                <span className="n">10</span>Credits &amp; billing
              </h2>
              <ol>
                <li>
                  <b>Estimate</b> the run from token estimates or a fixed media price.
                </li>
                <li>
                  <b>Reserve</b> the estimate plus a buffer. Too little balance → rejected before any model
                  is called.
                </li>
                <li>
                  <b>Run</b> the steps, recording provider cost per step.
                </li>
                <li>
                  <b>Settle</b>: charge = Σ provider cost × (1 + formation markup). The unused reservation
                  is released.
                </li>
              </ol>
              <p>
                Credit lots are consumed first-in, first-out, and each settlement records which lot was
                used. The charging policy for failed runs will be published before launch.
              </p>
            </section>
          )}

          {visible.has("topups") && (
            <section id="topups">
              <h2>
                <span className="n">11</span>Top-ups
              </h2>
              <p>
                Deposit ETH, USDG or $GATTAI on Robinhood Chain through the deposit contract. After enough
                confirmations, a credit lot is created.
              </p>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Token</th>
                    <th>Valued at</th>
                    <th>Credits</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className="m">USDG</td>
                    <td>1:1</td>
                    <td>List rate</td>
                  </tr>
                  <tr>
                    <td className="m">ETH</td>
                    <td>Price feed</td>
                    <td>List rate</td>
                  </tr>
                  <tr>
                    <td className="m">$GATTAI</td>
                    <td>Time-weighted pool price (not spot)</td>
                    <td>15% discount: $85 of $GATTAI buys $100 of credits</td>
                  </tr>
                </tbody>
              </table>
              <div className="call w">
                Chain ID, RPC and contract addresses will be published here at launch. Only use addresses
                from this page or the official channels.
              </div>
            </section>
          )}

          {visible.has("burns") && (
            <section id="burns">
              <h2>
                <span className="n">12</span>Public burns
              </h2>
              <p>
                Each epoch, a share of margin from settled runs buys back and burns $GATTAI (or burns
                treasury $GATTAI directly for runs paid in $GATTAI). Each epoch is published with its
                transaction hashes.
              </p>
              <div className="code">
                <div className="ch">
                  <span>GET /v1/public/burns</span>
                  <button data-copy-code>Copy</button>
                </div>
                <pre>
                  {"{\n"}
                  {"  "}<span className="c2">&quot;total_burned&quot;</span>: <span className="c3">&quot;…&quot;</span>,
                  {"\n"}
                  {"  "}<span className="c2">&quot;epochs&quot;</span>: [{"\n"}
                  {"    "}{"{{"} <span className="c2">&quot;id&quot;</span>: 12,{" "}
                  <span className="c2">&quot;period_start&quot;</span>: <span className="c3">&quot;…&quot;</span>,{" "}
                  <span className="c2">&quot;period_end&quot;</span>: <span className="c3">&quot;…&quot;</span>,{"\n"}
                  {"      "}<span className="c2">&quot;budget_usd&quot;</span>: <span className="c3">&quot;…&quot;</span>,{" "}
                  <span className="c2">&quot;tokens_burned&quot;</span>: <span className="c3">&quot;…&quot;</span>,{" "}
                  <span className="c2">&quot;tx_hashes&quot;</span>: [<span className="c3">&quot;0x…&quot;</span>] {"}}"}
                  {"\n  "}]{"\n}"}
                </pre>
              </div>
              <p>
                See it rendered on the{" "}
                <Link to="/burns" style={{ color: "var(--acc)" }}>
                  burn dashboard
                </Link>
                .
              </p>
            </section>
          )}
        </main>

        <aside className="side2">
          <div className="box">
            <h4>Need a key?</h4>
            <p>Create one in the app. It&apos;s shown once, then stored as a hash.</p>
            <Link to="/app/keys" className="btn btn-acc">
              Get your key
            </Link>
          </div>
          <div className="box" style={{ marginTop: 12 }}>
            <h4>Base URL</h4>
            <p className="mono" style={{ color: "var(--text)" }}>
              api.gattai.example/v1
            </p>
            <p>Placeholder until launch.</p>
          </div>
        </aside>
      </div>
    </>
  );
}
