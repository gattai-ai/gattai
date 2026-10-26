import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api";
import { errorMessage } from "@/lib/error-message";
import { formatCredits } from "@/lib/format";
import { copyText, showToast } from "@/site/siteFx";
import type { RunInfo, ShareResponse } from "@/lib/types";

/**
 * Dialog share run. Link dibuat hanya setelah user menekan tombol — membuka
 * dialog lalu menutupnya tidak boleh diam-diam menerbitkan URL publik.
 *
 * `GET /v1/runs/:id/share` dipakai untuk menampilkan share yang sudah aktif
 * (mis. dibuka lagi dari History), sedangkan POST idempoten dipakai untuk
 * membuat link baru atau mengubah toggle prompt.
 */
export function ShareDialog({
  runId,
  title,
  onClose,
}: {
  runId: string;
  title?: string | null;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const [showPrompt, setShowPrompt] = useState(true);
  const [share, setShare] = useState<ShareResponse | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const runQuery = useQuery({
    queryKey: ["run", runId],
    queryFn: () => api<RunInfo>(`/v1/runs/${runId}`),
    staleTime: 15_000,
    retry: (count, error) => !(error instanceof ApiError && error.status === 404) && count < 1,
  });

  const shareQuery = useQuery({
    queryKey: ["run-share", runId],
    queryFn: () => api<{ share: ShareResponse | null }>(`/v1/runs/${runId}/share`),
    staleTime: 0,
  });

  useEffect(() => {
    if (shareQuery.data?.share) {
      setShare(shareQuery.data.share);
      setShowPrompt(shareQuery.data.share.show_prompt);
    } else if (shareQuery.isSuccess) {
      setShare(null);
    }
  }, [shareQuery.data, shareQuery.isSuccess]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const save = useMutation({
    mutationFn: (nextShowPrompt: boolean) =>
      api<ShareResponse>(`/v1/runs/${runId}/share`, {
        method: "POST",
        body: { show_prompt: nextShowPrompt },
      }),
    onSuccess: (data) => {
      setShare(data);
      setShowPrompt(data.show_prompt);
      setActionError(null);
      client.setQueryData(["run-share", runId], { share: data });
      void client.invalidateQueries({ queryKey: ["conversations"] });
    },
    onError: (cause) => setActionError(errorMessage(cause, "Could not create the share link.")),
  });

  const revoke = useMutation({
    mutationFn: () => api<void>(`/v1/runs/${runId}/share`, { method: "DELETE" }),
    onSuccess: () => {
      setShare(null);
      setActionError(null);
      client.setQueryData(["run-share", runId], { share: null });
      void client.invalidateQueries({ queryKey: ["conversations"] });
      showToast("Share link revoked");
    },
    onError: (cause) => setActionError(errorMessage(cause, "Could not revoke the share link.")),
  });

  function toggle(next: boolean) {
    setShowPrompt(next);
    // Share yang sudah aktif langsung disimpan supaya link yang beredar tidak
    // menampilkan prompt yang baru saja disembunyikan.
    if (share) save.mutate(next);
  }

  function postToX() {
    if (!share) return;
    const text = `${runQuery.data?.recipe ?? title ?? "A GATTAI run"} · made with GATTAI`;
    const url = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(share.url)}`;
    window.open(url, "_blank", "noopener,noreferrer");
  }

  const run = runQuery.data;
  const stepCount = run?.steps?.length ?? 0;
  const busy = save.isPending || revoke.isPending;

  return (
    <div className="share-backdrop" onMouseDown={onClose}>
      <div
        className="share-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="share-head">
          <div>
            <span className="eyebrow">Share</span>
            <h2 id="share-title">Publish this run</h2>
          </div>
          <button className="share-close" aria-label="Close share dialog" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="share-preview">
          <div className="share-preview-top">
            <span className="share-chip">{run?.recipe ?? title ?? "GATTAI run"}</span>
            <span className="share-meta">
              {stepCount > 0 ? `${stepCount} steps · ` : ""}
              {run ? `${formatCredits(run.cost.charged_credits)} cr` : "settled"}
            </span>
          </div>
          <p>
            {showPrompt
              ? run?.input || "The prompt is hidden until the run details load."
              : "Prompt hidden. Visitors will see the formation, steps, and result only."}
          </p>
          <small>gattai.tech/run/…</small>
        </div>

        <label className="share-toggle">
          <input
            type="checkbox"
            checked={showPrompt}
            disabled={busy || shareQuery.isPending}
            onChange={(event) => toggle(event.target.checked)}
          />
          <span>
            <b>Show prompt</b>
            <small>Turn off to publish the result without the original request.</small>
          </span>
        </label>

        {actionError ? <p className="share-error">{actionError}</p> : null}

        {share ? (
          <>
            <div className="share-link">
              <input readOnly value={share.url} aria-label="Share link" onFocus={(e) => e.target.select()} />
              <button
                className="btn btn-acc btn-sm"
                onClick={() => {
                  void copyText(share.url).then((ok) => {
                    if (ok) showToast("Link copied");
                  });
                }}
              >
                Copy
              </button>
            </div>
            <div className="share-actions">
              <button className="btn btn-dark btn-sm" onClick={postToX}>
                Post to X
              </button>
              <button
                className="btn btn-dark btn-sm share-danger"
                disabled={busy}
                onClick={() => revoke.mutate()}
              >
                {revoke.isPending ? "Revoking…" : "Revoke link"}
              </button>
            </div>
            <p className="share-note">
              Anyone with the link can view this run. Revoke it any time. The old URL stops working.
            </p>
          </>
        ) : (
          <>
            <button
              className="btn btn-acc"
              disabled={busy || shareQuery.isPending || runQuery.isError}
              onClick={() => save.mutate(showPrompt)}
            >
              {save.isPending ? "Creating link…" : "Create public link"}
            </button>
            <p className="share-note">
              Only settled runs can be shared. No wallet, balance, API key, or provider cost is exposed.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
