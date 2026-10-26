import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api";
import { formatCredits, formatDuration, formatShortDateTime } from "@/lib/format";
import { Link } from "@/lib/router";
import { copyText, observeReveals, showToast } from "@/site/siteFx";
import { useDocumentMeta } from "@/site/useSite";
import { MarkdownText } from "@/site/app/MarkdownText";
import { isSafeMediaUrl } from "@/site/app/media";
import type { PublicRunResponse } from "@/lib/types";
import "../run.css";

/**
 * Halaman publik satu run yang di-share.
 *
 * Data dari `/v1/public/runs/:slug` sudah sempit: tanpa run/project id, wallet,
 * saldo, API key, biaya provider, atau id step. Halaman ini tidak pernah
 * meminta endpoint privat, jadi tautan tetap bisa dibuka tanpa login.
 */

const SLUG_PATTERN = /^[0-9a-f]{32}$/;

function origin(): string {
  if (typeof window === "undefined") return "https://www.gattai.tech";
  return window.location.origin;
}

function runDescription(run: PublicRunResponse): string {
  const steps = `${run.steps.length} ${run.steps.length === 1 ? "step" : "steps"}`;
  if (run.prompt) {
    const prompt = run.prompt.replace(/\s+/g, " ").trim();
    return `${prompt.length > 145 ? `${prompt.slice(0, 144)}…` : prompt} · ${steps} on GATTAI.`;
  }
  return `A ${run.formation.name} formation run: ${steps} on GATTAI.`;
}

function RunMedia({ media, prompt }: { media: PublicRunResponse["output"]["media"]; prompt: string }) {
  if (!media || !isSafeMediaUrl(media.url)) return null;
  if (media.type === "video") {
    return <video className="run-media" controls preload="metadata" src={media.url} />;
  }
  if (media.type === "audio") {
    return <audio className="run-audio" controls preload="metadata" src={media.url} />;
  }
  return <img className="run-media" src={media.url} alt={prompt || "Run output"} loading="lazy" />;
}

function RunSkeleton() {
  return (
    <section className="run-main">
      <div className="wrap run-grid">
        <div className="run-card run-skeleton">
          <span></span>
          <span></span>
          <span></span>
          <span></span>
        </div>
        <div className="run-card run-skeleton">
          <span></span>
          <span></span>
          <span></span>
        </div>
      </div>
    </section>
  );
}

export function RunPage({ slug }: { slug: string }) {
  const valid = SLUG_PATTERN.test(slug);
  const url = `${origin()}/run/${slug}`;

  const query = useQuery({
    queryKey: ["public-run", slug],
    queryFn: () => api<PublicRunResponse>(`/v1/public/runs/${slug}`),
    enabled: valid,
    staleTime: 60_000,
    retry: (count, error) => !(error instanceof ApiError && error.status === 404) && count < 2,
  });

  const run = query.data;
  const notFound = !valid || (query.error instanceof ApiError && query.error.status === 404);
  const failed = query.isError && !notFound;

  // Konten run baru muncul setelah fetch selesai; observer awal (saat skeleton)
  // tidak akan pernah melihat node [data-r] itu. Pasang ulang setelah data/404.
  useEffect(() => observeReveals(document), [run, notFound, failed]);

  useDocumentMeta({
    title: run
      ? `${run.formation.name} · Shared run · GATTAI`
      : notFound
        ? "Run not found · GATTAI"
        : "Shared run · GATTAI",
    description: run
      ? runDescription(run)
      : notFound
        ? "This shared run does not exist or has been revoked."
        : "A run shared from GATTAI.",
    image: notFound ? `${origin()}/og-default.png` : `${url}/og.png`,
    url,
    type: notFound ? "website" : "article",
    noindex: notFound,
  });

  if (notFound) {
    return (
      <section className="run-main">
        <div className="wrap">
          <div className="run-empty" data-r>
            <span className="eyebrow">Shared run</span>
            <h1>This run isn’t available.</h1>
            <p>
              The link may have been revoked, or the run never existed. Shared runs are only
              available while their owner keeps the link active.
            </p>
            <div className="run-actions">
              <Link to="/" className="btn btn-acc">
                Back to GATTAI
              </Link>
              <Link to="/app/chat" className="btn btn-dark">
                Open the app
              </Link>
            </div>
          </div>
        </div>
      </section>
    );
  }

  if (query.isPending) return <RunSkeleton />;

  if (failed || !run) {
    return (
      <section className="run-main">
        <div className="wrap">
          <div className="run-empty" data-r>
            <span className="eyebrow">Shared run</span>
            <h1>Couldn’t load this run.</h1>
            <p>The share service didn’t answer. The link itself is probably fine. Try again.</p>
            <button className="btn btn-acc" onClick={() => void query.refetch()}>
              Retry
            </button>
          </div>
        </div>
      </section>
    );
  }

  const promptHref = `/app/chat?f=${encodeURIComponent(run.formation.id)}${
    run.prompt ? `&prompt=${encodeURIComponent(run.prompt)}` : ""
  }`;
  const outputText = run.output.content?.trim() || "";
  const media = run.output.media;

  return (
    <>
      <header className="phead run-hero">
        <div className="wrap">
          <span className="eyebrow" data-r>
            Shared run
          </span>
          <div className="run-title-row" data-r="2">
            <h1>{run.formation.name}</h1>
            <span className="run-mode">{run.formation.mode}</span>
          </div>
          <p className="run-lede" data-r="3">
            {run.steps.length} {run.steps.length === 1 ? "step" : "steps"} ·{" "}
            {formatCredits(run.cost.credits)} credits · {formatShortDateTime(run.created_at)}
          </p>
          <div className="run-actions" data-r="4">
            <Link to={promptHref} className="btn btn-acc">
              {run.prompt ? "Run this formation" : "Try this formation"}
            </Link>
            <button
              className="btn btn-dark"
              onClick={() => {
                void copyText(`${url}`).then((ok) => {
                  if (ok) showToast("Link copied");
                });
              }}
            >
              Copy link
            </button>
          </div>
        </div>
      </header>

      <section className="run-main">
        <div className="wrap run-grid">
          <article className="run-card run-result" data-r>
            <div className="run-card-head">
              <h2>Result</h2>
              <span className="run-status">Settled</span>
            </div>

            {run.prompt ? (
              <div className="run-prompt">
                <span>Original request</span>
                <p>{run.prompt}</p>
              </div>
            ) : (
              <p className="run-hidden-prompt">The author hid the original prompt for this run.</p>
            )}

            {outputText ? (
              <MarkdownText text={outputText} className="run-md" />
            ) : media ? null : (
              <p className="run-muted">This run has no text output.</p>
            )}

            <RunMedia media={media} prompt={run.prompt ?? "Run output"} />
          </article>

          <aside className="run-side">
            <div className="run-card" data-r="2">
              <div className="run-card-head">
                <h2>Formation</h2>
                <span className="run-step-count">
                  {run.steps.length} {run.steps.length === 1 ? "step" : "steps"}
                </span>
              </div>
              <ol className="run-steps">
                {run.steps.map((step, index) => (
                  <li key={`${step.role}-${index}`}>
                    <details>
                      <summary>
                        <span className="run-step-index">{String(index + 1).padStart(2, "0")}</span>
                        <span className="run-step-main">
                          <b>{step.role_label}</b>
                          <small>{step.provider}</small>
                        </span>
                        <span className="run-step-time">{formatDuration(step.duration_ms)}</span>
                      </summary>
                      {step.summary ? <p>{step.summary}</p> : null}
                    </details>
                  </li>
                ))}
              </ol>
            </div>

            <div className="run-card run-trust" data-r="3">
              <span className="eyebrow">Public by design</span>
              <p>
                Shared runs show the formation, steps, and result. Wallet addresses, balances, API
                keys, internal IDs, and raw provider costs are never included.
              </p>
              <Link to="/burns">See the onchain burn dashboard →</Link>
            </div>
          </aside>
        </div>
      </section>
    </>
  );
}
