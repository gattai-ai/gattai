import { useEffect, useState } from "react";
import { useRouter } from "@/lib/router-context";
import { useSession } from "@/lib/use-session";
import {
  useConversations,
  useDeleteConversation,
  useRenameConversation,
} from "@/features/chat/useConversations";
import { formatShortDateTime } from "@/lib/format";
import { ApiError } from "@/lib/api";
import { errorMessage } from "@/lib/error-message";
import { NeedLogin } from "./AppShell";
import type { ConversationSummary } from "@/lib/types";

/**
 * Riwayat percakapan milik project, urut aktivitas terbaru.
 *
 * Ini satu-satunya tempat berpindah percakapan. Transkripnya dibuka di
 * `ChatView` lewat URL `/app/chat/<id>`, dan isinya tetap dibaca dari server —
 * klien tidak menyimpan salinan, jadi membuka chat lama dari perangkat lain
 * menampilkan hal yang sama.
 *
 * Judul bisa diganti inline dan percakapan bisa dihapus, keduanya lewat endpoint
 * `PATCH`/`DELETE` backend. Penghapusan butuh konfirmasi karena tidak bisa
 * dibatalkan dan ikut menghapus pesan percakapan.
 */

/** Panjang judul maksimum — cermin `renameSchema` di backend (`PATCH /v1/conversations`). */
const TITLE_MAX = 80;

/** Jeda sebelum ketikan pencarian dikirim ke server (ms). */
const SEARCH_DEBOUNCE_MS = 300;

/** Pesan ramah untuk kegagalan ganti judul; kode mentah backend tidak ditampilkan. */
function renameErrorMessage(cause: unknown): string {
  if (cause instanceof ApiError && cause.code === "VALIDATION_ERROR") {
    return "Enter a title of up to 80 characters.";
  }
  if (cause instanceof ApiError && cause.status === 404) return "That chat no longer exists.";
  return errorMessage(cause, "Could not rename the chat. Try again.");
}

/** Pesan ramah untuk kegagalan hapus. */
function deleteErrorMessage(cause: unknown): string {
  if (cause instanceof ApiError && cause.code === "CONVERSATION_ACTIVE") {
    return "This chat has a run in progress. Wait for it to finish.";
  }
  return errorMessage(cause, "Could not delete the chat. Try again.");
}

export function HistoryView() {
  const { session } = useSession();
  const { navigate } = useRouter();
  /** Nilai kotak pencarian (langsung) dan versi yang sudah di-debounce. */
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const { data, isPending, isError, hasNextPage, fetchNextPage, isFetchingNextPage } =
    useConversations(debouncedSearch);
  const rename = useRenameConversation();
  const remove = useDeleteConversation();

  /** Baris yang sedang diganti judulnya, beserta nilai input-nya. */
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  /** Baris yang sedang menunggu konfirmasi hapus. */
  const [removingId, setRemovingId] = useState<string | null>(null);
  /** Pesan error inline, terikat pada satu baris. */
  const [actionError, setActionError] = useState<{ id: string; message: string } | null>(null);

  // Ketikan cepat tidak boleh memicu satu request per huruf.
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [search]);

  if (!session) return <NeedLogin action="History" />;

  // Semua halaman yang sudah diambil, diurutkan backend (terbaru dulu).
  const conversations: ConversationSummary[] =
    data?.pages.flatMap((page) => page.conversations) ?? [];

  function beginRename(item: ConversationSummary) {
    setActionError(null);
    setRemovingId(null);
    setRenameValue(item.title ?? "");
    setRenamingId(item.id);
  }

  function closeRename() {
    setRenamingId(null);
    setRenameValue("");
  }

  function submitRename(id: string) {
    const title = renameValue.trim();
    if (!title || rename.isPending) return;
    setActionError(null);
    rename.mutate(
      { id, title },
      {
        onSuccess: () => setRenamingId(null),
        onError: (cause) => setActionError({ id, message: renameErrorMessage(cause) }),
      },
    );
  }

  function beginDelete(id: string) {
    setActionError(null);
    setRenamingId(null);
    setRemovingId(id);
  }

  function confirmDelete(id: string) {
    setActionError(null);
    remove.mutate(id, {
      onSuccess: () => setRemovingId(null),
      onError: (cause) => {
        // 404 = sudah tidak ada (mis. dihapus di tab lain) → perlakukan sebagai sukses.
        if (cause instanceof ApiError && cause.status === 404) {
          setRemovingId(null);
          return;
        }
        setActionError({ id, message: deleteErrorMessage(cause) });
      },
    });
  }

  function rowError(id: string): string | null {
    return actionError?.id === id ? actionError.message : null;
  }

  return (
    <section className="view on" id="v-history">
      <div className="ghead">
        <div>
          <span className="eyebrow">History</span>
          <p className="muted" style={{ marginTop: 8, fontSize: 14 }}>
            Every conversation this project has run, most recent first.
          </p>
        </div>
        <button className="btn btn-acc btn-sm" onClick={() => navigate("/app/chat")}>
          New chat
        </button>
      </div>

      <div className="box" style={{ padding: "10px 10px 6px" }}>
        <div className="chsearch">
          <input
            type="search"
            aria-label="Search chats"
            placeholder="Search chats…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        {isPending && !data ? (
          <p className="chnote">Loading your chats…</p>
        ) : isError ? (
          <p className="chnote">Could not load your chats. Try again in a moment.</p>
        ) : conversations.length === 0 ? (
          debouncedSearch ? (
            <p className="chnote">
              No chats match “{debouncedSearch}”.{" "}
              <button
                type="button"
                className="linkbtn"
                onClick={() => {
                  setSearch("");
                  setDebouncedSearch("");
                }}
              >
                Clear
              </button>
            </p>
          ) : (
            <p className="chnote">No chats yet. Send a prompt and it will show up here.</p>
          )
        ) : (
          <div className="chlist">
            {conversations.map((item) => {
              // `title` nullable di DB; baris tanpa judul ditampilkan apa adanya.
              const title = item.title ?? "New chat";
              const error = rowError(item.id);

              if (renamingId === item.id) {
                return (
                  <div key={item.id} className="chitem">
                    <form
                      className="chrename"
                      onSubmit={(event) => {
                        event.preventDefault();
                        submitRename(item.id);
                      }}
                    >
                      <input
                        // Fokus otomatis: editor muncul karena user memilih "Rename".
                        autoFocus
                        aria-label="Chat title"
                        maxLength={TITLE_MAX}
                        value={renameValue}
                        onChange={(event) => setRenameValue(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Escape") {
                            event.preventDefault();
                            closeRename();
                          }
                        }}
                      />
                      <button
                        type="submit"
                        className="btn btn-acc btn-sm"
                        disabled={!renameValue.trim() || rename.isPending}
                      >
                        {rename.isPending ? "Saving…" : "Save"}
                      </button>
                      <button type="button" className="btn btn-dark btn-sm" onClick={closeRename}>
                        Cancel
                      </button>
                    </form>
                    {error ? <p className="chmsg">{error}</p> : null}
                  </div>
                );
              }

              if (removingId === item.id) {
                return (
                  <div key={item.id} className="chitem">
                    <div className="chconfirm">
                      <span>Delete “{title}”? This cannot be undone.</span>
                      <span className="sp"></span>
                      <button
                        className="btn btn-dark btn-sm"
                        disabled={remove.isPending}
                        onClick={() => setRemovingId(null)}
                      >
                        Cancel
                      </button>
                      <button
                        className="btn btn-acc btn-sm"
                        disabled={remove.isPending}
                        onClick={() => confirmDelete(item.id)}
                      >
                        {remove.isPending ? "Deleting…" : "Delete"}
                      </button>
                    </div>
                    {error ? <p className="chmsg">{error}</p> : null}
                  </div>
                );
              }

              return (
                <div key={item.id} className="chitem">
                  <div className="chrow">
                    <button
                      className="chmain"
                      // Judul dipotong dengan elipsis oleh CSS; `title` menjaga teks
                      // lengkapnya tetap bisa dibaca.
                      title={title}
                      onClick={() => navigate(`/app/chat/${item.id}`)}
                    >
                      <b>{title}</b>
                      <span>
                        {item.run_count} {item.run_count === 1 ? "run" : "runs"} ·{" "}
                        {formatShortDateTime(item.last_run_at ?? item.created_at)}
                      </span>
                    </button>
                    <div className="chacts">
                      <button
                        className="chact"
                        title="Rename"
                        aria-label={`Rename ${title}`}
                        onClick={() => beginRename(item)}
                      >
                        Rename
                      </button>
                      <button
                        className="chact danger"
                        title="Delete"
                        aria-label={`Delete ${title}`}
                        onClick={() => beginDelete(item.id)}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                  {error ? <p className="chmsg">{error}</p> : null}
                </div>
              );
            })}
          </div>
        )}

        {hasNextPage ? (
          <div style={{ padding: "8px 4px 2px" }}>
            <button
              className="btn btn-dark btn-sm"
              disabled={isFetchingNextPage}
              onClick={() => void fetchNextPage()}
            >
              {isFetchingNextPage ? "Loading…" : "Load more"}
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
