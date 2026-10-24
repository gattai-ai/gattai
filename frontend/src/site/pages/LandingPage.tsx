import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatUnits } from "viem";
import { Link } from "@/lib/router";
import { searchOf, useRouter } from "@/lib/router-context";
import { api } from "@/lib/api";
import { useDocumentTitle, useSiteReveal } from "@/site/useSite";
import { useSession } from "@/lib/use-session";
import { useRecipes } from "@/features/chat/useRecipes";
import { useFormationAvailability } from "@/features/chat/useFormations";
import { toDisplayRecipes, type DisplayRecipe } from "@/lib/provider-label";
import type { BurnsResponse } from "@/lib/types";
import "../landing.css";

/**
 * Landing GATTAI dengan tampilan situs statis: hero docking, marquee, how,
 * before/after, console demo, formations, builders, token, roadmap, FAQ.
 * Animasi dekoratif di-port dari index.html; angka burn memakai API nyata.
 */

function Split({ text, delay = 0.3 }: { text: string; delay?: number }) {
  return (
    <>
      {[...text].map((char, index) => (
        <span key={index} className="ch" style={{ ["--i" as string]: index, ["--d" as string]: `${delay}s` }}>
          {char}
        </span>
      ))}
    </>
  );
}

function tokensToNumber(raw: string | undefined): number {
  if (!raw) return 0;
  try {
    const value = Number(formatUnits(BigInt(raw), 18));
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

const FORMATIONS = ["gattai/refine", "gattai/research", "gattai/code", "gattai/video", "gattai/visual", "gattai/launch_kit"];

/** Hook pemilih demo konsol landing (dipasang sekali, dibersihkan saat unmount). */
interface ConsolePickerWindow {
  __gattaiConsolePick?: (key: string) => void;
}

function setConsolePicker(pick: ((key: string) => void) | undefined): void {
  (window as ConsolePickerWindow).__gattaiConsolePick = pick;
}

function getConsolePicker(): ((key: string) => void) | undefined {
  return (window as ConsolePickerWindow).__gattaiConsolePick;
}

const RECIPE_EXAMPLES: Record<string, string> = {
  refine: "\u201CMake this landing copy sharper\u201D \u2192 a structured brief, then a finished rewrite.",
  research: "A sourced report with inline citations you can click through.",
  code: "Code that has already been reviewed once before you read it.",
  visual: "A one-line idea becomes a full art brief, then the image set.",
  video: "Shot list with timing and audio cues, rendered as a clip.",
  launch_kit: "Thread, one-pager and bio \u2014 plus a banner and PFP to match.",
};

/**
 * Formasi statis untuk pengunjung anonim (belum login / `/v1/recipes` tidak
 * dimuat). Teksnya sudah dalam bentuk final seperti `gattai-site/index.html`
 * (label provider publik + frasa role marketing + mode Title Case).
 */
const FALLBACK_FORMATIONS: DisplayRecipe[] = [
  { id: "refine", name: "Refine", mode: "Streaming", steps: [{ label: "GPT", role: "interpret" }, { label: "Claude", role: "execute" }] },
  { id: "research", name: "Research", mode: "Streaming", steps: [{ label: "Perplexity", role: "gather" }, { label: "Claude", role: "write" }] },
  { id: "code", name: "Code", mode: "Streaming", steps: [{ label: "Claude", role: "write" }, { label: "GPT", role: "review" }, { label: "Claude", role: "fix" }] },
  { id: "visual", name: "Visual", mode: "Async", steps: [{ label: "Claude", role: "art direction" }, { label: "Higgsfield", role: "image" }] },
  { id: "video", name: "Video", mode: "Async", steps: [{ label: "Claude", role: "script & shots" }, { label: "Higgsfield", role: "Veo / Kling" }] },
  { id: "launch_kit", name: "Launch Kit", mode: "Mixed", steps: [{ label: "Claude", role: "copy pack" }, { label: "Higgsfield", role: "banner/PFP" }] },
];

/** Kartu formasi di landing (dari `/v1/recipes` atau daftar statis). */
export function FormationCards({ formations }: { formations: DisplayRecipe[] }) {
  return (
    <div className="recipes">
      {formations.map((recipe, index) => {
        // "Coming soon": provider yang dibutuhkan belum dikonfigurasi di server.
        // Kartu tetap tampil sebagai roadmap, tapi tidak lagi menjadi tautan —
        // jangan mengarahkan pengunjung ke formasi yang pasti ditolak.
        const soon = recipe.available === false;
        const content = (
          <>
            <div className="bolts">
              <i></i>
              <i></i>
              <i></i>
              <i></i>
            </div>
            <div className="top1">
              <span className="id">gattai/{recipe.id}</span>
              <span className="mode">{recipe.mode}</span>
            </div>
            <span className="go">{soon ? "SOON" : "RUN →"}</span>
            <h3>{recipe.name}</h3>
            <div className="chain">
              {recipe.steps.flatMap((step, stepIndex) => {
                const label = `${step.label} · ${step.role}`;
                return stepIndex === 0
                  ? [<span key={stepIndex}>{label}</span>]
                  : [<em key={`e-${stepIndex}`}>→</em>, <span key={stepIndex}>{label}</span>];
              })}
            </div>
            <div className="ex">
              <b>Example</b>
              {RECIPE_EXAMPLES[recipe.id] ?? "One prompt in, one finished result out."}
            </div>
          </>
        );

        if (soon) {
          return (
            <div
              key={recipe.id}
              className="rc chamfer soon"
              data-r={String(2 + (index % 3))}
              aria-disabled="true"
              title={`${recipe.name} is coming soon — the media layer isn't connected yet.`}
            >
              {content}
            </div>
          );
        }

        return (
          <Link
            key={recipe.id}
            to={`/app/chat?f=${recipe.id}`}
            className="rc chamfer"
            data-r={String(2 + (index % 3))}
          >
            {content}
          </Link>
        );
      })}
    </div>
  );
}

interface ConsoleScenario {
  prompt: string;
  route: [string, string];
  steps: Array<[string, string]>;
  brief: string;
  out: string;
  cost: number;
  code?: boolean;
  media?: boolean;
  est?: string;
}

const CONSOLE_SCENARIOS: Record<string, ConsoleScenario> = {
  refine: {
    prompt: "Write a hero line for a coffee subscription \u2014 3 options, playful.",
    route: ["gattai/refine", "0.91"],
    steps: [["GPT", "interpret"], ["Claude", "execute"]],
    brief: '{\n  "pass_through": false,\n  "goal": "Hero headline options for a coffee subscription",\n  "deliverable": "3 headlines + 1-line subhead each",\n  "style": "playful, short"\n}',
    out: "1. Your mornings, on autopilot.\n   Fresh beans at your door before you run out.\n\n2. Never meet an empty bag again.\n   Roasted this week, delivered this week.\n\n3. Good coffee. Zero errands.\n   Pick a roast, skip a week, cancel anytime.",
    cost: 3.82,
  },
  research: {
    prompt: "What changed in L2 fee markets this quarter? Cite sources.",
    route: ["gattai/research", "0.88"],
    steps: [["Perplexity", "gather_sources"], ["Claude", "write"]],
    brief: '{\n  "sources_found": 14,\n  "kept": 6,\n  "handoff": "claims + citations \u2192 writer"\n}',
    out: "Summary\nFees on most rollups stayed low, but the spread between chains widened as blob demand shifted [1]. Sequencer revenue concentrated in a handful of networks [2], while app-specific chains pushed custom fee tokens [3].\n\n(sample output)",
    cost: 6.1,
  },
  code: {
    prompt: "useDebounce hook in TypeScript with cancel().",
    route: ["gattai/code", "0.95"],
    code: true,
    steps: [["Claude", "write"], ["GPT", "review"], ["Claude", "fix"]],
    brief: 'review \u2192 {\n  "issues": ["timer not cleared on unmount"],\n  "severity": "medium"\n}',
    out: "export function useDebounce<T>(value: T, ms = 300) {\n  const [v, setV] = useState(value);\n  const t = useRef<ReturnType<typeof setTimeout>>();\n  useEffect(() => {\n    t.current = setTimeout(() => setV(value), ms);\n    return () => clearTimeout(t.current); // fixed in review\n  }, [value, ms]);\n  const cancel = () => clearTimeout(t.current);\n  return [v, cancel] as const;\n}",
    cost: 8.47,
  },
  video: {
    prompt: "8s teaser: four modules docking into one machine, 9:16.",
    route: ["gattai/video", "0.93"],
    media: true,
    est: "~120 cr",
    steps: [["Claude", "script_and_shots"], ["Higgsfield", "render \u00b7 Veo 3.1"]],
    brief: '{\n  "model_hint": "veo_3_1",\n  "aspect_ratio": "9:16",\n  "duration_s": 8,\n  "audio": true,\n  "shots": [{ "t": 0, "desc": "modules drift apart" },\n            { "t": 5, "desc": "dock + orange lock flash" }]\n}',
    out: "Rendered \u00b7 8s \u00b7 9:16 \u00b7 audio on",
    cost: 118.2,
  },
};

export function LandingPage() {
  useDocumentTitle("GATTAI \u2014 Separate machines. One formation.");
  useSiteReveal();
  const { location } = useRouter();

  // CTA `/run/:slug` boleh mampir ke landing dengan `?recipe=&prompt=`; teruskan
  // ke composer app supaya prompt tidak hilang di tengah jalan.
  const appCtaHref = useMemo(() => {
    const params = new URLSearchParams(searchOf(location));
    const recipe = params.get("recipe")?.trim();
    const prompt = params.get("prompt");
    if (!recipe && !prompt) return "/app/chat";
    const next = new URLSearchParams();
    if (recipe) next.set("f", recipe);
    if (prompt) next.set("prompt", prompt.slice(0, 4000));
    return `/app/chat?${next.toString()}`;
  }, [location]);

  const { data: burns } = useQuery({
    queryKey: ["burns"],
    queryFn: () => api<BurnsResponse>("/v1/public/burns"),
    refetchInterval: 60_000,
  });
  const { session } = useSession();
  // Hanya minta recipe saat ada sesi: `/v1/recipes` butuh login, jadi pada
  // pengunjung anonim query ini selalu 401. Bagian formasi tetap tampil memakai
  // daftar statis bila belum ada data.
  const { data: recipesData } = useRecipes(Boolean(session));
  const burnTotal = tokensToNumber(burns?.total_tokens_burned);
  const executedEpochs = useMemo(
    () => (burns?.epochs ?? []).filter((epoch) => epoch.status === "executed"),
    [burns],
  );
  const lastBurned = tokensToNumber(executedEpochs[executedEpochs.length - 1]?.tokens_burned);
  const lastTx = useMemo(() => {
    const last = executedEpochs[executedEpochs.length - 1];
    const hash = last?.tx_hashes[0];
    return hash ? `0x${hash.slice(2, 6)}\u2026${hash.slice(-4)} \u2197` : "\u2014";
  }, [executedEpochs]);

  // ---- intro class ----
  useEffect(() => {
    document.body.classList.add("intro");
    const timer = window.setTimeout(() => document.body.classList.remove("intro"), 3400);
    return () => {
      window.clearTimeout(timer);
      document.body.classList.remove("intro");
    };
  }, []);

  // ---- hero dock ----
  const stageRef = useRef<HTMLDivElement | null>(null);
  const unitRef = useRef<SVGSVGElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [apart, setApart] = useState(true);
  const [locked, setLocked] = useState(false);
  const [lockFlash, setLockFlash] = useState(false);
  const [lockState, setLockState] = useState("DOCKING");
  const [cycle, setCycle] = useState(1);
  const [activeFormation, setActiveFormation] = useState(FORMATIONS[1]);
  const busyRef = useRef(false);

  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const timers: number[] = [];
    timers.push(
      window.setTimeout(() => {
        setApart(false);
        timers.push(
          window.setTimeout(
            () => {
              setLockFlash(true);
              setLocked(true);
              setLockState("LOCKED");
              layoutConduits();
            },
            reduce ? 0 : 1050,
          ),
        );
      }, reduce ? 0 : 1300),
    );
    const interval = reduce
      ? 0
      : window.setInterval(() => {
          if (document.visibilityState === "visible" && window.scrollY < window.innerHeight) {
            void redock(false);
          }
        }, 9000);
    const onResize = () => layoutConduits();
    window.addEventListener("resize", onResize);
    const conduitTimer = window.setInterval(layoutConduits, 250);
    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
      if (interval) window.clearInterval(interval);
      window.clearInterval(conduitTimer);
      window.removeEventListener("resize", onResize);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function layoutConduits() {
    const stage = stageRef.current;
    const unit = unitRef.current;
    if (!stage || !unit) return;
    const svg = stage.querySelector<SVGSVGElement>("#conduits");
    if (!svg || getComputedStyle(svg).display === "none") return;
    const rect = stage.getBoundingClientRect();
    const core = unit.querySelector(".core")?.getBoundingClientRect();
    const tag1 = document.getElementById("tag1")?.getBoundingClientRect();
    const tag2 = document.getElementById("tag2")?.getBoundingClientRect();
    if (!core || !tag1 || !tag2) return;
    const cx = core.left + core.width / 2 - rect.left;
    const cy = core.top + core.height / 2 - rect.top;
    const cr = core.width / 2;
    const a = [tag1.right - rect.left, tag1.top + tag1.height / 2 - rect.top];
    const b = [tag2.left - rect.left, tag2.top + tag2.height / 2 - rect.top];
    const e1 = [cx - cr, cy];
    const e2 = [cx + cr, cy];
    const p1 = `M${a[0]} ${a[1]} C ${a[0] + 120} ${a[1]}, ${e1[0] - 140} ${e1[1]}, ${e1[0]} ${e1[1]}`;
    const p2 = `M${e2[0]} ${e2[1]} C ${e2[0] + 140} ${e2[1]}, ${b[0] - 120} ${b[1]}, ${b[0]} ${b[1]}`;
    const set = (id: string, name: string, value: string | number) =>
      svg.querySelector(`#${id}`)?.setAttribute(name, String(value));
    set("cp1", "d", p1);
    set("cf1", "d", p1);
    set("cp2", "d", p2);
    set("cf2", "d", p2);
    set("ce1", "cx", a[0]);
    set("ce1", "cy", a[1]);
    set("ce2", "cx", b[0]);
    set("ce2", "cy", b[1]);
  }

  async function redock(full: boolean) {
    if (busyRef.current) return;
    busyRef.current = true;
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    setLockState(full ? "SEPARATING" : "RE-DOCKING");
    if (full) {
      setApart(true);
      setLocked(false);
      await sleep(1300);
    } else {
      setApart(false);
      await sleep(900);
    }
    setApart(false);
    setLockState("DOCKING");
    await sleep(full ? 1100 : 600);
    setLockFlash(false);
    requestAnimationFrame(() => setLockFlash(true));
    setLocked(true);
    setLockState("LOCKED");
    setCycle((value) => {
      const next = value + 1;
      setActiveFormation(FORMATIONS[next % FORMATIONS.length]);
      return next;
    });
    layoutConduits();
    busyRef.current = false;
  }

  function onStagePointerMove(event: React.PointerEvent) {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const stage = stageRef.current;
    if (reduce || !stage || window.innerWidth < 1000) return;
    const rect = stage.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width - 0.5;
    const y = (event.clientY - rect.top) / rect.height - 0.5;
    if (wrapRef.current) {
      wrapRef.current.style.transform = `translate(${x * 14}px, ${y * 10}px) rotateX(${-y * 8}deg) rotateY(${x * 10}deg)`;
    }
    const g1 = stage.querySelector<HTMLElement>(".giant.g1");
    const g2 = stage.querySelector<HTMLElement>(".giant.g2");
    if (g1) g1.style.translate = `${x * -14}px ${y * -8}px`;
    if (g2) g2.style.translate = `${x * 14}px ${y * 8}px`;
  }

  // ---- hero demo feed ----
  const [feed, setFeed] = useState<Array<{ id: string; recipe: string; cost: string }>>([]);
  useEffect(() => {
    const kinds: Array<[string, number]> = [
      ["refine", 3.8],
      ["research", 6.1],
      ["code", 8.5],
      ["visual", 22.6],
      ["video", 118.2],
      ["launch_kit", 37.9],
    ];
    const push = () => {
      const [recipe, base] = kinds[Math.floor(Math.random() * kinds.length)];
      const id = `run_${Math.random().toString(16).slice(2, 6)}`;
      setFeed((prev) =>
        [{ id, recipe, cost: `${(base * (0.8 + Math.random() * 0.4)).toFixed(1)}cr` }, ...prev].slice(0, 6),
      );
    };
    for (let i = 0; i < 4; i++) push();
    const timer = window.setInterval(push, 2400);
    return () => window.clearInterval(timer);
  }, []);

  // ---- how scroll ----
  const howRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const how = howRef.current;
    if (!how) return;
    const mods = [1, 2, 3, 4].map((i) => how.querySelector<SVGGElement>(`.m${i}`));
    const dirs: Array<[number, number, number]> = [[-1, -1, -14], [1, -1, 16], [-1, 1, 12], [1, 1, -18]];
    const steps = [...how.querySelectorAll(".step")];
    const bars = [...how.querySelectorAll<HTMLElement>("#howProg b")];
    const pct = how.querySelector("#howPct");
    const state = how.querySelector("#howState");
    const outchip = how.querySelector("#outchip");
    const unit = how.querySelector("#howUnit");
    let wasDocked = false;
    const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value));
    const update = () => {
      const rect = how.getBoundingClientRect();
      const progress = clamp(-rect.top / (rect.height - window.innerHeight));
      const dock = clamp((progress - 0.08) / 0.74);
      const far = 1 - (1 - Math.pow(1 - dock, 3));
      mods.forEach((mod, i) => {
        if (!mod) return;
        const [dx, dy, rot] = dirs[i];
        mod.style.transform = `translate(${dx * far * 42}%, ${dy * far * 42}%) rotate(${rot * far}deg)`;
        mod.style.opacity = String(0.35 + 0.65 * clamp(dock * 3 - i * 0.25));
      });
      const docked = dock >= 0.999;
      unit?.classList.toggle("apart", !docked);
      if (docked && !wasDocked) {
        unit?.classList.remove("lockflash");
        void (unit as SVGSVGElement | null)?.getBBox?.();
        unit?.classList.add("lockflash");
      }
      wasDocked = docked;
      const stepIndex = progress < 0.34 ? 0 : progress < 0.67 ? 1 : 2;
      steps.forEach((step, i) => step.classList.toggle("on", i === stepIndex));
      bars.forEach((bar, i) => bar.style.setProperty("--s", String(clamp(progress * 3 - i))));
      if (pct) pct.textContent = `${String(Math.round(dock * 100)).padStart(3, "0")}%`;
      if (state) state.textContent = docked ? "SETTLED" : dock > 0.55 ? "STEP_2_PENDING" : dock > 0.2 ? "RESERVED" : "CREATED";
      outchip?.classList.toggle("on", docked);
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    return () => window.removeEventListener("scroll", update);
  }, []);

  // ---- before/after loops ----
  const baBeforeRef = useRef<HTMLDivElement | null>(null);
  const baAfterRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    let cancelled = false;
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const before = baBeforeRef.current;
    const after = baAfterRef.current;
    let beforeVis = false;
    let afterVis = false;
    const observers: IntersectionObserver[] = [];
    if (before) {
      const beforeObserver = new IntersectionObserver(([entry]) => {
        beforeVis = entry.isIntersecting;
      }, { threshold: 0.2 });
      beforeObserver.observe(before);
      observers.push(beforeObserver);
    }
    void (async () => {
      if (!before) return;
      const tabs = [...before.querySelectorAll<SVGGElement>(".tb[data-x]")];
      const cursor = before.querySelector<SVGGElement>("#cursor");
      const pop = before.querySelector("#popG");
      const popT = before.querySelector("#popT");
      const count = before.querySelector("#cpCount");
      let index = 0;
      let pastes = 0;
      while (!cancelled) {
        await sleep(1100);
        if (!beforeVis || tabs.length === 0) continue;
        const order = [0, 5, 1, 5, 3, 5, 2, 5, 4, 5, 6];
        const tab = tabs[order[index % order.length] % tabs.length];
        index++;
        tabs.forEach((tabEl) => tabEl.classList.remove("hot"));
        tab.classList.add("hot");
        if (cursor) cursor.style.transform = `translate(${tab.dataset.x}px, ${tab.dataset.y}px)`;
        await sleep(850);
        if (cancelled) return;
        const text = tab.textContent ?? "";
        const isClip = text.includes("CLIPBOARD");
        if (popT) popT.textContent = isClip ? "⌘V PASTE" : text.includes("???") ? "¯\\_(ツ)_/¯" : "⌘C COPY";
        pop?.setAttribute("opacity", "1");
        if (isClip && count) {
          pastes++;
          count.textContent = String(pastes);
        }
        await sleep(500);
        pop?.setAttribute("opacity", "0");
      }
    })();
    void (async () => {
      if (!after) return;
      const pk = after.querySelector("#pk");
      const pkg = after.querySelector("#pkg");
      const label = after.querySelector("#sl1");
      const core = after.querySelector("#bcore");
      const res = after.querySelector("#resBox");
      const runCount = after.querySelector("#runCount");
      let runs = 0;
      const move = (from: number, to: number, duration: number) =>
        new Promise<void>((resolve) => {
          const start = performance.now();
          const frame = (now: number) => {
            if (cancelled) return resolve();
            const progress = Math.min(1, (now - start) / duration);
            const eased = progress < 0.5 ? 2 * progress * progress : 1 - Math.pow(-2 * progress + 2, 2) / 2;
            const x = from + (to - from) * eased;
            pk?.setAttribute("cx", String(x));
            pkg?.setAttribute("cx", String(x));
            if (progress < 1) requestAnimationFrame(frame);
            else resolve();
          };
          pk?.setAttribute("opacity", "1");
          pkg?.setAttribute("opacity", ".25");
          requestAnimationFrame(frame);
        });
      new IntersectionObserver(([entry]) => {
        afterVis = entry.isIntersecting;
      }, { threshold: 0.2 }).observe(after);
      await sleep(1600);
      while (!cancelled) {
        if (!afterVis) {
          await sleep(500);
          continue;
        }
        if (label) {
          label.textContent = "prompt → router";
          label.classList.remove("on");
        }
        await move(70, 200, 900);
        pk?.setAttribute("opacity", "0");
        pkg?.setAttribute("opacity", "0");
        core?.classList.add("hit");
        if (label) {
          label.textContent = "GPT · interpret";
          label.classList.add("on");
        }
        await sleep(800);
        if (label) label.textContent = "Claude · execute";
        await sleep(900);
        core?.classList.remove("hit");
        if (label) label.textContent = "settled ✓";
        await move(320, 450, 800);
        pk?.setAttribute("opacity", "0");
        pkg?.setAttribute("opacity", "0");
        res?.classList.add("hit");
        runs++;
        if (runCount) runCount.textContent = String(runs);
        await sleep(600);
        res?.classList.remove("hit");
        await sleep(900);
      }
    })();
    return () => {
      cancelled = true;
      observers.forEach((observer) => observer.disconnect());
    };
  }, []);

  // ---- builders tabs + typing loop + embers + roadmap ----
  const [codeTab, setCodeTab] = useState(0);
  const [typed, setTyped] = useState("");
  const embers = useMemo(
    () =>
      Array.from({ length: 18 }, (_, i) => ({
        id: i,
        left: `${40 + ((i * 53) % 58)}%`,
        duration: `${3 + ((i * 37) % 40) / 10}s`,
        delay: `${((i * 29) % 50) / 10}s`,
        dx: `${((i * 41) % 60) - 30}px`,
      })),
    [],
  );
  useEffect(() => {
    let cancelled = false;
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    void (async () => {
      const lines = [
        "Turn my notes into a launch thread…",
        "Explain this contract in plain words…",
        "Make an 8s teaser for my app…",
        "Fix the bug in this function…",
      ];
      let index = 0;
      while (!cancelled) {
        const line = lines[index % lines.length];
        index++;
        for (const char of line) {
          if (cancelled) return;
          setTyped((prev) => prev + char);
          await sleep(38);
        }
        await sleep(1600);
        while (!cancelled) {
          let done = false;
          setTyped((prev) => {
            if (prev.length === 0) {
              done = true;
              return prev;
            }
            return prev.slice(0, -1);
          });
          if (done) break;
          await sleep(14);
        }
        await sleep(300);
      }
    })();
    const road = document.getElementById("road");
    const observer = road
      ? new IntersectionObserver(([entry], obs) => {
          if (entry.isIntersecting) {
            road.style.setProperty("--rp", "25%");
            obs.disconnect();
          }
        }, { threshold: 0.4 })
      : null;
    if (road && observer) observer.observe(road);
    return () => {
      cancelled = true;
      observer?.disconnect();
    };
  }, []);

  // ---- console demo ----
  const consoleRef = useRef<HTMLDivElement | null>(null);
  const [consoleKey, setConsoleKey] = useState("refine");
  const [consoleHood, setConsoleHood] = useState(false);
  const consoleToken = useRef(0);
  const [consoleState, setConsoleState] = useState({
    prompt: "",
    router: false as boolean,
    nodes: [] as Array<{ who: string; role: string; status: string }>,
    brief: "",
    briefHtml: "",
    out: "",
    code: false,
    media: false,
    progress: 0,
    cost: "0.00",
    balance: "2,400.00",
  });
  useEffect(() => {
    let cancelled = false;
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const order = ["refine", "research", "code", "video"];
    let manual = false;
    let current = "refine";
    let started = false;
    let inView = false;
    async function run(key: string, token: number, manualPick: boolean) {
      const scenario = key === "visual" || key === "launch_kit" ? CONSOLE_SCENARIOS.video : CONSOLE_SCENARIOS[key];
      if (!scenario) return;
      const alive = () => !cancelled && token === consoleToken.current;
      setConsoleKey(key);
      setConsoleState((prev) => ({ ...prev, prompt: "", router: false, nodes: [], brief: "", briefHtml: "", out: "", code: false, media: false, progress: 0, cost: "0.00" }));
      await sleep(300);
      for (const char of scenario.prompt) {
        if (!alive()) return;
        setConsoleState((prev) => ({ ...prev, prompt: prev.prompt + char }));
        await sleep(22);
      }
      await sleep(350);
      if (!alive()) return;
      setConsoleState((prev) => ({
        ...prev,
        router: true,
        nodes: scenario.steps.map(([who, role]) => ({ who, role, status: "pending" })),
      }));
      await sleep(500);
      if (!alive()) return;
      if (scenario.media) {
        await sleep(1500);
        if (!alive()) return;
      }
      for (let i = 0; i < scenario.steps.length; i++) {
        if (!alive()) return;
        setConsoleState((prev) => ({
          ...prev,
          nodes: prev.nodes.map((node, index) => ({ ...node, status: index === i ? "run" : index < i ? "done" : "pending" })),
        }));
        const last = i === scenario.steps.length - 1;
        if (i === 0) {
          await sleep(1100);
          if (!alive()) return;
          setConsoleState((prev) => ({ ...prev, brief: scenario.brief, briefHtml: scenario.brief }));
        }
        if (last && scenario.media) {
          setConsoleState((prev) => ({ ...prev, media: true, progress: 0 }));
          const start = performance.now();
          const duration = 2600;
          await new Promise<void>((resolve) => {
            const frame = (now: number) => {
              if (!alive()) return resolve();
              const progress = Math.min(1, (now - start) / duration);
              setConsoleState((prev) => ({ ...prev, progress }));
              if (progress < 1) requestAnimationFrame(frame);
              else resolve();
            };
            requestAnimationFrame(frame);
          });
          if (!alive()) return;
          setConsoleState((prev) => ({ ...prev, out: scenario.out }));
        } else if (last) {
          let typed = "";
          for (let c = 0; c < scenario.out.length; c += 3) {
            if (!alive()) return;
            typed = scenario.out.slice(0, c + 3);
            const snapshot = typed;
            setConsoleState((prev) => ({ ...prev, out: snapshot, code: Boolean(scenario.code) }));
            await sleep(14);
          }
        } else {
          await sleep(i === 0 ? 300 : 1300);
        }
        if (!alive()) return;
        setConsoleState((prev) => ({
          ...prev,
          nodes: prev.nodes.map((node, index) => ({ ...node, status: index <= i ? "done" : "pending" })),
          cost: ((scenario.cost * (i + 1)) / scenario.steps.length).toFixed(2),
        }));
      }
      setConsoleState((prev) => ({ ...prev, balance: (2400 - scenario.cost).toFixed(2) }));
      void manualPick;
    }
    async function loop() {
      let index = 0;
      while (!cancelled) {
        const token = ++consoleToken.current;
        if (!manual) current = order[index % order.length];
        await run(current, token, manual);
        if (token !== consoleToken.current) return;
        await sleep(manual ? 6000 : 3200);
        if (token !== consoleToken.current) return;
        if (manual) {
          manual = false;
          index = order.indexOf(current);
        }
        index++;
        while (!inView) {
          await sleep(400);
          if (token !== consoleToken.current) return;
        }
      }
    }
    const observer = new IntersectionObserver(([entry]) => {
      inView = entry.isIntersecting;
      if (inView && !started) {
        started = true;
        void loop();
      }
    }, { threshold: 0.25 });
    const el = consoleRef.current;
    if (el) observer.observe(el);
    setConsolePicker((key: string) => {
      manual = true;
      current = key;
      consoleToken.current++;
      void loop();
    });
    return () => {
      cancelled = true;
      observer.disconnect();
      setConsolePicker(undefined);
    };
  }, []);

  const scenario = CONSOLE_SCENARIOS[consoleKey] ?? CONSOLE_SCENARIOS.refine;
  const { data: availability } = useFormationAvailability();
  /**
   * Ketersediaan dari endpoint publik diprioritaskan: pengunjung anonim tidak
   * memuat `/v1/recipes` (butuh sesi), sehingga tanpa itu kartu formasi media
   * akan tampak bisa diklik padahal server menolaknya. `undefined` (endpoint
   * belum termuat atau gagal) diperlakukan sebagai tersedia — jangan menandai
   * "coming soon" tanpa dasar dari server.
   */
  const formations = useMemo(() => {
    const byId = new Map((availability?.formations ?? []).map((item) => [item.id, item.available]));
    return toDisplayRecipes(recipesData?.recipes, FALLBACK_FORMATIONS).map((recipe) => ({
      ...recipe,
      available: byId.get(recipe.id) ?? recipe.available,
    }));
  }, [recipesData, availability]);

  return (
    <>
      {/* ============ HERO ============ */}
      <section className="hero">
        <div className={`stage${locked ? " locked" : ""}`} id="stage" ref={stageRef} onPointerMove={onStagePointerMove} onPointerLeave={() => { if (wrapRef.current) wrapRef.current.style.transform = ""; }}>
          <div className="grid"></div>
          <div className="scan"></div>
          <span className="cross" style={{ left: "22%", top: "12%" }}></span>
          <span className="cross" style={{ left: "78%", top: "14%" }}></span>
          <span className="cross" style={{ left: "12%", top: "46%" }}></span>
          <span className="cross" style={{ left: "88%", top: "52%" }}></span>
          <span className="cross" style={{ left: "30%", top: "80%" }}></span>
          <span className="cross" style={{ left: "70%", top: "84%" }}></span>
          <div className="stagebar">
            <span>
              合体 / GATTAI : <b id="lockstate">{lockState}</b>
            </span>
            <span>4 MODULES · 1 KEY · 1 RESULT</span>
            <span id="cycleN">CYCLE {String(cycle).padStart(3, "0")}</span>
          </div>
          <div className="halo"></div>

          <svg className="conduits" id="conduits" aria-hidden="true">
            <path className="c" id="cp1" />
            <path className="f" id="cf1" />
            <path className="c" id="cp2" />
            <path className="f" id="cf2" />
            <circle className="end" id="ce1" r="3" />
            <circle className="end" id="ce2" r="3" />
            <circle className="pk" r="3">
              <animateMotion dur="2.4s" repeatCount="indefinite">
                <mpath href="#cp1" />
              </animateMotion>
            </circle>
            <circle className="pk" r="3">
              <animateMotion dur="2.4s" begin="1.2s" repeatCount="indefinite">
                <mpath href="#cp2" />
              </animateMotion>
            </circle>
          </svg>

          <div className="feed" id="heroFeed" aria-hidden="true">
            <h5>
              <span>
                <i></i>LIVE RUNS
              </span>
              <span>DEMO FEED</span>
            </h5>
            <ul id="feedList">
              {feed.map((item) => (
                <li key={item.id}>
                  <span>{item.id}</span>
                  <span className="r">{item.recipe}</span>
                  <span className="s">{item.cost}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="giant g1" data-split aria-hidden="true">
            <Split text="SEPARATE" />
          </div>
          <div
            className="unitwrap"
            id="heroUnitWrap"
            ref={wrapRef}
            tabIndex={0}
            role="button"
            aria-label="Re-dock the formation"
            onClick={() => void redock(true)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                void redock(true);
              }
            }}
          >
            <svg
              className={`unit${apart ? " apart" : ""}${lockFlash ? " lockflash" : ""}`}
              id="heroUnit"
              ref={unitRef}
              viewBox="0 0 400 400"
              role="img"
              aria-label="Four AI modules docking into one unit"
            >
              <circle className="glow" cx="200" cy="200" r="190" fill="url(#glowGrad)" />
              <g className="dial">
                <circle cx="200" cy="200" r="226" fill="none" stroke="rgba(236,233,226,.13)" strokeDasharray="1 7" />
                <circle cx="200" cy="200" r="240" fill="none" stroke="rgba(255,91,31,.45)" strokeWidth="1.2" strokeDasharray="60 320 14 360" />
              </g>
              <path className="hud" d="M-4 34 V-4 H34" />
              <path className="hud" d="M366 -4 H404 V34" />
              <path className="hud" d="M-4 366 V404 H34" />
              <path className="hud" d="M366 404 H404 V366" />
              <g className="mod m1">
                <use href="#modArt" />
                <text className="lab" x="40" y="160">01 / INTERPRET</text>
                <text className="lab2" x="40" y="174">GPT · BRIEF</text>
              </g>
              <g className="mod m2">
                <use href="#modArt" transform="translate(400 0) scale(-1 1)" />
                <text className="lab" x="268" y="160">02 / EXECUTE</text>
                <text className="lab2" x="268" y="174">CLAUDE · CORE</text>
              </g>
              <g className="mod m3">
                <use href="#modArt" transform="translate(0 400) scale(1 -1)" />
                <text className="lab" x="40" y="246">03 / RESEARCH</text>
                <text className="lab2" x="40" y="260">SONAR · SOURCES</text>
              </g>
              <g className="mod m4">
                <use href="#modArt" transform="translate(400 400) scale(-1 -1)" />
                <text className="lab" x="268" y="246">04 / RENDER</text>
                <text className="lab2" x="268" y="260">MEDIA · VIDEO</text>
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
          <div className="giant g2" aria-hidden="true">
            <b data-split style={{ ["--d" as string]: ".55s" }}>
              <Split text="ONE" delay={0.55} />
            </b>{" "}
            <span className="ol" data-t="FORMATION" data-split style={{ ["--d" as string]: ".75s" }}>
              <Split text="FORMATION" delay={0.75} />
            </span>
          </div>

          <div className="tag t1 floatA" id="tag1">
            <div className="ic">
              <svg viewBox="0 0 16 16" fill="none" stroke="#ff5b1f" strokeWidth="1.4">
                <circle cx="5" cy="8" r="3" />
                <path d="M8 8h7M12 8v3M14.5 8v2" />
              </svg>
            </div>
            <div>
              <small>One key</small>
              <b>gtt_live_••••</b>
            </div>
          </div>
          <div className="tag t2 floatB" id="tag2">
            <div>
              <small>Active formation</small>
              <b id="activeF">{activeFormation}</b>
            </div>
            <div className="ic">
              <svg viewBox="0 0 16 16">
                <use href="#logo" />
              </svg>
            </div>
          </div>
          <div className="hint">TAP THE CORE TO RE-DOCK</div>
        </div>

        <div className="cards">
          <div className="hc l">
            <div className="icons">
              <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M9 4.5 10.3 7.7 13.5 9 10.3 10.3 9 13.5 7.7 10.3 4.5 9 7.7 7.7Z" fill="currentColor" />
              </svg>
              <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M6 5 2 9l4 4M12 5l4 4-4 4" />
              </svg>
            </div>
            <p className="lead">Every prompt runs through a team of AI models: each doing what it does best.</p>
            <Link to="/#how" className="more">
              How it works →
            </Link>
          </div>
          <div className="hc c">
            <div className="chip">
              <svg width="20" height="20">
                <use href="#logo" />
              </svg>
            </div>
            <h1 className="heroh">
              Separate machines.<br />
              One formation.
            </h1>
            <p>
              One key. Every prompt runs through a team of AI models and comes back as one result. Settled on
              Robinhood Chain.
            </p>
            <div className="row">
              <Link to="/app/chat" className="btn btn-ink">
                Launch App
              </Link>
              <Link to="/app/keys" className="btn btn-o">
                Get your key
              </Link>
            </div>
          </div>
          <div className="hc r">
            <div className="burnline">
              <span className="flame"></span>Burned from usage so far<span className="prev">API</span>
            </div>
            <div className="burnnum">
              <span data-count={Math.round(burnTotal)} className="liveburn">
                {Math.round(burnTotal).toLocaleString("en-US")}
              </span>
              <small>GATTAI</small>
            </div>
            <div className="ca">
              <span>CA · TBA at launch</span>
              <button data-copy="TBA">Copy</button>
            </div>
            <div className="built">Built on Robinhood Chain</div>
          </div>
        </div>
      </section>

      <div className="marquee" aria-hidden="true">
        <div className="tr">
          {[0, 1].map((half) => (
            <span key={half} style={{ display: "contents" }}>
              {["gattai/refine", "gattai/research", "gattai/code", "gattai/visual", "gattai/video", "gattai/launch_kit"].map(
                (name) => (
                  <span key={`${half}-${name}`} style={{ display: "contents" }}>
                    <span>{name}</span>
                    <span className="k">合体</span>
                  </span>
                ),
              )}
            </span>
          ))}
        </div>
      </div>

      {/* ============ HOW ============ */}
      <section className="how" id="how" ref={howRef}>
        <div className="pin">
          <div className="left">
            <span className="eyebrow">How it works</span>
            <h2 className="h2">
              Three moves.<br />
              <em>One</em> machine.
            </h2>
            <div className="steps">
              <div className="step on">
                <div className="n">STEP 01 / 03</div>
                <h3>Get one key.</h3>
                <p>
                  One project, one credit balance. Top up on Robinhood Chain with ETH, USDG, or $GATTAI, and
                  get a better rate with $GATTAI.
                </p>
                <div className="chips">
                  <span className="pill">ETH</span>
                  <span className="pill">USDG</span>
                  <span className="pill a">$GATTAI −15%</span>
                </div>
              </div>
              <div className="step">
                <div className="n">STEP 02 / 03</div>
                <h3>Pick a recipe, or just type.</h3>
                <p>
                  A lightweight router reads your prompt and suggests the right formation. Override it any
                  time.
                </p>
                <div className="chips">
                  <span className="pill a">refine</span>
                  <span className="pill">research</span>
                  <span className="pill">code</span>
                  <span className="pill">visual</span>
                  <span className="pill">video</span>
                  <span className="pill">launch_kit</span>
                </div>
              </div>
              <div className="step">
                <div className="n">STEP 03 / 03</div>
                <h3>Watch them combine.</h3>
                <p>
                  Each model hands off to the next. You get one result, and if you want, every step in the
                  chain and what it cost.
                </p>
                <div className="chips">
                  <span className="pill">GPT · interpret</span>
                  <span className="pill">→</span>
                  <span className="pill a">Claude · execute</span>
                </div>
              </div>
            </div>
            <div className="prog" id="howProg">
              <i>
                <b></b>
              </i>
              <i>
                <b></b>
              </i>
              <i>
                <b></b>
              </i>
            </div>
          </div>
          <div className="right">
            <div className="frame"></div>
            <span className="corner a">FORMATION BAY</span>
            <span className="corner b" id="howPct">
              000%
            </span>
            <span className="corner c">RUN STATE</span>
            <span className="corner d" id="howState">
              CREATED
            </span>
            <div className="keychip">
              KEY <b>gtt_live_7f3a…c91</b> · 2,400 CR
            </div>
            <svg className="unit apart" id="howUnit" viewBox="0 0 400 400" role="img" aria-label="Four AI modules docking into one unit">
              <circle className="glow" cx="200" cy="200" r="190" fill="url(#glowGrad)" />
              <g className="dial">
                <circle cx="200" cy="200" r="226" fill="none" stroke="rgba(236,233,226,.13)" strokeDasharray="1 7" />
                <circle cx="200" cy="200" r="240" fill="none" stroke="rgba(255,91,31,.45)" strokeWidth="1.2" strokeDasharray="60 320 14 360" />
              </g>
              <path className="hud" d="M-4 34 V-4 H34" />
              <path className="hud" d="M366 -4 H404 V34" />
              <path className="hud" d="M-4 366 V404 H34" />
              <path className="hud" d="M366 404 H404 V366" />
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
            <div className="outchip" id="outchip">
              ONE RESULT ✓
            </div>
          </div>
        </div>
      </section>

      {/* ============ BEFORE / AFTER ============ */}
      <section className="sec" id="ba">
        <div className="wrap">
          <span className="eyebrow" data-r>
            Before / After
          </span>
          <h2 className="h2" data-r="2">
            Stop being the glue <br />
            between five tabs.
          </h2>
          <div className="bawrap">
            <div className="ba">
              <div className="bapanel before" data-r="2" id="baBefore" ref={baBeforeRef}>
                <div className="lbl">
                  <b>Before</b>
                  <span>Manual relay</span>
                </div>
                <h3>Five tabs. Five subscriptions. You, copy-pasting.</h3>
                <ul>
                  <li>Rewrite the prompt by hand for each model</li>
                  <li>Paste output from one into the next</li>
                  <li>Pay five bills for one answer</li>
                </ul>
                <svg className="dia" viewBox="0 0 520 230" aria-hidden="true">
                  <g className="tangle">
                    <path d="M104 30 C 200 200, 260 -40, 420 120" />
                    <path d="M104 110 C 180 10, 330 230, 420 40" />
                    <path d="M104 190 C 240 120, 200 20, 410 190" />
                    <path d="M264 34 C 120 140, 420 140, 270 200" />
                    <path d="M104 30 C 160 120, 360 90, 420 40" />
                    <path d="M104 110 C 250 250, 300 -20, 410 190" />
                    <path d="M104 190 C 140 60, 380 260, 420 120" />
                    <path d="M264 34 C 380 60, 100 100, 410 120" />
                  </g>
                  <g className="tb jit" data-x="60" data-y="30">
                    <rect x="16" y="16" width="88" height="28" rx="6" />
                    <text x="28" y="34">TAB 1 · CHAT</text>
                  </g>
                  <g className="tb jit" data-x="60" data-y="110">
                    <rect x="16" y="96" width="88" height="28" rx="6" />
                    <text x="28" y="114">TAB 2 · CODE</text>
                  </g>
                  <g className="tb jit" data-x="60" data-y="190">
                    <rect x="16" y="176" width="96" height="28" rx="6" />
                    <text x="26" y="194">TAB 3 · SEARCH</text>
                  </g>
                  <g className="tb jit" data-x="264" data-y="20">
                    <rect x="216" y="6" width="96" height="28" rx="6" />
                    <text x="228" y="24">TAB 4 · IMAGE</text>
                  </g>
                  <g className="tb jit" data-x="458" data-y="120">
                    <rect x="410" y="106" width="96" height="28" rx="6" />
                    <text x="422" y="124">TAB 5 · VIDEO</text>
                  </g>
                  <g className="tb jit" data-x="463" data-y="40">
                    <rect x="420" y="26" width="86" height="28" rx="6" />
                    <text x="434" y="44">CLIPBOARD</text>
                  </g>
                  <g className="tb" data-x="458" data-y="190">
                    <rect x="410" y="176" width="96" height="28" rx="6" />
                    <text x="424" y="194">??? RESULT</text>
                  </g>
                  <g className="cursor" id="cursor" style={{ transform: "translate(60px,30px)" }}>
                    <path d="M0 0 L0 15 L4 11 L7 18 L9.5 17 L6.5 10 L12 10 Z" fill="#ece9e2" stroke="#08090b" strokeWidth="1" />
                    <g id="popG" opacity="0">
                      <rect x="10" y="-22" width="52" height="16" rx="4" fill="#ff8a4c" />
                      <text className="pop" id="popT" x="16" y="-11">
                        ⌘C COPY
                      </text>
                    </g>
                  </g>
                </svg>
                <div className="bastats">
                  <div>
                    <b id="cpCount">0</b>
                    <span>pastes</span>
                  </div>
                  <div>
                    <b>5</b>
                    <span>tabs open</span>
                  </div>
                  <div>
                    <b>5</b>
                    <span>bills</span>
                  </div>
                </div>
              </div>

              <div className="bapanel after ba-a" data-r="3" id="baAfter" ref={baAfterRef}>
                <div className="lbl">
                  <b>After</b>
                  <span>One formation</span>
                </div>
                <h3>One prompt. One formation. One answer.</h3>
                <ul>
                  <li>Type once: the brief is built for you</li>
                  <li>Models hand off automatically</li>
                  <li>One balance, every step itemised</li>
                </ul>
                <svg className="dia" viewBox="0 0 520 230" aria-hidden="true">
                  <g className="flow">
                    <path className="base" d="M124 110 H 188" />
                    <path className="f" d="M124 110 H 188" />
                    <path className="base" d="M332 110 H 396" />
                    <path className="f" d="M332 110 H 396" />
                  </g>
                  <g className="tb">
                    <rect x="16" y="90" width="108" height="40" rx="8" />
                    <text x="32" y="114">YOUR PROMPT</text>
                  </g>
                  <g transform="translate(188 38) scale(.36)">
                    <circle cx="200" cy="200" r="250" fill="none" stroke="rgba(236,233,226,.12)" strokeDasharray="2 8" strokeWidth="2.5" />
                    <g className="bq bq1">
                      <use href="#modArt" />
                    </g>
                    <g className="bq bq2">
                      <use href="#modArt" transform="translate(400 0) scale(-1 1)" />
                    </g>
                    <g className="bq bq3">
                      <use href="#modArt" transform="translate(0 400) scale(1 -1)" />
                    </g>
                    <g className="bq bq4">
                      <use href="#modArt" transform="translate(400 400) scale(-1 -1)" />
                    </g>
                    <g className="bcore" id="bcore">
                      <circle cx="200" cy="200" r="56" fill="#1a0c06" stroke="#ff5b1f" strokeWidth="3" />
                      <text x="200" y="214" textAnchor="middle" style={{ font: "900 40px var(--jp)", fill: "#ff5b1f" }}>
                        合体
                      </text>
                    </g>
                  </g>
                  <g className="res tb" id="resBox">
                    <rect x="396" y="90" width="108" height="40" rx="8" style={{ fill: "#ff5b1f", stroke: "none" }} />
                    <text x="414" y="114" style={{ font: "600 9.5px var(--mono)", fill: "#140700", letterSpacing: ".06em" }}>
                      ONE RESULT ✓
                    </text>
                  </g>
                  <text className="steplab" id="sl1" x="260" y="214" textAnchor="middle">
                    waiting for prompt
                  </text>
                  <circle className="pkglow" id="pkg" r="9" cx="70" cy="110" opacity="0" />
                  <circle className="pk" id="pk" r="4" cx="70" cy="110" opacity="0" />
                </svg>
                <div className="bastats">
                  <div>
                    <b>1</b>
                    <span>prompt</span>
                  </div>
                  <div>
                    <b>1</b>
                    <span>key</span>
                  </div>
                  <div>
                    <b id="runCount">0</b>
                    <span>results settled</span>
                  </div>
                </div>
              </div>
            </div>
            <div className="vs">VS</div>
          </div>
        </div>
      </section>

      {/* ============ CONSOLE ============ */}
      <section className="sec" id="console">
        <div className="wrap">
          <span className="eyebrow" data-r>
            Live formation
          </span>
          <h2 className="h2" data-r="2">
            Watch a run, <em>step by step.</em>
          </h2>
          <p className="lede" data-r="3">
            Every request is a run. Every run is a chain. Flip “Under the hood” to see the brief each step
            hands to the next, and what it cost.
          </p>
          <div className="console" data-r="3" ref={consoleRef}>
            <div className="cbar">
              <div className="lights">
                <i></i>
                <i></i>
                <i></i>
              </div>
              <div className="ttl">
                gattai-console : <span id="cTitle">{consoleKey}</span>.run
              </div>
              <div className="bal">
                Balance <b id="cBal">{consoleState.balance}</b> cr
              </div>
            </div>
            <div className="cbody">
              <aside className="cside">
                <h6>Formations</h6>
                {["refine", "research", "code", "visual", "video", "launch_kit"].map((key) => (
                  <button
                    key={key}
                    className={`rec${consoleKey === key ? " on" : ""}`}
                    data-k={key}
                    onClick={() => {
                      getConsolePicker()?.(key);
                    }}
                  >
                    {key === "launch_kit" ? "Launch Kit" : key[0].toUpperCase() + key.slice(1)}{" "}
                    <small>
                      {key === "refine" || key === "research" ? "2 steps" : key === "code" ? "3 steps" : key === "launch_kit" ? "mixed" : "async"}
                    </small>
                  </button>
                ))}
                <div className="hood">
                  Under the hood{" "}
                  <button
                    className={`sw${consoleHood ? " on" : ""}`}
                    id="hoodSw"
                    aria-label="Toggle under the hood"
                    onClick={() => setConsoleHood((value) => !value)}
                  ></button>
                </div>
              </aside>
              <div className="cmain">
                <div className="cfeed">
                  <div className="umsg">
                    <span id="utext">{consoleState.prompt}</span>
                    <span className="cur"></span>
                  </div>
                  <div className={`lrouter${consoleState.router ? " on" : ""}`} id="router">
                    ROUTER → suggests <b id="routerK">{scenario.route[0]}</b> · confidence{" "}
                    <span id="routerC">{scenario.route[1]}</span>
                  </div>
                  <div className="ltrack" id="track">
                    {consoleState.nodes.map((node, index) => (
                      <span key={node.role} style={{ display: "contents" }}>
                        {index > 0 && <div className={`llink${node.status !== "pending" ? " on" : ""}`}></div>}
                        <div className={`lnode${node.status === "run" ? " run" : node.status === "done" ? " done" : ""}`}>
                          <span className="st2"></span>
                          <div>
                            <div className="who">{node.who}</div>
                            <div className="role">{node.role}</div>
                          </div>
                        </div>
                      </span>
                    ))}
                  </div>
                  <pre className={`brief${consoleHood && consoleState.brief ? " show" : ""}`} id="brief">
                    {consoleState.brief}
                  </pre>
                  <div className="out" id="out">
                    {consoleState.out}
                  </div>
                </div>
                <div className="cfoot">
                  <span className="inp2">Type a prompt, or pick a formation…</span>
                  <span className="cost">
                    Σ <b id="cCost">{consoleState.cost}</b> cr
                  </span>
                  <span className="sendb">
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#140700" strokeWidth="2">
                      <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />
                    </svg>
                  </span>
                </div>
              </div>
            </div>
          </div>
          <div className="tryapp" data-r>
            <Link to="/app/chat" className="btn btn-acc">
              Try it in the app →
            </Link>
          </div>
        </div>
      </section>

      {/* ============ RECIPES ============ */}
      <section className="sec" id="recipes">
        <div className="wrap">
          <span className="eyebrow" data-r>
            Formations
          </span>
          <h2 className="h2" data-r="2">
            Six formations at launch.
          </h2>
          <p className="lede" data-r="3">
            Each formation is a recipe: an ordered chain of models, each with one job. Models live in config,
            so the line-up can improve without changing how you work.
          </p>
          <FormationCards formations={formations} />
        </div>
      </section>

      {/* ============ BUILDERS ============ */}
      <section className="sec" id="builders">
        <div className="wrap">
          <div className="builderh">
            <div>
              <span className="eyebrow" data-r>
                Built for two kinds of users
              </span>
              <h2 className="h2" data-r="2">
                Call a formation <br />
                like any model.
              </h2>
            </div>
            <p className="lede" data-r="3" style={{ maxWidth: 380 }}>
              Builders drop the key into their tools. Everyone else just types.{" "}
              <Link to="/docs" style={{ color: "var(--acc)" }}>
                Read the docs →
              </Link>
            </p>
          </div>
          <div className="two">
            <div className="codep" data-r="2">
              <div className="tabs">
                {["cURL", "TypeScript", "run.json"].map((tab, index) => (
                  <button key={tab} data-t={index} className={codeTab === index ? "on" : undefined} onClick={() => setCodeTab(index)}>
                    {tab}
                  </button>
                ))}
                <span className="ver">/v1 · OpenAI-compatible</span>
              </div>
              <pre className={codeTab === 0 ? "on" : undefined}>
                <span className="c1"># any OpenAI-compatible client works: swap the base URL</span>
                {"\ncurl https://api.gattai.example/v1/chat/completions \\"}
                {"\n  "}-H <span className="c3">&quot;Authorization: Bearer gtt_live_••••&quot;</span> \
                {"\n  "}-H <span className="c3">&quot;Idempotency-Key: 6f1c…&quot;</span> \
                {"\n  "}-d <span className="c3">&apos;&#123;
                  {"\n    "}&quot;model&quot;: &quot;<span className="c2">gattai/research</span>&quot;,
                  {"\n    "}&quot;stream&quot;: true,
                  {"\n    "}&quot;messages&quot;: [
                  {"\n      "}&#123; &quot;role&quot;: &quot;user&quot;, &quot;content&quot;: &quot;State of L2 fee markets, cited&quot; &#125;
                  {"\n    "}]
                  {"\n  "}&#125;&apos;</span>
              </pre>
              <pre className={codeTab === 1 ? "on" : undefined}>
                <span className="c4">import</span> OpenAI <span className="c4">from</span>{" "}
                <span className="c3">&quot;openai&quot;</span>;{"\n\n"}
                <span className="c4">const</span> gattai = <span className="c4">new</span> OpenAI(&#123;{"\n"}
                {"  "}baseURL: <span className="c3">&quot;https://api.gattai.example/v1&quot;</span>,{"\n"}
                {"  "}apiKey: process.env.GATTAI_KEY, <span className="c1">// gtt_live_…</span>
                {"\n"}&#125;);{"\n\n"}
                <span className="c4">const</span> res = <span className="c4">await</span> gattai.chat.completions.create(&#123;{"\n"}
                {"  "}model: <span className="c3">&quot;<span className="c2">gattai/code</span>&quot;</span>,{"   "}
                <span className="c1">// write → review → fix</span>
                {"\n  "}messages: [&#123; role: <span className="c3">&quot;user&quot;</span>, content:{" "}
                <span className="c3">&quot;debounce hook w/ cancel()&quot;</span> &#125;],{"\n"}
                &#125;);
              </pre>
              <pre className={codeTab === 2 ? "on" : undefined}>
                &#123;{"\n"}
                {"  "}<span className="c4">&quot;id&quot;</span>: <span className="c3">&quot;run_01HZX…&quot;</span>,
                {"\n"}
                {"  "}<span className="c4">&quot;recipe&quot;</span>: <span className="c3">&quot;<span className="c2">code</span>&quot;</span>,
                {"\n"}
                {"  "}<span className="c4">&quot;status&quot;</span>: <span className="c3">&quot;SETTLED&quot;</span>,
                {"\n"}
                {"  "}<span className="c4">&quot;steps&quot;</span>: [&#123;{"\n"}
                {"    "}&#123; <span className="c4">&quot;id&quot;</span>: <span className="c3">&quot;write&quot;</span>,{"  "}
                <span className="c4">&quot;provider&quot;</span>: <span className="c3">&quot;anthropic&quot;</span>,{" "}
                <span className="c4">&quot;status&quot;</span>: <span className="c3">&quot;COMPLETE&quot;</span> &#125;,
                {"\n"}
                {"    "}&#123; <span className="c4">&quot;id&quot;</span>: <span className="c3">&quot;review&quot;</span>,{" "}
                <span className="c4">&quot;provider&quot;</span>: <span className="c3">&quot;openai&quot;</span>,{"    "}
                <span className="c4">&quot;status&quot;</span>: <span className="c3">&quot;COMPLETE&quot;</span> &#125;,
                {"\n"}
                {"    "}&#123; <span className="c4">&quot;id&quot;</span>: <span className="c3">&quot;fix&quot;</span>,{"    "}
                <span className="c4">&quot;provider&quot;</span>: <span className="c3">&quot;anthropic&quot;</span>,{" "}
                <span className="c4">&quot;status&quot;</span>: <span className="c3">&quot;COMPLETE&quot;</span> &#125;
                {"\n  "}],{"\n"}
                {"  "}<span className="c4">&quot;charged_credits&quot;</span>: 18.4{"\n"}&#125;
              </pre>
            </div>
            <div className="easy chamfer" data-r="3">
              <span className="bigjp">合</span>
              <span className="eyebrow">Everyone else</span>
              <h3>
                No setup.<br />
                Just type.
              </h3>
              <p>
                Open the app, write what you want, and GATTAI picks the formation. You see one answer, and
                the chain behind it only if you ask.
              </p>
              <Link to={appCtaHref} className="fakeinput">
                <span id="easyType">{typed}</span>
                <span className="sendb">
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="#140700" strokeWidth="2">
                    <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />
                  </svg>
                </span>
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* ============ TOKEN ============ */}
      <section className="sec" id="token">
        <div className="wrap">
          <span className="eyebrow" data-r>
            $GATTAI
          </span>
          <h2 className="h2" data-r="2">
            Designed for usage-funded burns. <br />
            <em>Public every epoch.</em>
          </h2>
          <p className="lede" data-r="3">
            Pay with $GATTAI for a better rate. When burn epochs are active, a share of settled usage
            margin buys back and burns $GATTAI, and every transaction is published onchain. Burns are
            activated only after the token, liquidity and audit gates are met.
          </p>
          <div className="tok">
            <div className="box bigburn" data-r="2">
              <div className="embers" id="embers">
                {embers.map((ember) => (
                  <i
                    key={ember.id}
                    style={{ left: ember.left, animationDuration: ember.duration, animationDelay: ember.delay, ["--dx" as string]: ember.dx }}
                  ></i>
                ))}
              </div>
              <h4>
                Total burned from usage so far <span className="prev">LIVE API</span>
              </h4>
              <Link to="/burns" className="more">
                Burn dashboard →
              </Link>
              <div className="num">
                <span data-count={Math.round(burnTotal)} className="liveburn">
                  {Math.round(burnTotal).toLocaleString("en-US")}
                </span>
              </div>
              <div className="sub">
                <div>
                  Last epoch
                  <b>
                    + <span data-count={Math.round(lastBurned)}>{Math.round(lastBurned)}</span> GATTAI
                  </b>
                </div>
                <div>
                  Epochs
                  <b>
                    <span data-count={burns?.epochs.length ?? 0}>{burns?.epochs.length ?? 0}</span>
                  </b>
                </div>
                <div>
                  Last tx<b>{lastTx}</b>
                </div>
              </div>
            </div>
            <div className="box rate" data-r="3">
              <h4>Illustration · $100 list price</h4>
              <table>
                <tbody>
                  <tr>
                    <th></th>
                    <th>ETH / USDG</th>
                    <th>$GATTAI</th>
                  </tr>
                  <tr>
                    <td>You pay</td>
                    <td>$100</td>
                    <td className="hl">$85</td>
                  </tr>
                  <tr>
                    <td>Provider cost</td>
                    <td>$65</td>
                    <td>$65</td>
                  </tr>
                  <tr>
                    <td>Margin</td>
                    <td>$35</td>
                    <td>$20</td>
                  </tr>
                  <tr>
                    <td>Burn share</td>
                    <td>30%</td>
                    <td>50%</td>
                  </tr>
                  <tr>
                    <td>Burned</td>
                    <td>$10.50</td>
                    <td className="hl">$10.00</td>
                  </tr>
                </tbody>
              </table>
              <p className="note">
                Burns are funded from margin, not gross revenue. Discount, markup and burn shares are config
                values: changes are announced publicly.
              </p>
            </div>
            <div className="box alloc" data-r="2">
              <h4>Allocation · fair launch, ranges pending final numbers</h4>
              <div className="bars">
                <div className="bar2">
                  <div className="lab">
                    Liquidity<span>50–70%</span>
                  </div>
                  <div className="tr" style={{ ["--a" as string]: "50%", ["--w" as string]: "20%" }}>
                    <i></i>
                    <b></b>
                  </div>
                  <small>LP locked</small>
                </div>
                <div className="bar2">
                  <div className="lab">
                    Treasury / operations<span>10–20%</span>
                  </div>
                  <div className="tr" style={{ ["--a" as string]: "10%", ["--w" as string]: "10%" }}>
                    <i></i>
                    <b></b>
                  </div>
                  <small>Vested, use reported</small>
                </div>
                <div className="bar2">
                  <div className="lab">
                    Team<span>5–15%</span>
                  </div>
                  <div className="tr" style={{ ["--a" as string]: "5%", ["--w" as string]: "10%" }}>
                    <i></i>
                    <b></b>
                  </div>
                  <small>Cliff + 12–24 month vesting, onchain</small>
                </div>
                <div className="bar2">
                  <div className="lab">
                    Ecosystem / user rewards<span>5–15%</span>
                  </div>
                  <div className="tr" style={{ ["--a" as string]: "5%", ["--w" as string]: "10%" }}>
                    <i></i>
                    <b></b>
                  </div>
                  <small>Free credits for early users</small>
                </div>
              </div>
            </div>
            <div className="box contract" data-r="3">
              <h4>Contract</h4>
              <div className="kv">
                <span>Network</span>
                <b>Robinhood Chain</b>
              </div>
              <div className="kv">
                <span>Standard</span>
                <b>ERC-20</b>
              </div>
              <div className="kv">
                <span>Supply</span>
                <b>Fixed</b>
              </div>
              <div className="kv">
                <span>Mint function</span>
                <b className="ok">None</b>
              </div>
              <div className="kv">
                <span>Ownership</span>
                <b className="ok">Renounced</b>
              </div>
              <div className="kv">
                <span>Launch</span>
                <b>Fair · no presale</b>
              </div>
              <div className="kv">
                <span>Address</span>
                <b>TBA at launch</b>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ============ ROADMAP ============ */}
      <section className="sec" id="roadmap">
        <div className="wrap">
          <span className="eyebrow" data-r>
            Roadmap
          </span>
          <h2 className="h2" data-r="2">
            From formation <br />
            to autonomous.
          </h2>
          <div className="road" id="road">
            <div className="ph now" data-r="2">
              <div className="p">PHASE 01 · NOW</div>
              <h4>Formation</h4>
              <ul>
                <li>Token launch</li>
                <li>Web app</li>
                <li>6 formations</li>
                <li>Top-ups</li>
                <li>Burn dashboard</li>
              </ul>
            </div>
            <div className="ph" data-r="3">
              <div className="p">PHASE 02</div>
              <h4>Builder</h4>
              <ul>
                <li>OpenAI-compatible API</li>
                <li>Usage analytics</li>
                <li>Spending limits</li>
              </ul>
            </div>
            <div className="ph" data-r="4">
              <div className="p">PHASE 03</div>
              <h4>Custom formations</h4>
              <ul>
                <li>Assemble your own recipes</li>
                <li>Team accounts</li>
                <li>New token utilities</li>
              </ul>
            </div>
            <div className="ph" data-r="5">
              <div className="p">PHASE 04</div>
              <h4>Autonomous</h4>
              <ul>
                <li>Agent workflows</li>
                <li>Scheduled jobs</li>
                <li>Onchain run attestations</li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* ============ FAQ ============ */}
      <section className="sec" id="faq">
        <div className="wrap faqw">
          <div>
            <span className="eyebrow" data-r>
              FAQ
            </span>
            <h2 className="h2" data-r="2">
              Questions, <br />
              answered.
            </h2>
          </div>
          <div data-r="2">
            <details open>
              <summary>
                What is GATTAI?<span className="pm"></span>
              </summary>
              <div className="ans">
                An AI product where one key runs every prompt through a team of models. Each model does one
                job (interpret, research, write, review, render) and you get one combined result.
              </div>
            </details>
            <details>
              <summary>
                What does “gattai” mean?<span className="pm"></span>
              </summary>
              <div className="ans">
                合体 (<i>gattai</i>) is the Japanese term for robots combining into one stronger machine.
                Separate machines, one formation.
              </div>
            </details>
            <details>
              <summary>
                Which AI models are inside?<span className="pm"></span>
              </summary>
              <div className="ans">
                At launch: Claude (Anthropic) as the primary executor, GPT (OpenAI) as prompt architect and
                reviewer, Perplexity Sonar for cited web research, and Higgsfield as the media layer for image
                and video models. Models are set in config, so the line-up can change as better ones ship.
              </div>
            </details>
            <details>
              <summary>
                Why combine models instead of using one?<span className="pm"></span>
              </summary>
              <div className="ans">
                Different models are good at different things. A formation lets each one handle the part it
                does best and hand off to the next. It costs more per request than calling a single model,
                what you&apos;re paying for is the better result.
              </div>
            </details>
            <details>
              <summary>
                How do I top up, and why is $GATTAI cheaper?<span className="pm"></span>
              </summary>
              <div className="ans">
                Connect a wallet and deposit ETH, USDG or $GATTAI on Robinhood Chain. Deposits paid in $GATTAI
                receive a discount (15% at launch, set in config), valued with a time-weighted price rather
                than spot.
              </div>
            </details>
            <details>
              <summary>
                How does buyback &amp; burn work, and where can I verify it?<span className="pm"></span>
              </summary>
              <div className="ans">
                When burn epochs are activated, a share of the margin from settled runs is intended to buy
                back and burn $GATTAI (or burn treasury $GATTAI directly for runs paid in $GATTAI). Every
                executed epoch would be published with its transaction hashes on the{" "}
                <Link to="/burns" style={{ color: "var(--acc)" }}>
                  burn dashboard
                </Link>{" "}
                and at <code>/v1/public/burns</code>. <b>This is not live yet:</b> the token, liquidity and
                buyback executor are gated and have not launched.
              </div>
            </details>
            <details>
              <summary>
                Can I withdraw my credits?<span className="pm"></span>
              </summary>
              <div className="ans">
                Credits are used for runs and are not designed to be withdrawn. The final refund policy will
                be published before launch.
              </div>
            </details>
            <details>
              <summary>
                Is my prompt data stored or used for training?<span className="pm"></span>
              </summary>
              <div className="ans">
                Prompt retention and logging are covered in the{" "}
                <Link to="/legal#privacy" style={{ color: "var(--acc)" }}>
                  privacy policy
                </Link>
                , which will be finalised before launch.
              </div>
            </details>
            <details>
              <summary>
                Can I use my key in Cursor or Claude Code?<span className="pm"></span>
              </summary>
              <div className="ans">
                The OpenAI-compatible endpoint exposes formations as models like <code>gattai/refine</code>,{" "}
                <code>gattai/research</code> and <code>gattai/code</code>. A tested compatibility list for
                specific tools will be published alongside it.
              </div>
            </details>
          </div>
        </div>
      </section>

      <section className="final" data-r>
        <div className="jp" aria-hidden="true">
          合体
        </div>
        <h2>
          Assemble your<br />
          first formation.
        </h2>
        <p>One key. Every model in its place. One result back.</p>
        <div className="row">
          <Link to="/app/chat" className="btn btn-acc">
            Launch App
          </Link>
          <Link to="/app/keys" className="btn btn-dark">
            Get your key
          </Link>
        </div>
      </section>
    </>
  );
}
