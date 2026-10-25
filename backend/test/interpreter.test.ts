import { afterEach, describe, expect, test } from "bun:test";
import { runInterpreter } from "../src/orchestration/interpreter";
import { installFetch, type FetchHandler } from "./helpers/mock-fetch";

let restore: (() => void) | null = null;

function useFetch(handler: FetchHandler): void {
  restore = installFetch(handler);
}

afterEach(() => {
  restore?.();
  restore = null;
});

function openAiJson(content: string): Response {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-mock",
      choices: [{ message: { role: "assistant", content } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }),
    { headers: { "content-type": "application/json" } },
  );
}

describe("interpreter", () => {
  test("brief JSON valid → tidak fallback", async () => {
    useFetch(async () =>
      openAiJson(JSON.stringify({ pass_through: false, goal: "menjelaskan", assumptions: ["a"] })),
    );
    const result = await runInterpreter({ modelRef: "gpt_architect", original: "jelaskan x" });
    expect(result.fellBack).toBe(false);
    expect(result.brief.goal).toBe("menjelaskan");
  });

  test("validasi gagal lalu sukses pada percobaan kedua", async () => {
    let call = 0;
    useFetch(async () => {
      call++;
      return openAiJson(call === 1 ? "bukan json" : JSON.stringify({ pass_through: true }));
    });
    const result = await runInterpreter({ modelRef: "gpt_architect", original: "x" });
    expect(result.fellBack).toBe(false);
    expect(call).toBe(2);
  });

  test("gagal terus → fallback pass-through berflag", async () => {
    useFetch(async () => openAiJson("tetap bukan json"));
    const result = await runInterpreter({ modelRef: "gpt_architect", original: "x" });
    expect(result.fellBack).toBe(true);
    expect(result.brief.pass_through).toBe(true);
  });

  test("401 provider → tidak fallback, error dilempar", async () => {
    let call = 0;
    useFetch(async () => {
      call++;
      return new Response("unauthorized", { status: 401 });
    });
    await expect(
      runInterpreter({ modelRef: "mimo_architect", original: "x" }),
    ).rejects.toThrow("The model provider could not complete this step.");
    expect(call).toBe(1);
  });

  test("retry HTTP transien (500) sebelum sukses", async () => {
    let call = 0;
    useFetch(async () => {
      call++;
      if (call === 1) return new Response("boom", { status: 500 });
      return openAiJson(JSON.stringify({ pass_through: true, goal: "ok setelah retry" }));
    });
    const result = await runInterpreter({ modelRef: "gpt_architect", original: "x" });
    expect(result.fellBack).toBe(false);
    expect(result.brief.goal).toBe("ok setelah retry");
    expect(call).toBeGreaterThanOrEqual(2);
  });
});
