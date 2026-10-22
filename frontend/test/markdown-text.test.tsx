import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { MarkdownText } from "../src/site/app/MarkdownText";

/**
 * Output asisten dirender sebagai Markdown (heading, tebal, list, kode, tabel),
 * tetapi HTML mentah dari model TIDAK pernah dieksekusi (tidak ada
 * `dangerouslySetInnerHTML`, jadi tidak ada `<script>`/`<img onerror>` di DOM).
 */

afterEach(cleanup);

describe("MarkdownText", () => {
  test("heading, tebal, miring, dan kode inline", () => {
    render(<MarkdownText text={"# Title\n\nSome **bold**, *italic*, and `code`."} />);
    expect(screen.getByRole("heading", { name: "Title", level: 1 })).toBeDefined();
    expect(screen.getByText("bold").tagName).toBe("STRONG");
    expect(screen.getByText("italic").tagName).toBe("EM");
    expect(screen.getByText("code").tagName).toBe("CODE");
  });

  test("list dan blok kode (code fence)", () => {
    render(<MarkdownText text={"- one\n- two\n\n```ts\nconst a = 1;\n```"} />);
    expect(screen.getByRole("list")).toBeDefined();
    expect(screen.getAllByRole("listitem").length).toBe(2);
    expect(screen.getByText("const a = 1;")).toBeDefined();
  });

  test("tabel GFM dirender", () => {
    render(<MarkdownText text={"| A | B |\n| - | - |\n| 1 | 2 |"} />);
    expect(screen.getByRole("table")).toBeDefined();
    expect(screen.getByText("A").tagName).toBe("TH");
  });

  test("HTML mentah tidak dieksekusi (anti-XSS)", () => {
    render(
      <MarkdownText text={'<script>alert(1)</script>\n\n<img src="x" onerror="alert(1)">'} />,
    );
    const container = document.body;
    expect(container.querySelector("script") === null).toBe(true);
    expect(container.querySelector("img") === null).toBe(true);
  });

  test("tautan memakai target baru + rel aman", () => {
    render(<MarkdownText text={"[docs](https://example.com)"} />);
    const link = screen.getByRole("link", { name: "docs" });
    expect(link.getAttribute("href")).toBe("https://example.com");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noreferrer");
  });
});
