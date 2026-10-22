import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api";
import { errorMessage, statusLabel, topupHref } from "@/lib/error-message";
import { displayStepLabel, displayStepRole } from "@/lib/provider-label";
import { Link } from "@/lib/router";
import { useRunStream, type StreamStep } from "@/features/chat/useRunStream";
import { useRecipes } from "@/features/chat/useRecipes";
import { useConversation } from "@/features/chat/useConversations";
import { pathnameOf, useRouter } from "@/lib/router-context";
import { copyText } from "@/site/siteFx";
import { addGalleryEntry } from "./galleryStore";
import { extractMedia, type RunMedia } from "./media";
import { MediaOutput } from "./MediaOutput";
import { MarkdownText } from "./MarkdownText";
import { readCapSettings, useSpentToday } from "./cap";
import { NeedLogin } from "./AppShell";
import { useSession } from "@/lib/use-session";
import { useTrialQuota } from "./useAppShell";
import type { ConversationDetailResponse, Recipe, RunCreateResponse, RunInfo } from "@/lib/types";

/**
 * Chat GATTAI dengan tampilan situs statis: segmen formation, thread kartu
 * run, panel "under the hood", dan konfirmasi media. Demo disimulasikan
 * diganti run backend nyata (POST /v1/runs + SSE).
 */

/**
 * Pesan error yang aman tampil. Kode mentah backend dipetakan ke kalimat ramah
 * (atau pesan yang ditulis server), sedangkan error lain (mis. `fetch` gagal,
 * wallet) lewat `walletErrorMessage` — semuanya tanpa prefiks kode mentah.
 */
function turnErrorMessage(cause: unknown): string {
  return errorMessage(cause, "The run could not be started. Try again.");
}

interface TurnStep {
  id: string;
  who: string;
  role: string;
  status: "pending" | "run" | "done" | "fail";
  cost: number | null;
}

interface Turn {
  /** Kunci React stabil: `run_id` server atau `live-<n>` untuk turn optimistis. */
  key: string;
  /** `created_at` run di server; bagian dari kursor pagination transkrip. */
  createdAt: string;
  prompt: string;
  recipeId: string;
  recipeName: string;
  runId: string | null;
  status: string;
  statusTone: "dim" | "acc" | "ok" | "bad";
  routerLine: string;
  steps: TurnStep[];
  text: string;
  code: boolean;
  media: RunMedia | null;
  charged: number | null;
  /** Run ini dibiayai kuota gratis, bukan credit (dari backend). */
  isTrial: boolean;
  error: string | null;
  /** Aksi opsional di bawah pesan error (mis. tombol "Top up" pada 402). */
  errorCta?: { to: string; label: string } | null;
}

const SUGGESTIONS: Array<{ tag: string; prompt: string }> = [
  { tag: "Refine", prompt: "Rewrite our landing headline so it's sharper, give 3 options." },
  { tag: "Research", prompt: "Research and cite: how do onchain buyback programs usually report their burns?" },
  { tag: "Code", prompt: "Write a TypeScript function that retries a fetch with exponential backoff." },
  { tag: "Video", prompt: "Make an 8 second vertical video: four steel modules docking into one glowing core." },
];

/**
 * Formasi media — cermin **persis** gerbang kuota backend, yang memakai
 * `recipe.mode !== "streaming"` (lihat `create-run.ts`). Diturunkan dari `mode`
 * yang memang dikirim backend, bukan daftar id yang di-hardcode di sini, supaya
 * resep media baru tidak diam-diam lolos dari peringatan jatah media.
 */
function isMediaRecipe(recipe: Recipe): boolean {
  return recipe.mode !== "streaming";
}

/**
 * Resep yang berhenti sejenak untuk konfirmasi biaya. Dipakai untuk memutuskan
 * kapan modal pra-kirim muncul, jadi syaratnya harus sama dengan keputusan
 * backend (`pricing.requires_confirmation`), bukan "sedang gratis atau tidak" —
 * formasi media berbayar pun tetap lewat modal.
 */
function needsCostConfirm(recipe: Recipe): boolean {
  return recipe.pricing.requires_confirmation;
}

function shortId(id: string): string {
  return id.length > 18 ? `${id.slice(0, 12)}…${id.slice(-4)}` : id;
}

/** Idempotency key; fallback bila `crypto.randomUUID` tak tersedia (non-secure context). */
function newIdempotencyKey(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    // abaikan, pakai fallback di bawah
  }
  return `idem-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

function readInitialFormation(search: string): string {
  const params = new URLSearchParams(search);
  const formation = params.get("f");
  return formation && formation !== "auto" ? formation : "auto";
}

/**
 * Bentuk id percakapan yang sah — cermin `CONVERSATION_ID_PATTERN` di backend.
 * Id di URL yang tidak cocok diabaikan (dianggap chat baru) supaya tautan
 * ngawur tidak memicu permintaan 404 berulang.
 */
const CONVERSATION_ID_PATTERN = /^conv_[0-9a-f]{32}$/;

/** Id percakapan dari path `/app/chat/<id>` (segmen ketiga), atau null. */
function conversationIdFromPath(location: string): string | null {
  const segments = pathnameOf(location).split("/").filter(Boolean);
  if (segments[0] !== "app" || segments[1] !== "chat") return null;
  const id = segments[2];
  return id && CONVERSATION_ID_PATTERN.test(id) ? id : null;
}

/**
 * Id resep dari server dipakai di `routerLine` yang dirender sebagai HTML, jadi
 * disaring dulu: hanya slug yang lolos, sisanya jadi `unknown`.
 */
function safeRecipeId(id: string): string {
  return /^[a-z0-9_-]{1,32}$/.test(id) ? id : "unknown";
}

/** Warna badge status: selesai hijau, masih berjalan/menunggu aksen, gagal merah. */
function toneForStatus(status: string): Turn["statusTone"] {
  if (status === "SETTLED") return "ok";
  if (["CREATED", "RESERVED", "RUNNING", "AWAITING_CONFIRMATION"].includes(status)) return "acc";
  return "bad";
}

/** Teks akhir dari `output` run formasi teks, atau null. */
function textFromOutput(output: unknown): string | null {
  if (typeof output !== "object" || output === null) return null;
  const content = (output as Record<string, unknown>).content;
  return typeof content === "string" && content ? content : null;
}

/** Bentuk `Turn` dari satu run server (dipakai hidrasi & pagination transkrip). */
function toTurn(run: RunInfo, recipeById: (id: string) => Recipe | undefined): Turn {
  return {
    key: run.run_id,
    createdAt: run.created_at,
    prompt: run.input,
    recipeId: run.recipe,
    recipeName: recipeById(run.recipe)?.name ?? run.recipe,
    runId: run.run_id,
    status: run.status,
    statusTone: toneForStatus(run.status),
    routerLine: `FORMATION → <b>gattai/${safeRecipeId(run.recipe)}</b>`,
    steps: (run.steps ?? []).map((step) => ({
      id: step.id,
      who: displayStepLabel(step),
      role: displayStepRole(step),
      status: step.status === "COMPLETE" ? "done" : step.status === "FAILED" ? "fail" : "pending",
      cost: step.provider_cost_usd,
    })),
    text: textFromOutput(run.output) ?? "",
    code: run.recipe === "code",
    media: extractMedia(run.output),
    charged: run.cost.charged_credits,
    isTrial: run.is_trial,
    error: run.error ? errorMessage(run.error) : null,
  };
}

export function ChatView() {
  const { session } = useSession();
  const queryClient = useQueryClient();
  const { location, navigate } = useRouter();
  const { data: recipesData } = useRecipes(Boolean(session));

  const [turns, setTurns] = useState<Turn[]>([]);
  const [prompt, setPrompt] = useState("");
  const [formation, setFormation] = useState("auto");
  const [hood, setHood] = useState(false);
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [miniDocked, setMiniDocked] = useState(false);
  const liveSeqRef = useRef(0);
  const threadRef = useRef<HTMLDivElement | null>(null);
  /** Tinggi thread sebelum turn lama disisipkan di atas; untuk menjaga posisi baca. */
  const keepScrollRef = useRef<number | null>(null);
  const activeKeyRef = useRef<string | null>(null);
  const [hasOlder, setHasOlder] = useState(false);
  /** Kursor `before` dari server untuk halaman turn yang lebih lama; `null` bila habis. */
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const spentToday = useSpentToday();
  const trial = useTrialQuota();
  // Formasi media dikonfirmasi SEBELUM run dibuat (lihat `send`), supaya tombol
  // Cancel tidak memakan kuota/jatah media dan tidak menahan kuota sampai reaper.
  const [pendingMedia, setPendingMedia] = useState<{
    prompt: string;
    recipeId: string;
    /** Dibuat sekali; dipakai ulang bila POST gagal agar server me-replay run yang sama. */
    idempotencyKey: string;
  } | null>(null);

  const recipes: Recipe[] = useMemo(() => recipesData?.recipes ?? [], [recipesData]);

  // Percakapan aktif ditentukan URL, bukan state lokal: tautan `/app/chat/<id>`
  // yang dibuka langsung (atau di-refresh) menampilkan transkrip yang sama.
  const activeConversationId = useMemo(() => conversationIdFromPath(location), [location]);
  const { data: conversationData, error: conversationError } = useConversation(activeConversationId);
  /**
   * Percakapan benar-benar tidak ada atau bukan milik project ini (404).
   * Dibedakan dari kegagalan jaringan: hanya 404 yang menandai hidrasi sebagai
   * "tidak ada isi". Kalau error sesaat ikut menandai, transkrip tidak akan
   * pernah tergambar lagi walau query berikutnya berhasil.
   */
  const conversationMissing = conversationError instanceof ApiError && conversationError.status === 404;
  /** Id percakapan yang transkrip servernya sudah tergambar di `turns`. */
  const hydratedRef = useRef<string | null>(null);
  /** Id percakapan pada render sebelumnya; dipakai mendeteksi transisi keluar. */
  const openConversationIdRef = useRef<string | null>(null);

  useEffect(() => {
    setFormation((current) => {
      if (current !== "auto") return current;
      return readInitialFormation(window.location.search);
    });
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => setMiniDocked(true), 400);
    return () => window.clearTimeout(timer);
  }, []);

  // Saran router (debounce) untuk prompt yang cukup panjang.
  useEffect(() => {
    const value = prompt.trim();
    if (value.length < 8) {
      setSuggestion(null);
      return;
    }
    const timer = window.setTimeout(() => {
      api<{ recipe: string }>("/v1/router/suggest", { method: "POST", body: { prompt: value } })
        .then((res) => setSuggestion(res.recipe))
        .catch(() => setSuggestion(null));
    }, 400);
    return () => window.clearTimeout(timer);
  }, [prompt]);

  const recipeById = useCallback(
    (id: string) => recipes.find((recipe) => recipe.id === id),
    [recipes],
  );

  /** Versi id dari `isMediaRecipe`, untuk run/turn yang hanya menyimpan id resep. */
  const isMediaTurn = useCallback(
    (recipeId: string) => {
      const recipe = recipeById(recipeId);
      return recipe != null && isMediaRecipe(recipe);
    },
    [recipeById],
  );

  const estimateFor = useCallback(
    (id: string): number | null => {
      const recipe = recipeById(id);
      return recipe ? Math.round(recipe.pricing.credits) : null;
    },
    [recipeById],
  );

  /**
   * Apakah formasi ini bisa dijalankan sekarang.
   *
   * `available === undefined` (response lama, sebelum field ini ada) dianggap
   * tersedia: jangan menandai "coming soon" tanpa dasar dari server.
   */
  const isFormationAvailable = useCallback(
    (id: string | null | undefined): boolean => {
      if (!id) return false;
      const recipe = recipeById(id);
      return recipe != null && recipe.available !== false;
    },
    [recipeById],
  );

  /** Formasi yang providernya belum dikonfigurasi di server (untuk baris keterangan). */
  const soonRecipes = useMemo(
    () => recipes.filter((recipe) => recipe.available === false),
    [recipes],
  );

  // Deep link `?f=<formasi>` yang ternyata belum bisa dijalankan (kartu landing
  // lama atau bookmark) jatuh ke Auto. Ditahan saat daftar recipe masih kosong
  // supaya tautan yang dibuka sebelum login tidak ikut terhapus.
  useEffect(() => {
    if (recipes.length === 0 || formation === "auto") return;
    const recipe = recipeById(formation);
    if (recipe && recipe.available === false) setFormation("auto");
  }, [formation, recipes, recipeById]);

  const handleDone = useCallback(
    async (runId: string, status: string, finalText: string) => {
      const key = activeKeyRef.current;
      try {
        const run = await api<RunInfo>(`/v1/runs/${runId}`);
        setTurns((prev) =>
          prev.map((turn) => {
            if (turn.key !== key) return turn;
            const steps: TurnStep[] = (run.steps ?? []).map((step) => ({
              id: step.id,
              who: displayStepLabel(step),
              role: displayStepRole(step),
              status: step.status === "COMPLETE" ? "done" : step.status === "FAILED" ? "fail" : "pending",
              cost: step.provider_cost_usd,
            }));
            const content =
              (typeof run.output === "object" && run.output !== null
                ? (run.output as Record<string, unknown>).content
                : null) ?? finalText;
            const media = extractMedia(run.output);
            return {
              ...turn,
              status,
              statusTone: status === "SETTLED" ? "ok" : "bad",
              steps: steps.length > 0 ? steps : turn.steps,
              text: typeof content === "string" && content ? content : turn.text,
              code: turn.recipeId === "code",
              media,
              charged: run.cost.charged_credits,
              isTrial: run.is_trial,
            };
          }),
        );
        if (isMediaTurn(run.recipe) && status === "SETTLED") {
          // Prompt diambil dari run server, bukan dari `turns`: `handleDone`
          // dipanggil lewat closure yang ditangkap saat `start`, jadi `turns` di
          // situ belum memuat turn ini (hasilnya selalu kosong).
          addGalleryEntry({ id: runId, recipe: run.recipe, prompt: run.input, finishedAt: Date.now() });
        }
      } catch {
        setTurns((prev) =>
          prev.map((turn) =>
            turn.key === key
              ? { ...turn, status, statusTone: status === "SETTLED" ? "ok" : "bad", text: turn.text || finalText }
              : turn,
          ),
        );
      } finally {
        activeKeyRef.current = null;
        void queryClient.invalidateQueries({ queryKey: ["balance"] });
        void queryClient.invalidateQueries({ queryKey: ["usage"] });
        // Sisa kuota gratis berubah setiap run → segarkan chip di shell/balance.
        void queryClient.invalidateQueries({ queryKey: ["project"] });
        // Satu turn selesai → judul/urutan/run_count di daftar riwayat berubah.
        void queryClient.invalidateQueries({ queryKey: ["conversations"] });
      }
    },
    [queryClient, isMediaTurn],
  );

  const stream = useRunStream(handleDone);

  // Cerminkan progres stream ke kartu run yang aktif.
  useEffect(() => {
    const key = activeKeyRef.current;
    if (key == null) return;
    setTurns((prev) =>
      prev.map((turn) => {
        if (turn.key !== key) return turn;
        const byId = new Map<string, StreamStep>();
        for (const step of stream.steps) byId.set(step.id, step);
        const steps = turn.steps.map((step) => {
          const live = byId.get(step.id);
          if (!live) return step;
          return {
            ...step,
            status: live.status === "complete" ? "done" : live.status === "failed" ? "fail" : "run",
            cost: live.providerCostUsd ?? step.cost,
          } as TurnStep;
        });
        return { ...turn, text: stream.text, steps };
      }),
    );
  }, [stream.text, stream.steps]);

  useEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    // Turn lama disisipkan di ATAS, jadi daftarnya jadi lebih tinggi; posisi baca
    // yang sedang dilihat dipertahankan alih-alih melompat ke bawah.
    if (keepScrollRef.current !== null) {
      el.scrollTop = el.scrollHeight - keepScrollRef.current;
      keepScrollRef.current = null;
      return;
    }
    el.scrollTo({ top: el.scrollHeight });
  }, [turns, stream.text]);

  /**
   * Gambar ulang transkrip dari server saat URL menunjuk percakapan lain.
   *
   * Ditunda selama ada run berjalan agar kartu live (SSE) tidak tertimpa versi
   * lama; `send` juga menandai percakapan yang baru dibuat sebagai sudah
   * tergambar, sehingga turn live tetap utuh sampai `handleDone` menutupnya.
   */
  useEffect(() => {
    const previousId = openConversationIdRef.current;
    openConversationIdRef.current = activeConversationId;

    if (!activeConversationId) {
      // Baru saja keluar dari sebuah percakapan (mis. klik "Chat" di sidebar):
      // transkrip lama harus dibuang, kalau tidak layar menampilkan percakapan
      // lama di bawah URL "chat baru". Penjagaan pada TRANSISI, bukan pada
      // setiap render tanpa id — jika tidak, turn optimistis yang baru dikirim
      // (saat URL masih `/app/chat`) ikut terhapus.
      if (previousId) {
        hydratedRef.current = null;
        activeKeyRef.current = null;
        liveSeqRef.current = 0;
        setHasOlder(false);
        setOlderCursor(null);
        setTurns([]);
      }
      return;
    }
    if (hydratedRef.current === activeConversationId || stream.running) return;

    if (!conversationData) {
      // Id dari URL tidak ada / bukan milik project ini → jangan tinggalkan
      // transkrip lama menggantung di bawah URL baru.
      if (conversationMissing) {
        hydratedRef.current = activeConversationId;
        activeKeyRef.current = null;
        setHasOlder(false);
        setOlderCursor(null);
        setTurns([]);
        // URL TIDAK dipindahkan: pemilik bookmark ke chat yang sudah dihapus
        // harus tahu kenapa layarnya kosong (lihat notice "That chat no longer
        // exists."). `send` sudah menahan id ini (tidak ikut dikirim), jadi
        // kiriman berikutnya membuka percakapan baru — bukan 409 berulang.
      }
      return;
    }

    hydratedRef.current = activeConversationId;
    activeKeyRef.current = null;
    setTurns(conversationData.turns.map((run) => toTurn(run, recipeById)));
    // Halaman pertama hanya memuat turn TERBARU; sisanya diambil lewat tombol
    // "Load older turns" memakai kursor dari server (lihat `loadOlder`).
    setHasOlder(conversationData.has_more);
    setOlderCursor(conversationData.next_cursor);
  }, [activeConversationId, conversationData, conversationMissing, stream.running, recipeById]);

  /** Mulai chat kosong; transkrip lokal dibuang karena tidak milik percakapan mana pun. */
  function startNewChat() {
    hydratedRef.current = null;
    activeKeyRef.current = null;
    liveSeqRef.current = 0;
    setHasOlder(false);
    setOlderCursor(null);
    setTurns([]);
    navigate("/app/chat", { replace: true });
  }

  /**
   * Ambil satu halaman turn yang LEBIH LAMA lalu sisipkan di atas transkrip.
   *
   * Kursor datang dari server (`next_cursor`), bukan dirakit klien: server yang
   * tahu urutan `(created_at, id)`, dan bentuk `<ISO>|<id>` tetap sah walau run
   * kursor itu kemudian terhapus (mis. dibatalkan).
   */
  async function loadOlder() {
    if (!activeConversationId || loadingOlder || !olderCursor) return;

    setLoadingOlder(true);
    try {
      const res = await api<ConversationDetailResponse>(
        `/v1/conversations/${activeConversationId}?before=${encodeURIComponent(olderCursor)}`,
      );
      const older = res.turns.map((run) => toTurn(run, recipeById));
      const el = threadRef.current;
      keepScrollRef.current = el ? el.scrollHeight : null;
      setTurns((prev) => [...older, ...prev]);
      setHasOlder(res.has_more);
      setOlderCursor(res.next_cursor);
    } catch {
      // Gagal memuat halaman lama tidak boleh mengganggu transkrip yang sudah
      // tampil; tombolnya tetap ada untuk dicoba lagi.
    } finally {
      setLoadingOlder(false);
    }
  }

  async function send(
    initialPrompt?: string,
    options: { skipMediaConfirm?: boolean; idempotencyKey?: string } = {},
  ) {
    const value = (initialPrompt ?? prompt).trim();
    if (!value || stream.running || sending) return;
    // Sabuk kedua di samping gerbang render: tanpa sesi tidak ada yang boleh
    // dikirim, apa pun state komponen saat itu.
    if (!session) return;

    // Formasi manual yang ternyata "coming soon" (deep link, bookmark, atau state
    // lama) tidak pernah dikirim — server menolaknya 503. Jatuh ke jalur Auto,
    // yang sarannya sudah disaring server agar selalu formasi yang bisa jalan.
    const autoRoute = formation === "auto" || !isFormationAvailable(formation);
    const suggestedId =
      suggestion != null && isFormationAvailable(suggestion) ? suggestion : "refine";
    const resolvedId = autoRoute ? suggestedId : formation;
    const recipe = recipeById(resolvedId);
    if (!recipe) return;

    // Konfirmasi formasi media SEBELUM membuat run. Kalau run dibuat lebih dulu
    // (status AWAITING_CONFIRMATION), membatalkannya akan memakan kuota umum
    // sampai reaper (default 24 jam) dan menghanguskan satu jatah media.
    const needsConfirm = needsCostConfirm(recipe);
    if (needsConfirm && !options.skipMediaConfirm) {
      // Key dibuat di sini dan dipakai ulang bila pengiriman ulang diperlukan,
      // sehingga server mengenali percobaan kedua sebagai run yang sama.
      setPendingMedia({ prompt: value, recipeId: recipe.id, idempotencyKey: newIdempotencyKey() });
      return;
    }

    const key = `live-${++liveSeqRef.current}`;
    activeKeyRef.current = key;
    setSending(true);
    setPrompt("");
    setSuggestion(null);

    const steps: TurnStep[] = recipe.steps.map((step) => ({
      id: step.id,
      who: displayStepLabel(step),
      role: displayStepRole(step),
      status: "pending",
      cost: null,
    }));

    // Daily spending cap (client-side guard, seperti situs statis).
    const cap = readCapSettings();
    const est = estimateFor(recipe.id);
    if (cap.on && est != null && spentToday + est > cap.value) {
      activeKeyRef.current = null;
      setSending(false);
      setTurns((prev) => [
        ...prev,
        {
          key,
          createdAt: new Date().toISOString(),
          prompt: value,
          recipeId: recipe.id,
          recipeName: recipe.name,
          runId: null,
          status: "CAP_REACHED",
          statusTone: "bad",
          routerLine: `FORMATION set manually → <b>gattai/${recipe.id}</b>`,
          steps,
          text: "",
          code: false,
          media: null,
          charged: null,
          isTrial: false,
          error: `This run would pass your daily cap of ${cap.value} credits (spent ${spentToday.toFixed(2)} today). Nothing was charged.`,
        },
      ]);
      return;
    }

    setTurns((prev) => [
      ...prev,
      {
        key,
        createdAt: new Date().toISOString(),
        prompt: value,
        recipeId: recipe.id,
        recipeName: recipe.name,
        runId: null,
        status: "CREATED",
        statusTone: "dim",
        routerLine:
          autoRoute
            ? `ROUTER → suggests <b>gattai/${resolvedId}</b>`
            : `FORMATION set manually → <b>gattai/${resolvedId}</b>`,
        steps,
        text: "",
        code: false,
        media: null,
        charged: null,
        isTrial: false,
        error: null,
      },
    ]);

    try {
      // Konteks percakapan dipegang server (`messages`): klien tidak lagi
      // mengirim `history`, jadi tidak ada lagi anggaran riwayat yang harus
      // disamakan dengan batas server.
      // `conversation_id` hanya dikirim bila sudah ada: field-nya opsional, dan
      // `null` ditolak validasi. Id baru dibuat server lalu dipakai sebagai URL.
      // Id yang sudah terbukti tidak ada (404) tidak ikut dikirim agar tidak
      // memicu 409 berulang.
      const body: Record<string, unknown> = { recipe_id: recipe.id, input: value };
      if (activeConversationId && !conversationMissing) body.conversation_id = activeConversationId;
      const res = await api<RunCreateResponse>("/v1/runs", {
        method: "POST",
        body,
        headers: { "Idempotency-Key": options.idempotencyKey ?? newIdempotencyKey() },
      });

      // Turn ini sudah memegang percakapan tersebut; jangan hidrasi ulang dari
      // server selama run berjalan (teks SSE lebih baru daripada transkrip).
      hydratedRef.current = res.conversation_id;
      // `conversation_id` bisa null pada replay run lama (Idempotency-Key yang
      // dipakai sebelum kolom ini ada); jangan menavigasi ke `/app/chat/null`.
      if (res.conversation_id && res.conversation_id !== activeConversationId) {
        navigate(`/app/chat/${res.conversation_id}`, { replace: true });
      }

      if (res.status === "AWAITING_CONFIRMATION") {
        // Formasi media: user sudah menyetujui di modal pra-kirim, jadi konfirmasi
        // langsung tanpa memunculkan langkah kedua di UI. Kegagalan konfirmasi
        // ditangani oleh `catch` di bawah (status jadi ERROR).
        setTurns((prev) =>
          prev.map((turn) =>
            turn.key === key
              ? {
                  ...turn,
                  runId: res.run_id,
                  status: "AWAITING_CONFIRMATION",
                  statusTone: "acc",
                  isTrial: res.is_trial,
                }
              : turn,
          ),
        );
        await api(`/v1/runs/${res.run_id}/confirm`, { method: "POST" });
        activeKeyRef.current = key;
        setTurns((prev) =>
          prev.map((turn) =>
            turn.key === key ? { ...turn, status: "RESERVED", statusTone: "acc" } : turn,
          ),
        );
        stream.start(res.run_id);
        return;
      }

      setTurns((prev) =>
        prev.map((turn) =>
          turn.key === key
            ? {
                ...turn,
                runId: res.run_id,
                status: "RESERVED",
                statusTone: "acc",
                isTrial: res.is_trial,
              }
            : turn,
        ),
      );
      activeKeyRef.current = key;
      stream.start(res.run_id);
    } catch (cause) {
      activeKeyRef.current = null;
      const message = turnErrorMessage(cause);
      const cta = topupHref(cause);
      setTurns((prev) =>
        prev.map((turn) =>
          turn.key === key
            ? {
                ...turn,
                status: "ERROR",
                statusTone: "bad",
                error: message,
                errorCta: cta ? { to: cta, label: "Top up" } : null,
              }
            : turn,
        ),
      );
      // Jalur media: bila POST gagal SETELAH server sempat membuat run (respons
      // hilang di jaringan), key yang sama membuat percobaan berikutnya
      // di-replay server ke run itu — bukan membuat run kedua yang memakan
      // jatah media lagi. Karena itu modal dikembalikan agar user bisa coba lagi.
      if (options.idempotencyKey) {
        setPendingMedia({ prompt: value, recipeId: recipe.id, idempotencyKey: options.idempotencyKey });
      }
    } finally {
      setSending(false);
      // Percakapan baru (atau run terbaru) langsung muncul di daftar riwayat.
      void queryClient.invalidateQueries({ queryKey: ["conversations"] });
    }
  }

  function confirmMedia() {
    if (!pendingMedia) return;
    const { prompt: value, idempotencyKey } = pendingMedia;
    setPendingMedia(null);
    void send(value, { skipMediaConfirm: true, idempotencyKey });
  }

  function cancelMedia() {
    // Belum ada run yang dibuat, jadi tidak ada kuota/jatah media yang terpakai.
    setPendingMedia(null);
  }

  if (!session) return <NeedLogin action="Chat" />;

  // Saran router hanya dipakai bila formasinya bisa dijalankan; formasi manual
  // yang "coming soon" jatuh ke Auto — cermin dari jalur kirim di atas.
  const routedFormation =
    suggestion != null && isFormationAvailable(suggestion) ? suggestion : "auto";
  const activeFormation =
    formation === "auto" || !isFormationAvailable(formation) ? routedFormation : formation;
  const activeEstimate = estimateFor(activeFormation);
  const activeRecipe = activeFormation === "auto" ? null : recipeById(activeFormation);

  // Peringatan dini: formasi media yang dipilih (termasuk hasil rute otomatis)
  // tidak lagi gratis karena jatah media sudah habis. Kuota teks tidak
  // memengaruhi jalur media — keduanya anggaran mandiri (§2 dokumen).
  const mediaAllowanceGone =
    activeRecipe != null && isMediaRecipe(activeRecipe) && trial != null && trial.mediaLeft === 0;

  // Catatan tetap (bukan modal) untuk formasi teks: setelah kuota teks habis, run
  // langsung memakai credit tanpa konfirmasi, jadi user tetap harus diberi tahu.
  // Tidak ditampilkan bersamaan dengan peringatan media di atas.
  const trialTextGone = !mediaAllowanceGone && trial != null && trial.remaining === 0;

  // Apakah run media yang menunggu konfirmasi akan gratis. Cermin dari gate
  // backend untuk formasi media: `attempts < maxAttempts && mediaSlotLeft` —
  // kuota teks TIDAK ikut disyaratkan. `mediaLeft` null (API lama) diperlakukan
  // sebagai "masih ada", sama seperti sebelum perubahan.
  const pendingIsFree = trial != null && trial.attemptsLeft > 0 && (trial.mediaLeft ?? 1) > 0;

  return (
    <section className="view on" id="v-chat">
      <div className="chathead">
        <span className="lab">Formation</span>
        <div className="seg" id="fSeg">
          <button
            data-f="auto"
            className={formation === "auto" ? "on" : undefined}
            onClick={() => setFormation("auto")}
          >
            Auto
          </button>
          {recipes.map((recipe) => {
            // "Coming soon": provider yang dibutuhkan belum dikonfigurasi server.
            const soon = recipe.available === false;
            return (
              <button
                key={recipe.id}
                data-f={recipe.id}
                className={soon ? "soon" : formation === recipe.id ? "on" : undefined}
                // `aria-disabled` — bukan atribut `disabled` native — supaya pil
                // tetap terjangkau keyboard dan tooltip-nya terbaca pembaca layar
                // (tombol `disabled` keluar dari tab-order).
                aria-disabled={soon || undefined}
                aria-label={soon ? `${recipe.name} — coming soon` : undefined}
                title={soon ? `${recipe.name} is coming soon — the media layer isn't connected yet.` : undefined}
                onClick={soon ? undefined : () => setFormation(recipe.id)}
              >
                {recipe.name}
                {soon && <span className="soontag">Soon</span>}
              </button>
            );
          })}
        </div>
        <div className="chattools">
          <button
            className="tool"
            disabled={stream.running || sending}
            title={
              stream.running || sending ? "Wait for the current run to finish" : "Start an empty chat"
            }
            onClick={startNewChat}
          >
            New chat
          </button>
        </div>
        <div className="hood">
          Under the hood{" "}
          <button
            className={`sw${hood ? " on" : ""}`}
            id="hoodSw"
            aria-label="Toggle under the hood"
            onClick={() => setHood((value) => !value)}
          ></button>
        </div>
        {soonRecipes.length > 0 && (
          <p className="soonhint">
            {soonRecipes.map((recipe) => recipe.name).join(", ")}{" "}
            {soonRecipes.length === 1 ? "is" : "are"} coming soon — the media layer isn&apos;t
            connected yet.
          </p>
        )}
      </div>

      <div className={`thread${hood ? " hoodon" : ""}`} id="thread" ref={threadRef}>
        {turns.length === 0 && conversationMissing && (
          <div className="chgone" id="gone">
            <h2>That chat no longer exists.</h2>
            <p>It may have been deleted. Start a new chat to keep building.</p>
            <button className="btn btn-dark btn-sm" onClick={startNewChat}>
              Start a new chat
            </button>
          </div>
        )}

        {turns.length === 0 && !conversationMissing && (
          <div className="welcome" id="welcome">
            <div className="mini">
              <svg className={`unit${miniDocked ? "" : " apart"}`} id="miniUnit" viewBox="0 0 400 400" role="img" aria-label="Four AI modules docking into one unit">
                <circle className="glow" cx="200" cy="200" r="190" fill="url(#glowGrad)" />
                <g className="mod m1">
                  <use href="#modArt" />
                  <text className="lab" x="40" y="160">01 / INTERPRET</text>
                </g>
                <g className="mod m2">
                  <use href="#modArt" transform="translate(400 0) scale(-1 1)" />
                  <text className="lab" x="268" y="160">02 / EXECUTE</text>
                </g>
                <g className="mod m3">
                  <use href="#modArt" transform="translate(0 400) scale(1 -1)" />
                  <text className="lab" x="40" y="246">03 / RESEARCH</text>
                </g>
                <g className="mod m4">
                  <use href="#modArt" transform="translate(400 400) scale(-1 -1)" />
                  <text className="lab" x="268" y="246">04 / RENDER</text>
                </g>
                <g className="core">
                  <circle cx="200" cy="200" r="54" fill="url(#coreGrad)" stroke="rgba(255,91,31,.55)" strokeWidth="1.2" />
                  <circle className="ring" cx="200" cy="200" r="46" fill="none" stroke="rgba(255,91,31,.7)" strokeWidth="1" strokeDasharray="2 6" />
                  <circle className="ring2" cx="200" cy="200" r="38" fill="none" stroke="rgba(236,233,226,.25)" strokeWidth="1" strokeDasharray="18 10" />
                  <text className="coreglyph" x="200" y="211" textAnchor="middle">合体</text>
                </g>
                <circle className="shock" cx="200" cy="200" r="60" />
              </svg>
            </div>
            <h2>
              What should the<br />formation build?
            </h2>
            <p>Type anything. The router picks a formation, or choose one above.</p>
            <div className="sugg">
              {SUGGESTIONS.map((item) => (
                <button
                  key={item.tag}
                  onClick={() => {
                    setPrompt(item.prompt);
                    void send(item.prompt);
                  }}
                >
                  <small>{item.tag}</small>
                  <span>
                    {item.tag === "Refine" && "Sharpen a landing headline, 3 options"}
                    {item.tag === "Research" && "How buyback programs report burns, cited"}
                    {item.tag === "Code" && "Fetch with exponential backoff in TS"}
                    {item.tag === "Video" && "8s teaser of modules docking"}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {hasOlder && olderCursor ? (
          <div style={{ display: "flex", justifyContent: "center", padding: "2px 0 12px" }}>
            <button
              className="btn btn-dark btn-sm"
              disabled={loadingOlder}
              onClick={() => void loadOlder()}
            >
              {loadingOlder ? "Loading…" : "Load older turns"}
            </button>
          </div>
        ) : null}

        {turns.map((turn) => (
          <div key={turn.key}>
            <div className="msg-u">
              <div>{turn.prompt}</div>
            </div>
            <div className="runc" style={{ marginTop: 14 }}>
              <div className="rh">
                <span className="f">gattai/{turn.recipeId}</span>
                <span className="id">{turn.runId ? shortId(turn.runId) : "…"}</span>
                {turn.isTrial && (
                  <span className="st ok" data-trial title="Free prompt from your trial quota">
                    FREE
                  </span>
                )}
                <span className={`st ${turn.statusTone}`} data-st>
                  {statusLabel(turn.status)}
                </span>
              </div>
              <div className="rb">
                <div className="router" dangerouslySetInnerHTML={{ __html: turn.routerLine }}></div>
                <div className="track">
                  {turn.steps.map((step, index) => (
                    <span key={step.id} style={{ display: "contents" }}>
                      {index > 0 && <div className={`lnk${step.status === "pending" ? "" : " on"}`}></div>}
                      <div className={`node${step.status === "run" ? " run" : step.status === "done" ? " done" : step.status === "fail" ? " fail" : ""}`}>
                        <span className="s2"></span>
                        <div>
                          <div className="who">{step.who}</div>
                          <div className="role">{step.role}</div>
                        </div>
                      </div>
                    </span>
                  ))}
                </div>
                <div data-slot>
                  {turn.error && (
                    <div className="errbox">
                      <span>{turn.error}</span>
                      {turn.errorCta && (
                        <Link to={turn.errorCta.to} className="btn btn-acc btn-sm">
                          {turn.errorCta.label}
                        </Link>
                      )}
                    </div>
                  )}
                  {turn.status === "INSUFFICIENT_BALANCE" && (
                    <div className="errbox">
                      Not enough credits for this run. Nothing was charged.{" "}
                      <Link to="/app/balance" className="btn btn-acc btn-sm">
                        Top up
                      </Link>
                    </div>
                  )}
                </div>
                <div className="hoodp">
                  <h6>Original request</h6>
                  <pre>{turn.prompt}</pre>
                  <h6>Per-step cost</h6>
                  <table>
                    <tbody>
                      {turn.steps.map((step) => (
                        <tr key={step.id}>
                          <td>
                            {step.who} · {step.role}
                          </td>
                          <td>{step.cost != null ? `$${step.cost.toFixed(4)}` : "-"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {turn.text &&
                  (turn.code ? (
                    <div className="out code" data-out>
                      {turn.text}
                    </div>
                  ) : (
                    <MarkdownText text={turn.text} />
                  ))}
                {isMediaTurn(turn.recipeId) &&
                  (turn.status === "SETTLED" || turn.status === "RELEASED") && (
                    <MediaOutput media={turn.media} prompt={turn.prompt} />
                  )}
              </div>
              <div className="rf">
                <span>
                  {turn.isTrial ? (
                    <>
                      <b data-cost>Free</b> · trial prompt
                    </>
                  ) : (
                    <>
                      Σ <b data-cost>{turn.charged != null ? turn.charged.toFixed(2) : "0.00"}</b> cr
                    </>
                  )}
                </span>
                <span className="acts">
                  <button data-copyout onClick={() => void copyText(turn.text || turn.prompt)}>
                    Copy
                  </button>
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>

      {pendingMedia && (
        <div className="confirm" id="mediaConfirm" style={{ margin: "0 0 10px" }}>
          <span>
            {pendingIsFree ? (
              <>
                <b>Free on your trial</b> — uses one of your free media runs.
              </>
            ) : trial != null && trial.mediaLeft === 0 ? (
              <>
                Your free media runs are used up — this one runs on credits. Estimated cost{" "}
                <b>~{estimateFor(pendingMedia.recipeId) ?? "-"} cr</b>.
              </>
            ) : (
              <>
                Estimated cost{" "}
                <b>~{estimateFor(pendingMedia.recipeId) ?? "-"} cr</b> · media runs need confirmation
              </>
            )}
          </span>
          <span className="sp"></span>
          <button className="btn btn-dark btn-sm" onClick={cancelMedia}>
            Cancel
          </button>
          <button className="btn btn-acc btn-sm" onClick={confirmMedia}>
            Confirm
          </button>
        </div>
      )}

      <div className="composer">
        <div className="cbox">
          <label className="sr" htmlFor="prompt">
            Prompt
          </label>
          <textarea
            id="prompt"
            rows={1}
            placeholder="Ask anything, or describe what you want made…"
            value={prompt}
            onChange={(event) => {
              setPrompt(event.target.value);
              event.target.style.height = "auto";
              event.target.style.height = `${Math.min(event.target.scrollHeight, 200)}px`;
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                if (prompt.trim()) void send();
              }
            }}
          ></textarea>
          <div className="cb">
            <span className="meta" id="cMeta">
              Formation <b>{activeFormation}</b> · est.{" "}
              <b>{activeEstimate != null ? `~${activeEstimate} cr` : "-"}</b>
              <span className="hide-m"> · Enter to send, Shift+Enter for a new line</span>
              {mediaAllowanceGone ? (
                <span style={{ color: "var(--acc)" }}>
                  {" "}
                  · media allowance used, this runs on credits
                </span>
              ) : trialTextGone ? (
                <span style={{ color: "var(--acc)" }}> · trial finished, runs use credits</span>
              ) : null}
              {stream.running && stream.error && (
                <span style={{ color: "var(--acc)" }}> · {stream.error}</span>
              )}
            </span>
            <button
              className="send"
              id="sendBtn"
              disabled={!prompt.trim() || stream.running || sending}
              aria-label="Send"
              onClick={() => void send()}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#140700" strokeWidth="2">
                <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
