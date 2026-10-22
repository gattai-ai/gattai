import { describe, expect, test } from "bun:test";
import { suggestRecipe } from "../src/orchestration/router";

describe("router", () => {
  test("menyarankan recipe sesuai kata kunci", () => {
    expect(suggestRecipe("buatkan video pendek 9:16")).toBe("video");
    expect(suggestRecipe("petunjuk: video klip")).toBe("video");
    expect(suggestRecipe("buat logo dan banner")).toBe("visual");
    expect(suggestRecipe("riset pasar dengan sumber dan sitasi")).toBe("research");
    expect(suggestRecipe("tulis fungsi TypeScript untuk refactor")).toBe("code");
    expect(suggestRecipe("launch kit untuk peluncuran produk")).toBe("launch_kit");
  });

  test("default ke refine untuk prompt biasa", () => {
    expect(suggestRecipe("halo, apa kabar?")).toBe("refine");
    expect(suggestRecipe("")).toBe("refine");
  });
});
