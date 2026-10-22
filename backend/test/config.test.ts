import { describe, expect, test } from "bun:test";
import { getModelByRef, loadConfig } from "../src/config";

describe("config", () => {
  test("memuat 6 recipe dan profil parameter", () => {
    const config = loadConfig();
    expect(config.recipes.length).toBe(6);
    expect(config.params.pricing.default_markup).toBeGreaterThan(0);
    expect(config.params.context.summary_threshold_chars).toBeGreaterThan(0);
  });

  test("setiap step menunjuk model_ref yang ada dan providernya cocok", () => {
    const config = loadConfig();
    for (const recipe of config.recipes) {
      for (const step of recipe.steps) {
        const model = config.models[step.model_ref];
        expect(model).toBeDefined();
        expect(model.provider).toBe(step.provider);
        // Label tampilan wajib ada dan tidak boleh membocorkan provider internal.
        expect(step.label.length).toBeGreaterThan(0);
        expect(step.label.toLowerCase()).not.toContain("mimo");
        // Role tampilan wajib ada dan juga bebas provider internal.
        expect(step.role_label.length).toBeGreaterThan(0);
        expect(step.role_label.toLowerCase()).not.toContain("mimo");
      }
    }
  });

  test("getModelByRef melempar untuk ref tak dikenal", () => {
    expect(() => getModelByRef("tidak_ada")).toThrow();
  });
});
