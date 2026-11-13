import { describe, expect, it } from "vite-plus/test";
import { dataItems } from "./data-shapes.js";

describe("message shape normalization", () => {
  it("treats malformed question collections as empty", () => {
    expect(dataItems({ id: "not-an-array" })).toEqual([]);
    expect(dataItems(null)).toEqual([]);
  });

  it("preserves valid question collections", () => {
    const questions = [{ id: "q1", title: "确认" }];
    expect(dataItems(questions)).toEqual(questions);
  });
});
