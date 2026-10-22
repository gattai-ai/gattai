import type { RunMedia } from "./media";

/**
 * Render output media run (gambar/video/audio) dengan aman.
 * Tanpa URL valid: fallback teks eksplisit, bukan kartu kosong.
 */
export function MediaOutput({ media, prompt }: { media: RunMedia | null; prompt: string }) {
  if (!media) {
    return <p className="simnote">No media output for this run yet.</p>;
  }

  return (
    <div className="media">
      {media.type === "video" ? (
        <video controls preload="metadata" style={{ maxWidth: "100%", borderRadius: 12 }} src={media.url}>
          Your browser does not support video.
        </video>
      ) : media.type === "audio" ? (
        <audio controls preload="metadata" src={media.url} style={{ width: "100%" }} />
      ) : (
        <img
          src={media.url}
          alt={prompt}
          loading="lazy"
          style={{ maxWidth: "100%", borderRadius: 12, display: "block" }}
        />
      )}
      <div style={{ width: "100%" }}>
        <a
          href={media.url}
          target="_blank"
          rel="noreferrer"
          className="mono"
          style={{ fontSize: 11.5, color: "var(--acc)" }}
        >
          Open original file ↗
        </a>
      </div>
    </div>
  );
}
