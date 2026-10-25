import { describe, expect, test } from "bun:test";
import { getModelByRef, getRecipe } from "../src/config";
import { getProviderApiKey, MissingEnvError } from "../src/env";
import {
  GENERIC_RUN_ERROR,
  internalErrorDetail,
  providerError,
  providerFailure,
  RunLimitReachedError,
  sanitizeStoredError,
  toPublicRunError,
} from "../src/lib/public-error";
import { higgsfieldAdapter } from "../src/providers/higgsfield";

/**
 * Kontrak error publik untuk run.
 *
 * Teks internal — nama environment variable, body respons provider, pesan
 * library, stack trace — tidak boleh pernah tersimpan di `runs.error` /
 * `run_steps.error` atau terkirim ke klien. Detail mentah hanya untuk log.
 */

function withEnv(name: string, value: string | undefined, fn: () => void): void {
  const saved = process.env[name];
  try {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    fn();
  } finally {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  }
}

describe("MissingEnvError", () => {
  test("key provider kosong → error bertipe, pesan Inggris", () => {
    withEnv("HIGGSFIELD_API_KEY", undefined, () => {
      expect(() => getProviderApiKey("higgsfield")).toThrow(MissingEnvError);
      expect(() => getProviderApiKey("higgsfield")).toThrow(
        "Missing required environment variable: HIGGSFIELD_API_KEY",
      );
    });
  });

  test("key terisi → dikembalikan apa adanya", () => {
    withEnv("HIGGSFIELD_API_KEY", "secret-value", () => {
      expect(getProviderApiKey("higgsfield")).toBe("secret-value");
    });
  });
});

describe("adapter provider", () => {
  test("key higgsfield kosong → error bertipe (bukan pesan mentah)", async () => {
    const step = getRecipe("visual")?.steps[1];
    expect(step).toBeDefined();

    await withEnvAsync("HIGGSFIELD_API_KEY", undefined, async () => {
      await expect(
        higgsfieldAdapter.invoke({
          model: getModelByRef(step!.model_ref),
          step: step!,
          messages: [],
          media: { prompt: "a cat" },
        }),
      ).rejects.toThrow(MissingEnvError);
    });
  });
});

describe("toPublicRunError", () => {
  test("env kosong → PROVIDER_NOT_CONFIGURED tanpa nama variabel", () => {
    const pub = toPublicRunError(new MissingEnvError("HIGGSFIELD_API_KEY"));
    expect(pub.code).toBe("PROVIDER_NOT_CONFIGURED");
    expect(pub.message).toBe(
      "This formation is temporarily unavailable. Please try again later.",
    );
    expect(pub.message).not.toContain("HIGGSFIELD");
  });

  test("biaya run melewati plafon → RUN_LIMIT_REACHED", () => {
    const pub = toPublicRunError(new RunLimitReachedError());
    expect(pub.code).toBe("RUN_LIMIT_REACHED");
    expect(pub.message).toContain("limit for a single run");
  });

  test("error adapter → PROVIDER_ERROR tanpa nama provider internal", () => {
    const pub = toPublicRunError(providerError("mimo", 500, "raw body"));
    expect(pub.code).toBe("PROVIDER_ERROR");
    expect(pub.message).toBe(
      "The model provider could not complete this step. Please try again.",
    );
    expect(pub.message).not.toContain("mimo");
  });

  test("401/403/404 provider → PROVIDER_NOT_CONFIGURED (bukan 'try again')", () => {
    for (const status of [401, 403, 404]) {
      const pub = toPublicRunError(providerError("mimo", status, "raw body"));
      expect(pub.code).toBe("PROVIDER_NOT_CONFIGURED");
      expect(pub.message).toBe(
        "This formation is temporarily unavailable. Please try again later.",
      );
      expect(pub.message).not.toContain("mimo");
    }
  });

  test("error tak dikenal → RUN_FAILED generik", () => {
    const pub = toPublicRunError(new Error("boom at /app/src/secret.ts"));
    expect(pub.code).toBe("RUN_FAILED");
    expect(pub.message).toBe(GENERIC_RUN_ERROR);
  });
});

describe("internalErrorDetail (log server)", () => {
  test("menyimpan detail mentah provider untuk penelusuran", () => {
    expect(internalErrorDetail(providerError("openai", 429, "rate limited"))).toBe(
      "openai 429: rate limited",
    );
    expect(internalErrorDetail(providerFailure("higgsfield", "job failed: nsfw"))).toBe(
      "higgsfield: job failed: nsfw",
    );
    expect(internalErrorDetail(new MissingEnvError("MIMO_API_KEY"))).toBe(
      "MissingEnvError: Missing required environment variable: MIMO_API_KEY",
    );
  });
});

describe("sanitizeStoredError (termasuk baris lama)", () => {
  test("pesan env internal diganti generik", () => {
    expect(
      sanitizeStoredError("Environment variable wajib belum diisi: HIGGSFIELD_API_KEY"),
    ).toBe(GENERIC_RUN_ERROR);
  });

  test("body provider mentah diganti generik", () => {
    expect(sanitizeStoredError('OpenAI error 500: {"error":"boom"}')).toBe(GENERIC_RUN_ERROR);
    expect(sanitizeStoredError("Higgsfield job gagal: timeout")).toBe(GENERIC_RUN_ERROR);
    expect(sanitizeStoredError("MIMO responded 503 (attempt 2)")).toBe(GENERIC_RUN_ERROR);
  });

  test("frasa diagnostik internal non-provider diganti generik", () => {
    expect(sanitizeStoredError("Provider tidak dikenal: xyz")).toBe(GENERIC_RUN_ERROR);
    expect(sanitizeStoredError("Model ref tidak ditemukan: foo")).toBe(GENERIC_RUN_ERROR);
  });

  test("pesan publik yang aman dibiarkan", () => {
    expect(
      sanitizeStoredError("This formation is temporarily unavailable. Please try again later."),
    ).toBe("This formation is temporarily unavailable. Please try again later.");
    expect(sanitizeStoredError("  ")).toBeNull();
    expect(sanitizeStoredError(null)).toBeNull();
    expect(sanitizeStoredError(undefined)).toBeNull();
  });

  test("teks sangat panjang (kemungkinan dump internal) diganti generik", () => {
    expect(sanitizeStoredError("x".repeat(400))).toBe(GENERIC_RUN_ERROR);
  });
});

async function withEnvAsync(
  name: string,
  value: string | undefined,
  fn: () => Promise<void>,
): Promise<void> {
  const saved = process.env[name];
  try {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    await fn();
  } finally {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  }
}
