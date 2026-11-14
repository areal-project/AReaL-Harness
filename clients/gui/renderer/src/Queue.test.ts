import { describe, expect, it } from "vite-plus/test";
import { queueInput, queueItems, queueText } from "./data-shapes.js";

describe("queue shape normalization", () => {
  it("treats malformed queue collections as empty", () => {
    expect(queueItems({ items: { id: "not-an-array" } })).toEqual([]);
    expect(queueInput({ input: { type: "text", text: "旧形状" } })).toEqual([]);
  });

  it("keeps valid queue text and item collections", () => {
    const item = { input: [{ type: "text", text: "继续任务" }, { type: "image" }] };
    expect(queueItems({ items: [item] })).toEqual([item]);
    expect(queueText(item)).toBe("继续任务\n[附件]");
  });
});
