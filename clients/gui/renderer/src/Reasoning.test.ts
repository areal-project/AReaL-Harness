import { describe, expect, it } from "vite-plus/test";
import { stringItems } from "./data-shapes.js";

describe("reasoning shape normalization", () => {
  it("treats malformed summary and content as empty", () => {
    expect(stringItems({ text: "旧格式" })).toEqual([]);
    expect(stringItems(null)).toEqual([]);
  });

  it("keeps only string reasoning entries", () => {
    expect(stringItems(["摘要", 42, { text: "对象" }, "内容"])).toEqual(["摘要", "内容"]);
  });
});
