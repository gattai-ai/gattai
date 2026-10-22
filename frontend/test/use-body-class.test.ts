import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";
import { useBodyClass } from "../src/lib/use-body-class";

/**
 * `useBodyClass` harus selalu membuang kelas saat unmount. Regresi yang dijaga:
 * `body.chatmode` tertinggal setelah keluar dari `/app/chat` sehingga halaman
 * berikutnya tidak bisa di-scroll.
 */

afterEach(() => {
  cleanup();
  document.body.className = "";
});

describe("useBodyClass", () => {
  test("menambah kelas saat aktif, membuang saat nonaktif", () => {
    const { rerender } = renderHook(({ active }) => useBodyClass("chatmode", active), {
      initialProps: { active: true },
    });
    expect(document.body.classList.contains("chatmode")).toBe(true);

    rerender({ active: false });
    expect(document.body.classList.contains("chatmode")).toBe(false);
  });

  test("membuang kelas saat unmount (bug scroll landing)", () => {
    const { unmount } = renderHook(() => useBodyClass("chatmode", true));
    expect(document.body.classList.contains("chatmode")).toBe(true);

    unmount();
    expect(document.body.classList.contains("chatmode")).toBe(false);
  });

  test("tidak menyentuh kelas saat aktif = false", () => {
    renderHook(() => useBodyClass("chatmode", false));
    expect(document.body.classList.contains("chatmode")).toBe(false);
  });
});
