import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { formatRelativeTime } from "@/lib/format";
import { Link } from "@/lib/router";
import { copyText } from "@/site/siteFx";
import { NeedLogin } from "./AppShell";
import { useSession } from "@/lib/use-session";
import { walletErrorMessage } from "@/lib/wallet-error";
import type { ApiKeyListResponse, CreatedApiKey } from "@/lib/types";

/**
 * Manajemen API key dengan tampilan situs statis: tabel + dialog + snippet
 * curl. Key lengkap hanya ditampilkan sekali (dari backend nyata).
 */

export function KeysView() {
  const { session } = useSession();
  const queryClient = useQueryClient();
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const [dialog, setDialog] = useState<{ mode: "create" } | { mode: "created"; secret: string } | null>(null);
  const [label, setLabel] = useState("");
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);

  const { data } = useQuery({
    queryKey: ["keys", session?.projectId],
    queryFn: () => api<ApiKeyListResponse>("/v1/keys"),
    enabled: Boolean(session),
  });

  const createMutation = useMutation({
    mutationFn: (keyLabel: string) =>
      api<CreatedApiKey>("/v1/keys", { method: "POST", body: { label: keyLabel || undefined } }),
    onSuccess: (key) => {
      setLabel("");
      setDialog({ mode: "created", secret: key.secret });
      void queryClient.invalidateQueries({ queryKey: ["keys"] });
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (id: string) => api(`/v1/keys/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      setConfirmRevoke(null);
      void queryClient.invalidateQueries({ queryKey: ["keys"] });
    },
  });

  useEffect(() => {
    const element = dialogRef.current;
    if (!element) return;
    if (dialog && !element.open) element.showModal();
    if (!dialog && element.open) element.close();
  }, [dialog]);

  if (!session) return <NeedLogin action="Keys" />;

  const keys = data?.keys ?? [];
  const active = keys.find((key) => !key.revoked_at);

  return (
    <section className="view on" id="v-keys">
      <div className="keytop">
        <div>
          <span className="eyebrow">API keys</span>
          <p style={{ marginTop: 10 }}>
            Use a key in the app or in any OpenAI-compatible client. Keys are stored hashed, the full
            key is shown only once, when you create it.
          </p>
        </div>
        <button
          className="btn btn-acc"
          id="newKey"
          onClick={() => {
            setLabel("");
            setDialog({ mode: "create" });
          }}
        >
          + Create key
        </button>
      </div>

      <div className="box" style={{ padding: "8px 8px 4px" }}>
        <div className="tscroll">
          <table className="tbl">
            <thead>
              <tr>
                <th>Label</th>
                <th>Key</th>
                <th>Created</th>
                <th>Last used</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody id="keyRows">
              {keys.length === 0 && (
                <tr>
                  <td colSpan={6} className="muted">
                    No keys yet: create your first key above.
                  </td>
                </tr>
              )}
              {keys.map((key) => (
                <tr key={key.id} className={key.revoked_at ? "revoked" : ""}>
                  <td>{key.label}</td>
                  <td className="m">{key.prefix}…</td>
                  <td className="m">{formatRelativeTime(key.created_at)}</td>
                  <td className="m">{key.last_used_at ? formatRelativeTime(key.last_used_at) : "never"}</td>
                  <td>
                    <span className={`st ${key.revoked_at ? "dim" : "ok"}`}>
                      {key.revoked_at ? "REVOKED" : "ACTIVE"}
                    </span>
                  </td>
                  <td className="num">
                    {!key.revoked_at && (
                      <button
                        className={`rv${confirmRevoke === key.id ? " sure" : ""}`}
                        onClick={() => {
                          if (confirmRevoke !== key.id) {
                            setConfirmRevoke(key.id);
                            window.setTimeout(() => {
                              setConfirmRevoke((current) => (current === key.id ? null : current));
                            }, 3000);
                            return;
                          }
                          revokeMutation.mutate(key.id);
                        }}
                      >
                        {confirmRevoke === key.id ? "Confirm" : "Revoke"}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="code" style={{ marginTop: 22 }}>
        <div className="ch">
          <span>Quick test</span>
          <button data-copy-code>Copy</button>
        </div>
        <pre id="keySnippet">
          {`curl https://api.gattai.example/v1/chat/completions \\
  -H "Authorization: Bearer ${active ? `${active.prefix}…` : "gtt_live_…"}" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"gattai/refine","messages":[{"role":"user","content":"Hello, formation"}]}'`}
        </pre>
      </div>
      <p className="muted" style={{ fontSize: 13.5 }}>
        Full reference in the <Link to="/docs" style={{ color: "var(--acc)" }}>docs</Link>.
      </p>

      <dialog id="keyDlg" ref={dialogRef} onClose={() => setDialog(null)}>
        <div className="dh">
          <h3 id="kdTitle">{dialog?.mode === "created" ? "Your new key" : "Create API key"}</h3>
          <button aria-label="Close" onClick={() => setDialog(null)}>
            ✕
          </button>
        </div>
        {dialog?.mode === "create" && (
          <>
            <div className="db" id="kdBody">
              <div className="field">
                <label htmlFor="kl">Label</label>
                <input
                  className="inp"
                  id="kl"
                  placeholder="e.g. cursor-laptop"
                  maxLength={40}
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                />
              </div>
              <p className="muted" style={{ fontSize: 13.5 }}>
                Keys can call every formation and draw from this project&apos;s balance.
              </p>
              {createMutation.isError && (
                <div className="errbox">
                  {walletErrorMessage(createMutation.error, "Could not create the key.")}
                </div>
              )}
            </div>
            <div className="df" id="kdFoot">
              <button className="btn btn-dark" onClick={() => setDialog(null)}>
                Cancel
              </button>
              <button
                className="btn btn-acc"
                disabled={createMutation.isPending}
                onClick={() => createMutation.mutate(label.trim() || "untitled")}
              >
                {createMutation.isPending ? "Creating…" : "Create key"}
              </button>
            </div>
          </>
        )}
        {dialog?.mode === "created" && (
          <>
            <div className="db">
              <div className="keyshow">{dialog.secret}</div>
              <div className="warn">
                Copy it now. This is the only time the full key is shown. GATTAI stores only a hash.
              </div>
            </div>
            <div className="df">
              <button className="btn btn-dark" onClick={() => void copyText(dialog.secret)}>
                Copy key
              </button>
              <button className="btn btn-acc" onClick={() => setDialog(null)}>
                Done
              </button>
            </div>
          </>
        )}
      </dialog>
    </section>
  );
}
