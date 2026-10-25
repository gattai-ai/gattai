import { describe, expect, test } from "bun:test";
import { ApiError } from "../src/lib/api";
import {
  errorMessage,
  sanitizeInternalText,
  sanitizeProviderMentions,
  statusLabel,
  topupHref,
} from "../src/lib/error-message";

/**
 * Pesan/kode error yang tampil ke pengguna harus ramah dan tidak pernah
 * menampilkan prefiks kode mentah backend (`KODE: pesan`).
 */

describe("errorMessage: pemetaan kode backend", () => {
  test("INSUFFICIENT_BALANCE jadi kalimat ramah tanpa kode", () => {
    const cause = new ApiError(402, "INSUFFICIENT_BALANCE", "Insufficient credits.");
    const message = errorMessage(cause);
    expect(message).toBe("Not enough credits for this run. Top up to continue.");
    expect(message).not.toContain("INSUFFICIENT_BALANCE");
  });

  test("kode trial tetap dipetakan", () => {
    expect(errorMessage(new ApiError(402, "TRIAL_EXHAUSTED", "x"))).toContain("free prompts");
    expect(errorMessage(new ApiError(402, "TRIAL_MEDIA_EXHAUSTED", "x"))).toContain("free media runs");
  });

  test("kode holder dipetakan tanpa kode mentah", () => {
    const budget = errorMessage(new ApiError(402, "HOLDER_BUDGET_EXHAUSTED", "x"));
    expect(budget).toContain("budget is used up");
    expect(budget).not.toContain("HOLDER_");

    const quota = errorMessage(new ApiError(402, "HOLDER_QUOTA_EXHAUSTED", "x"));
    expect(quota).toContain("holder free-run quota");
    expect(quota).not.toContain("HOLDER_");

    const paused = errorMessage(new ApiError(402, "HOLDER_RUNS_PAUSED", "x"));
    expect(paused).toContain("temporarily paused");
    expect(paused).not.toContain("HOLDER_");
  });

  test("request terlalu besar dan limit run dipetakan ramah", () => {
    expect(errorMessage(new ApiError(413, "REQUEST_TOO_LARGE", "x"))).toContain("too large");
    expect(errorMessage(new ApiError(500, "RUN_LIMIT_REACHED", "x"))).toContain(
      "limit for a single run",
    );
  });

  test("kode tak dikenal memakai pesan server, bukan `KODE: pesan`", () => {
    const cause = new ApiError(409, "SOME_NEW_CODE", "The formation is busy right now.");
    const message = errorMessage(cause);
    expect(message).toBe("The formation is busy right now.");
    expect(message).not.toContain("SOME_NEW_CODE");
  });

  test("kode tak dikenal tanpa pesan jatuh ke fallback", () => {
    const cause = new ApiError(400, "SOME_NEW_CODE", "   ");
    expect(errorMessage(cause, "Please try again.")).toBe("Please try again.");
  });

  test("fallback berdasarkan status saat kode kosong", () => {
    expect(errorMessage(new ApiError(429, "HTTP_ERROR", "Too many requests."))).toContain("bit fast");
    expect(errorMessage(new ApiError(401, "HTTP_ERROR", "nope"))).toContain("session expired");
    expect(errorMessage(new ApiError(503, "HTTP_ERROR", "boom"))).toContain("our side");
  });

  test("error non-API disanitasi oleh walletErrorMessage", () => {
    expect(errorMessage(new Error("fetch failed"))).toContain("Could not reach the server");
    expect(errorMessage(null, "Fallback.")).toBe("Fallback.");
  });

  test("pesan sangat panjang dipotong", () => {
    const cause = new ApiError(400, "SOME_NEW_CODE", "x".repeat(500));
    expect(errorMessage(cause).length).toBeLessThanOrEqual(200);
  });

  test("penyebutan provider internal disanitasi terpusat", () => {
    expect(errorMessage(new ApiError(400, "SOME_NEW_CODE", "MIMO timeout"))).toBe("the model timeout");
    expect(errorMessage(new Error("mimo-v2.6-flash gagal"))).not.toContain("mimo");
  });
});

describe("sanitizeProviderMentions", () => {
  test("menyembunyikan provider internal dan nama modelnya", () => {
    expect(sanitizeProviderMentions("MIMO error 500: boom")).toBe("the model error 500: boom");
    expect(sanitizeProviderMentions("model mimo-v2.6-flash gagal")).toBe("model the model gagal");
  });

  test("teks tanpa provider internal tidak berubah", () => {
    expect(sanitizeProviderMentions("Claude timeout")).toBe("Claude timeout");
    expect(sanitizeProviderMentions(null)).toBeNull();
  });
});

describe("errorMessage: detail internal tidak bocor", () => {
  test("nama environment variable internal diganti fallback ramah", () => {
    const message = errorMessage(new Error("Environment variable wajib belum diisi: HIGGSFIELD_API_KEY"));
    expect(message).toBe("Something went wrong. Try again.");
    expect(message).not.toContain("HIGGSFIELD");
  });

  test("pesan run dari server (string) juga disanitasi", () => {
    expect(errorMessage("Higgsfield job gagal: nsfw blocked")).toBe(
      "Something went wrong. Try again.",
    );
    expect(errorMessage("OpenAI error 500: boom")).toBe("Something went wrong. Try again.");
  });

  test("kode run dari backend dipetakan ke kalimat publik", () => {
    expect(errorMessage(new ApiError(500, "PROVIDER_ERROR", "x"))).toBe(
      "The model provider could not complete this step. Please try again.",
    );
    expect(errorMessage(new ApiError(500, "PROVIDER_NOT_CONFIGURED", "x"))).toBe(
      "This formation is temporarily unavailable. Please try again later.",
    );
    expect(errorMessage(new ApiError(500, "RUN_FAILED", "x"))).toBe(
      "Something went wrong while running this formation. Please try again.",
    );
  });
});

describe("sanitizeInternalText", () => {
  test("menandai teks internal sebagai tidak aman (null)", () => {
    expect(sanitizeInternalText("Environment variable HIGGSFIELD_API_KEY is missing")).toBeNull();
    expect(sanitizeInternalText("TypeError: cannot read property")).toBeNull();
    expect(sanitizeInternalText("    at runStep (/app/src/runner.ts:1:1)")).toBeNull();
    expect(sanitizeInternalText("Provider tidak dikenal: xyz")).toBeNull();
    expect(sanitizeInternalText("Unknown provider: xyz")).toBeNull();
  });

  test("pesan ramah dibiarkan apa adanya", () => {
    expect(sanitizeInternalText("Something went wrong. Try again.")).toBe(
      "Something went wrong. Try again.",
    );
    expect(sanitizeInternalText(null)).toBeNull();
  });
});

describe("statusLabel", () => {
  test("enum mentah backend diterjemahkan", () => {
    expect(statusLabel("SETTLED")).toBe("DONE");
    expect(statusLabel("INSUFFICIENT_BALANCE")).toBe("NO CREDITS");
    expect(statusLabel("AWAITING_CONFIRMATION")).toBe("NEEDS CONFIRM");
    expect(statusLabel("RELEASED")).toBe("FAILED");
    expect(statusLabel("RESERVED")).toBe("RUNNING");
  });

  test("status tak dikenal dirapikan (underscore → spasi), bukan enum", () => {
    expect(statusLabel("SOME_NEW_STATE")).toBe("SOME NEW STATE");
  });
});

describe("topupHref", () => {
  test("mengembalikan path relatif dari topup_url", () => {
    const cause = new ApiError(402, "INSUFFICIENT_BALANCE", "x", { topup_url: "/app/balance" });
    expect(topupHref(cause)).toBe("/app/balance");
  });

  test("menolak URL absolut dan non-ApiError", () => {
    const evil = new ApiError(402, "INSUFFICIENT_BALANCE", "x", { topup_url: "https://evil.test" });
    expect(topupHref(evil)).toBeNull();
    expect(topupHref(new Error("boom"))).toBeNull();
  });
});
