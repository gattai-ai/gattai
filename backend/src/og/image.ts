import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import satori from "satori";
import fontFile from "./assets/archivo-var.ttf" with { type: "file" };

/**
 * Generator OG image 1200×630. Font di-vendor di `assets/` supaya render tidak
 * pernah bergantung pada font sistem container (image Docker minimal biasanya
 * tidak punya font sama sekali).
 */

interface VNode {
  type: string;
  props: Record<string, unknown>;
}

type Style = Record<string, string | number>;

function h(type: string, style: Style, children?: string | VNode | Array<string | VNode>): VNode {
  return { type, props: { style, children } };
}

/**
 * Bun mengembalikan path absolut saat source dijalankan langsung, tetapi path
 * relatif terhadap `dist/` setelah di-bundle. Keduanya harus bisa dibaca.
 */
const FONT = readFileSync(
  isAbsolute(fontFile) ? fontFile : new URL(fontFile, import.meta.url),
);

export interface OgImageInput {
  formationName: string;
  prompt: string | null;
  stepCount: number;
  /** Teks pengganti saat prompt disembunyikan (default: tagline brand). */
  tagline?: string;
}

function truncate(value: string, max: number): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

function buildMarkup(input: OgImageInput): VNode {
  const headline = truncate(input.formationName, 34);
  const prompt = input.prompt ? truncate(input.prompt, 170) : null;
  const tagline = input.tagline ?? "Separate machines. One formation.";
  const stepLabel = `${input.stepCount} ${input.stepCount === 1 ? "step" : "steps"}`;

  return h(
    "div",
    {
      width: "1200px",
      height: "630px",
      boxSizing: "border-box",
      display: "flex",
      flexDirection: "column",
      justifyContent: "space-between",
      padding: "64px 72px",
      background: "#08090b",
      color: "#ece9e2",
      fontFamily: "Archivo",
      position: "relative",
      overflow: "hidden",
    },
    [
      // Grid dekoratif tipis.
      h("div", {
        position: "absolute",
        top: "0",
        right: "0",
        width: "520px",
        height: "520px",
        backgroundImage:
          "linear-gradient(rgba(236,233,226,.08) 1px, transparent 1px), linear-gradient(90deg, rgba(236,233,226,.08) 1px, transparent 1px)",
        backgroundSize: "48px 48px",
        maskImage: "radial-gradient(circle at 80% 10%, #000, transparent 72%)",
        WebkitMaskImage: "radial-gradient(circle at 80% 10%, #000, transparent 72%)",
      }),
      h(
        "div",
        {
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        },
        [
          h(
            "div",
            { display: "flex", alignItems: "center", gap: "16px" },
            [
              h("div", {
                width: "30px",
                height: "30px",
                background: "#ff5b1f",
                transform: "rotate(45deg)",
              }),
              h(
                "div",
                {
                  fontSize: "25px",
                  fontWeight: 700,
                  letterSpacing: "0.12em",
                },
                "GATTAI",
              ),
            ],
          ),
          h(
            "div",
            {
              fontFamily: "Archivo",
              fontSize: "18px",
              letterSpacing: "0.18em",
              color: "#8d929a",
            },
            "SHARED RUN",
          ),
        ],
      ),
      h(
        "div",
        { display: "flex", flexDirection: "column", gap: "22px" },
        [
          h(
            "div",
            {
              fontSize: "92px",
              fontWeight: 700,
              lineHeight: 0.95,
              letterSpacing: "-0.05em",
              maxWidth: "1000px",
            },
            headline,
          ),
          prompt
            ? h(
                "div",
                {
                  fontSize: "30px",
                  lineHeight: 1.35,
                  color: "#c9c6bf",
                  maxWidth: "960px",
                  maxHeight: "86px",
                  overflow: "hidden",
                },
                `“${prompt}”`,
              )
            : h(
                "div",
                {
                  fontSize: "30px",
                  lineHeight: 1.35,
                  color: "#8d929a",
                },
                tagline,
              ),
        ],
      ),
      h(
        "div",
        {
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          borderTop: "1px solid rgba(236,233,226,.15)",
          paddingTop: "24px",
          fontSize: "20px",
          color: "#8d929a",
        },
        [
          h(
            "div",
            { display: "flex", gap: "12px" },
            input.stepCount > 0
              ? [
                  h("span", { color: "#ff8a4c" }, stepLabel),
                  h("span", {}, "·"),
                  h("span", {}, "SETTLED ON GATTAI"),
                ]
              : [h("span", { color: "#ff8a4c" }, "SETTLED ON ROBINHOOD CHAIN")],
          ),
          h("div", { color: "#5a5f67" }, "gattai.tech"),
        ],
      ),
    ],
  );
}

export async function renderOgImage(input: OgImageInput): Promise<Uint8Array> {
  const svg = await satori(buildMarkup(input) as unknown as Parameters<typeof satori>[0], {
    width: 1200,
    height: 630,
    fonts: [
      { name: "Archivo", data: FONT, weight: 400, style: "normal" },
      { name: "Archivo", data: FONT, weight: 700, style: "normal" },
    ],
  });
  return new Resvg(svg, { fitTo: { mode: "width", value: 1200 } }).render().asPng();
}

/** OG generik untuk halaman statis / share yang dicabut. */
export function renderDefaultOg(): Promise<Uint8Array> {
  return renderOgImage({
    formationName: "GATTAI",
    prompt: null,
    stepCount: 0,
    tagline: "Separate machines. One formation. Settled on Robinhood Chain.",
  });
}
