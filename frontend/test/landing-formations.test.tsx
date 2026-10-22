import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { RouterContext } from "../src/lib/router-context";
import { toDisplayRecipes } from "../src/lib/provider-label";
import { FormationCards } from "../src/site/pages/LandingPage";
import type { Recipe } from "../src/lib/types";

/**
 * Regresi landing: bagian "Formations" dulu merender `step.provider` mentah
 * dari `/v1/recipes` (pengguna login melihat `mimo · interpret`). Sekarang kartu
 * memakai label provider publik, mode Title Case, dan frasa role seperti
 * `gattai-site/index.html`.
 */

afterEach(cleanup);

function renderCards(formations: ReturnType<typeof toDisplayRecipes>) {
  return render(
    <RouterContext.Provider value={{ location: "/", navigate: () => {} }}>
      <FormationCards formations={formations} />
    </RouterContext.Provider>,
  );
}

function recipe(
  steps: Recipe["steps"],
  overrides: Partial<Pick<Recipe, "id" | "name" | "mode" | "available">> = {},
): Recipe {
  return {
    id: "refine",
    name: "Refine",
    description: "",
    mode: "streaming",
    markup: 1,
    pricing: { credits: 0, usd: 0, reserve_micro: 0, provider_cost_usd: 0, markup: 1, requires_confirmation: false },
    steps,
    ...overrides,
  };
}

describe("FormationCards", () => {
  test("memakai label & role publik dari API, bukan provider internal", () => {
    const formations = toDisplayRecipes(
      [
        recipe([
          { id: "interpret", provider: "GPT", role: "interpret", role_label: "interpret", async: false, stream: false },
          { id: "execute", provider: "Claude", role: "execute", role_label: "execute", async: false, stream: true },
        ]),
      ],
      [],
    );
    renderCards(formations);

    expect(screen.getByText("GPT · interpret")).toBeDefined();
    expect(screen.getByText("Claude · execute")).toBeDefined();
    expect(screen.queryByText(/mimo/i)).toBeNull();
  });

  test("mode dan role mengikuti frasa gattai-site/index.html", () => {
    const formations = toDisplayRecipes(
      [
        recipe(
          [
            { id: "script", provider: "Claude", role: "script_and_shots", role_label: "script_and_shots", async: false, stream: false },
            { id: "render", provider: "Higgsfield", role: "render_video", role_label: "render · video", async: true, stream: false },
          ],
          { id: "video", name: "Video", mode: "async" },
        ),
      ],
      [],
    );
    renderCards(formations);

    expect(screen.getByText("Async")).toBeDefined();
    expect(screen.getByText("Claude · script & shots")).toBeDefined();
    expect(screen.getByText("Higgsfield · Veo / Kling")).toBeDefined();
    expect(screen.queryByText(/script_and_shots/)).toBeNull();
  });

  test("render visual vs launch kit tidak tertukar (role render_image sama)", () => {
    const formations = toDisplayRecipes(
      [
        recipe(
          [
            { id: "art_direction", provider: "Claude", role: "art_direction", role_label: "art_direction", async: false, stream: false },
            { id: "render", provider: "Higgsfield", role: "render_image", role_label: "render · image", async: true, stream: false },
          ],
          { id: "visual", name: "Visual", mode: "async" },
        ),
        recipe(
          [
            { id: "copy_pack", provider: "Claude", role: "copy_pack", role_label: "copy_pack", async: false, stream: false },
            { id: "render_banner", provider: "Higgsfield", role: "render_image", role_label: "render · banner", async: true, stream: false },
          ],
          { id: "launch_kit", name: "Launch Kit", mode: "mixed" },
        ),
      ],
      [],
    );
    renderCards(formations);

    expect(screen.getByText("Higgsfield · image")).toBeDefined();
    expect(screen.getByText("Higgsfield · banner/PFP")).toBeDefined();
    expect(screen.getByText("Mixed")).toBeDefined();
  });

  test("provider internal dari response lama tidak pernah tampil", () => {
    const formations = toDisplayRecipes(
      [
        recipe([
          { id: "execute", provider: "mimo", role: "execute", role_label: "execute", async: false, stream: true },
        ]),
      ],
      [],
    );
    renderCards(formations);

    expect(screen.getByText("Model · execute")).toBeDefined();
    expect(screen.queryByText(/mimo/i)).toBeNull();
  });

  test("kartu coming soon tidak menautkan ke chat; kartu tersedia tetap menautkan", () => {
    const formations = toDisplayRecipes(
      [
        recipe(
          [
            { id: "interpret", provider: "GPT", role: "interpret", role_label: "interpret", async: false, stream: false },
            { id: "execute", provider: "Claude", role: "execute", role_label: "execute", async: false, stream: true },
          ],
          { id: "refine", name: "Refine", mode: "streaming" },
        ),
        recipe(
          [
            { id: "art_direction", provider: "Claude", role: "art_direction", role_label: "art_direction", async: false, stream: false },
            { id: "render", provider: "Higgsfield", role: "render_image", role_label: "render · image", async: true, stream: false },
          ],
          { id: "visual", name: "Visual", mode: "async", available: false },
        ),
      ],
      [],
    );
    const { container } = renderCards(formations);

    const soonCard = container.querySelector(".rc.soon");
    expect(soonCard?.getAttribute("aria-disabled")).toBe("true");
    expect(soonCard?.textContent).toContain("SOON");
    expect(soonCard?.textContent).not.toContain("RUN →");

    // Hanya kartu yang tersedia yang menjadi tautan ke chat.
    const links = screen.queryAllByRole("link");
    expect(links.length).toBe(1);
    expect(links[0].getAttribute("href")).toBe("/app/chat?f=refine");
  });
});
