import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { NeedLogin } from "./AppShell";
import { useSession } from "@/lib/use-session";
import { useGalleryEntries, type GalleryEntry } from "./galleryStore";
import { extractMedia } from "./media";
import { MediaOutput } from "./MediaOutput";
import type { RunInfo } from "@/lib/types";

/**
 * Galeri media dari run nyata (visual/video/launch_kit). Thumbnail memakai
 * placeholder generatif sesuai gaya visual; dialog menampilkan file asli
 * bila URL-nya tersedia.
 */

const HUES = [
  "rgba(255,91,31,.35)",
  "rgba(255,138,76,.28)",
  "rgba(120,150,200,.25)",
  "rgba(255,91,31,.22)",
  "rgba(200,200,190,.16)",
];

function seededRandom(seed: number, n: number): number {
  const x = Math.sin((seed * 1000 + n) * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

function artStyle(entry: GalleryEntry, displayAspect?: number): React.CSSProperties {
  const seed = entry.finishedAt % 100000;
  const r = (n: number) => seededRandom(seed, n);
  const aspect = displayAspect ?? (entry.recipe === "video" ? 9 / 16 : 1);
  return {
    ["--ar" as string]: aspect,
    ["--arr" as string]: aspect,
    ["--c1" as string]: HUES[Math.floor(r(1) * HUES.length)],
    ["--gx" as string]: `${20 + r(2) * 60}%`,
    ["--gy" as string]: `${20 + r(3) * 60}%`,
    ["--ang" as string]: `${Math.floor(r(4) * 360)}deg`,
    ["--gs" as string]: `${16 + Math.floor(r(5) * 20)}px`,
  };
}

function agoText(time: number): string {
  const seconds = (Date.now() - time) / 1000;
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function Artwork({ entry, animate }: { entry: GalleryEntry; animate?: boolean }) {
  const seed = entry.finishedAt % 100000;
  const spread = seededRandom(seed, 6) > 0.55;
  return (
    <div className={`art${spread ? " sp" : ""}${entry.recipe === "video" || animate ? " anim" : ""}`} style={artStyle(entry)}>
      <span className="q"></span>
      <span className="q"></span>
      <span className="q"></span>
      <span className="q"></span>
      {!spread && <span className="core"></span>}
      <span className="k">{entry.recipe.replace("_", " ").toUpperCase()}</span>
      {entry.recipe === "video" && (
        <span className="play">
          <svg width="10" height="12" viewBox="0 0 10 12">
            <path d="M0 0l10 6-10 6z" fill="#fff" />
          </svg>
        </span>
      )}
    </div>
  );
}

export function GalleryView() {
  const { session } = useSession();
  const entries = useGalleryEntries();
  const [filter, setFilter] = useState("all");
  const [openId, setOpenId] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDialogElement | null>(null);

  const openEntry = entries.find((item) => item.id === openId) ?? null;
  const { data: openRun } = useQuery({
    queryKey: ["run", session?.projectId, openId],
    queryFn: () => api<RunInfo>(`/v1/runs/${openId}`),
    enabled: Boolean(session && openId),
  });

  const items = useMemo(
    () => entries.filter((entry) => filter === "all" || entry.recipe === filter),
    [entries, filter],
  );

  if (!session) return <NeedLogin action="Gallery" />;

  return (
    <section className="view on" id="v-gallery">
      <div className="ghead">
        <div>
          <span className="eyebrow">Media gallery</span>
          <p className="muted" style={{ marginTop: 8, fontSize: 14 }}>
            Output from Visual, Video and Launch Kit runs.
          </p>
        </div>
        <div className="seg" id="gSeg">
          {["all", "visual", "video", "launch_kit"].map((kind) => (
            <button
              key={kind}
              data-g={kind}
              className={filter === kind ? "on" : undefined}
              onClick={() => setFilter(kind)}
            >
              {kind === "all" ? "All" : kind === "launch_kit" ? "Launch Kit" : kind[0].toUpperCase() + kind.slice(1)}
            </button>
          ))}
        </div>
      </div>

      <div className="gal" id="gal">
        {items.length === 0 && (
          <div className="empty" style={{ gridColumn: "1/-1" }}>
            Nothing here yet. Run a Visual, Video or Launch Kit formation in Chat.
          </div>
        )}
        {items.map((entry) => (
          <button
            key={entry.id}
            className="gcard"
            onClick={() => {
              setOpenId(entry.id);
              requestAnimationFrame(() => {
                const element = dialogRef.current;
                if (element && !element.open) element.showModal();
              });
            }}
          >
            <Artwork entry={entry} />
            <div className="meta">
              <b>{entry.prompt}</b>
              <span>
                {entry.recipe.replace("_", " ")} · {agoText(entry.finishedAt)}
              </span>
            </div>
          </button>
        ))}
      </div>

      <dialog id="artDlg" className="big" ref={dialogRef} onClose={() => setOpenId(null)}>
        <div className="dh">
          <h3 id="adTitle">
            {openEntry ? `${openEntry.recipe.replace("_", " ")} · ${openEntry.id}` : "Preview"}
          </h3>
          <button aria-label="Close" onClick={() => dialogRef.current?.close()}>
            ✕
          </button>
        </div>
        <div className="db" id="adBody">
          {openEntry && (
            <>
              {(() => {
                const media = openRun ? extractMedia(openRun.output) : null;
                if (!media) {
                  return (
                    <div
                      style={{
                        maxWidth: openEntry.recipe === "video" ? 300 : "100%",
                        margin: "0 auto",
                        width: "100%",
                      }}
                    >
                      <Artwork entry={openEntry} animate />
                    </div>
                  );
                }
                return <MediaOutput media={media} prompt={openEntry.prompt} />;
              })()}
              <p className="muted" style={{ fontSize: 14 }}>
                {openEntry.prompt}
              </p>
              {openRun && (
                <p className="muted mono" style={{ fontSize: 12 }}>
                  Status {openRun.status} · charged {(openRun.cost.charged_credits ?? 0).toFixed(2)} cr
                </p>
              )}
            </>
          )}
        </div>
      </dialog>
    </section>
  );
}
