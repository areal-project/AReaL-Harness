import { describe, expect, it } from "vite-plus/test";
import { dataItems } from "./data-shapes.js";

describe("turn execution shape normalization", () => {
  it("treats malformed item collections as empty", () => {
    expect(dataItems({ id: "not-an-array" })).toEqual([]);
    expect(dataItems(undefined)).toEqual([]);
  });

  it("preserves valid execution item collections", () => {
    const items = [{ type: "reasoning", text: "思考" }];
    expect(dataItems(items)).toEqual(items);
  });
});
