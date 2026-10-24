import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getRecipe } from "../config";
import { env } from "../env";
import type { SharedRun } from "../services/shares";

/**
 * Injeksi meta server-side untuk shell SPA `/run/:slug`.
 *
 * Crawler (X/Discord/Slack) tidak menjalankan React, jadi meta harus sudah ada
 * di HTML pertama. Frontend tetap memakai hook `useDocumentMeta` untuk tab
 * browser; keduanya memakai konten yang sama.
 */

const SEO_START = "<!-- SEO_META_START -->";
const SEO_END = "<!-- SEO_META_END -->";

export interface SeoMeta {
  title: string;
  description: string;
  url: string;
  image: string;
  imageAlt: string;
  type: "article" | "website";
  noindex?: boolean;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function truncate(value: string, max: number): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

/** Blok meta lengkap yang menggantikan isi marker di `index.html`. */
export function renderSeoBlock(meta: SeoMeta): string {
  const title = escapeHtml(meta.title);
  const description = escapeHtml(meta.description);
  const url = escapeHtml(meta.url);
  const image = escapeHtml(meta.image);
  const imageAlt = escapeHtml(meta.imageAlt);

  return [
    SEO_START,
    `    <title>${title}</title>`,
    `    <meta name="description" content="${description}" />`,
    meta.noindex ? '    <meta name="robots" content="noindex, nofollow" />' : "",
    `    <link rel="canonical" href="${url}" />`,
    `    <meta property="og:type" content="${meta.type}" />`,
    '    <meta property="og:site_name" content="GATTAI" />',
    `    <meta property="og:title" content="${title}" />`,
    `    <meta property="og:description" content="${description}" />`,
    `    <meta property="og:url" content="${url}" />`,
    `    <meta property="og:image" content="${image}" />`,
    '    <meta property="og:image:width" content="1200" />',
    '    <meta property="og:image:height" content="630" />',
    `    <meta property="og:image:alt" content="${imageAlt}" />`,
    '    <meta name="twitter:card" content="summary_large_image" />',
    '    <meta name="twitter:site" content="@gattai_ai" />',
    `    <meta name="twitter:title" content="${title}" />`,
    `    <meta name="twitter:description" content="${description}" />`,
    `    <meta name="twitter:image" content="${image}" />`,
    SEO_END,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Ganti blok marker; bila template lama belum punya marker, sisipkan sebelum `</head>`. */
export function injectSeoMeta(template: string, block: string): string {
  const marked = new RegExp(
    `${SEO_START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${SEO_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
  );
  if (marked.test(template)) return template.replace(marked, block);
  return template.replace("</head>", `  ${block}\n  </head>`);
}

/** Cari `index.html` hasil build. `FRONTEND_DIST_DIR` menang di produksi. */
function templateCandidates(): string[] {
  const configured = env.frontendDistDir;
  if (configured) return [join(configured, "index.html")];
  const cwd = process.cwd();
  return [
    resolve(cwd, "../frontend/dist/index.html"),
    resolve(cwd, "frontend/dist/index.html"),
    fileURLToPath(new URL("../../../frontend/dist/index.html", import.meta.url)),
  ];
}

function readTemplate(): string | null {
  for (const path of templateCandidates()) {
    if (existsSync(path)) return readFileSync(path, "utf8");
  }
  return null;
}

function fallbackShell(block: string): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "  <head>",
    '    <meta charset="utf-8" />',
    '    <meta name="viewport" content="width=device-width, initial-scale=1" />',
    block,
    "  </head>",
    "  <body>",
    '    <div id="root"></div>',
    "    <noscript>GATTAI needs JavaScript to render this shared run.</noscript>",
    "  </body>",
    "</html>",
  ].join("\n");
}

export interface RunHtml {
  html: string;
  status: 200 | 404;
}

export function renderRunHtml(
  shared: SharedRun | null,
  options: { baseUrl: string; slug: string },
): RunHtml {
  const base = options.baseUrl.replace(/\/+$/, "");
  const defaultImage = `${base}/og-default.png`;
  const url = `${base}/run/${options.slug}`;

  if (!shared) {
    const block = renderSeoBlock({
      title: "Run not found · GATTAI",
      description: "This shared run does not exist or has been revoked.",
      url,
      image: defaultImage,
      imageAlt: "GATTAI",
      type: "website",
      noindex: true,
    });
    return { html: injectSeoMeta(readTemplate() ?? fallbackShell(block), block), status: 404 };
  }

  const formationName = getRecipe(shared.run.recipeId)?.name ?? shared.run.recipeId;
  const prompt = shared.share.showPrompt ? shared.run.input : null;
  const stepCount = shared.steps.length;
  const description = prompt
    ? `${truncate(prompt, 150)} — ${stepCount} ${stepCount === 1 ? "step" : "steps"} on GATTAI.`
    : `A ${formationName} formation run: ${stepCount} ${stepCount === 1 ? "step" : "steps"} on GATTAI.`;
  const block = renderSeoBlock({
    title: `${formationName} · Shared run · GATTAI`,
    description,
    url,
    image: `${url}/og.png`,
    imageAlt: `${formationName} formation run on GATTAI`,
    type: "article",
  });
  return { html: injectSeoMeta(readTemplate() ?? fallbackShell(block), block), status: 200 };
}
