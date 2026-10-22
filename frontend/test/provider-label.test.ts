import { describe, expect, test } from "bun:test";
import {
  displayLandingRole,
  displayModeLabel,
  displayStepLabel,
  displayStepRole,
  toDisplayRecipes,
} from "../src/lib/provider-label";
import type { Recipe } from "../src/lib/types";

/**
 * Label provider yang tampil ke pengguna. Sumber utama `provider`/`label` dari
 * API (sudah berupa merek publik), tapi helper harus tetap menutup kebocoran
 * provider internal (`mimo`) dari response lama.
 */

describe("displayStepLabel", () => {
  test("label menang atas provider internal", () => {
    expect(displayStepLabel({ label: "Claude", provider: "mimo" })).toBe("Claude");
  });

  test("provider internal tanpa label tidak bocor", () => {
    expect(displayStepLabel({ provider: "mimo" })).toBe("Model");
  });

  test("provider publik diteruskan apa adanya", () => {
    expect(displayStepLabel({ provider: "Perplexity" })).toBe("Perplexity");
  });

  test("nama internal yang dikenal dipetakan ke merek publik", () => {
    expect(displayStepLabel({ provider: "anthropic" })).toBe("Claude");
    expect(displayStepLabel({ provider: "openai" })).toBe("GPT");
  });

  test("provider kosong tetap menghasilkan teks", () => {
    expect(displayStepLabel({})).toBe("Model");
  });
});

describe("displayStepRole", () => {
  test("memakai role_label bila ada", () => {
    expect(displayStepRole({ role_label: "render · video", role: "render_video" })).toBe("render · video");
  });

  test("fallback ke id role", () => {
    expect(displayStepRole({ role: "write" })).toBe("write");
  });
});

describe("displayModeLabel", () => {
  test("id mode config → label landing", () => {
    expect(displayModeLabel("streaming")).toBe("Streaming");
    expect(displayModeLabel("async")).toBe("Async");
    expect(displayModeLabel("mixed")).toBe("Mixed");
  });

  test("mode tak dikenal di-Title Case", () => {
    expect(displayModeLabel("batch")).toBe("Batch");
    expect(displayModeLabel("")).toBe("");
  });
});

describe("displayLandingRole", () => {
  test("memakai frasa pendek seperti referensi landing", () => {
    expect(displayLandingRole({ role: "gather_sources", role_label: "gather_sources" })).toBe("gather");
    expect(displayLandingRole({ role: "art_direction", role_label: "art_direction" })).toBe("art direction");
    expect(displayLandingRole({ role: "script_and_shots", role_label: "script_and_shots" })).toBe("script & shots");
    expect(displayLandingRole({ role: "copy_pack", role_label: "copy_pack" })).toBe("copy pack");
  });

  test("membedakan render visual vs launch kit lewat role_label", () => {
    // Keduanya ber-role `render_image`; hanya `role_label` yang membedakan.
    expect(displayLandingRole({ role: "render_image", role_label: "render · image" })).toBe("image");
    expect(displayLandingRole({ role: "render_image", role_label: "render · banner" })).toBe("banner/PFP");
    expect(displayLandingRole({ role: "render_video", role_label: "render · video" })).toBe("Veo / Kling");
  });

  test("role tanpa padanan jatuh ke label apa adanya", () => {
    expect(displayLandingRole({ role: "interpret", role_label: "interpret" })).toBe("interpret");
    expect(displayLandingRole({ role: "write_report", role_label: "write" })).toBe("write");
    expect(displayLandingRole({ role: "write" })).toBe("write");
  });
});

describe("toDisplayRecipes", () => {
  const fallback = [
    { id: "refine", name: "Refine", mode: "Streaming", steps: [{ label: "GPT", role: "interpret" }] },
  ];

  test("fallback dipakai saat API belum punya data", () => {
    expect(toDisplayRecipes([], fallback)).toBe(fallback);
    expect(toDisplayRecipes(undefined, fallback)).toBe(fallback);
  });

  test("recipe dari API dinormalkan ke label + role publik ala landing", () => {
    const recipe: Recipe = {
      id: "video",
      name: "Video",
      description: "",
      mode: "async",
      markup: 1,
      pricing: { credits: 0, usd: 0, reserve_micro: 0, provider_cost_usd: 0, markup: 1, requires_confirmation: false },
      steps: [
        { id: "script", provider: "Claude", role: "script_and_shots", role_label: "script_and_shots", async: false, stream: false },
        { id: "render", provider: "Higgsfield", role: "render_video", role_label: "render · video", async: true, stream: false },
      ],
    };

    const out = toDisplayRecipes([recipe], []);
    expect(out).toEqual([
      {
        id: "video",
        name: "Video",
        mode: "Async",
        steps: [
          { label: "Claude", role: "script & shots" },
          { label: "Higgsfield", role: "Veo / Kling" },
        ],
      },
    ]);
    expect(JSON.stringify(out)).not.toContain("mimo");
  });
});
