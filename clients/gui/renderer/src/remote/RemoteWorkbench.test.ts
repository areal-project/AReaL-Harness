import { describe, expect, it } from "vite-plus/test";
import { remoteQueueInput } from "../data-shapes.js";

describe("remote queue shape normalization", () => {
  it("does not render malformed queue input as an array", () => {
    expect(remoteQueueInput({ input: { text: "旧形状" } })).toEqual([]);
    expect(remoteQueueInput({ input: null })).toEqual([]);
  });

  it("preserves valid queue input parts", () => {
    const input = [{ type: "text", text: "排队消息" }];
    expect(remoteQueueInput({ input })).toEqual(input);
  });
});
