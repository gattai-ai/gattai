import { describe, expect, test } from "bun:test";
import { amount2, compactAmount, exactAmount, fmtPercent } from "../src/lib/burn-format";

const TOTAL = "28061822210522966378459998";
const TEAM_20M = "20000000000000000000000000";
const TEAM_8M = "8061822210522966378459998";

describe("format burn", () => {
  test("kartu ringkas memakai 2 desimal juta", () => {
    expect(compactAmount(TOTAL, 18)).toBe("28.06M");
    expect(compactAmount(TEAM_20M, 18)).toBe("20.00M");
    expect(compactAmount(TEAM_8M, 18)).toBe("8.06M");
    expect(compactAmount("0", 18)).toBe("0");
  });

  test("tabel memakai 2 desimal token", () => {
    expect(amount2(TEAM_20M, 18)).toBe("20,000,000.00");
    expect(amount2(TEAM_8M, 18)).toBe("8,061,822.21");
  });

  test("tooltip tetap exact", () => {
    expect(exactAmount(TOTAL, 18)).toBe("28061822.210522966378459998");
    expect(exactAmount(TEAM_8M, 18)).toBe("8061822.210522966378459998");
  });

  test("persentase supply dibulatkan 2 desimal", () => {
    expect(fmtPercent("2.80618222")).toBe("2.81%");
    expect(fmtPercent("0.00000000")).toBe("0.00%");
  });
});
