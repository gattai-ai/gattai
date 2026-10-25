import { describe, expect, test } from "bun:test";
import { withTimeout } from "../src/lib/timeout";

describe("withTimeout", () => {
  test("mengembalikan hasil promise yang selesai tepat waktu", async () => {
    await expect(withTimeout(Promise.resolve("ok"), 100, "test")).resolves.toBe("ok");
  });

  test("menolak promise yang menggantung setelah batas waktu", async () => {
    const never = new Promise<string>(() => {});
    await expect(withTimeout(never, 5, "holder getBlock")).rejects.toThrow(
      "holder getBlock timed out after 5ms",
    );
  });
});
