import { describe, expect, it } from "vite-plus/test";
import { goalReportItems } from "./data-shapes.js";

describe("goal report shape normalization", () => {
  it("treats malformed report lists as empty", () => {
    expect(goalReportItems({ value: "not-an-array" })).toEqual([]);
    expect(goalReportItems(null)).toEqual([]);
  });

  it("keeps string report entries and drops malformed entries", () => {
    expect(goalReportItems(["已完成", 42, null, "待确认"])).toEqual(["已完成", "待确认"]);
  });
});
