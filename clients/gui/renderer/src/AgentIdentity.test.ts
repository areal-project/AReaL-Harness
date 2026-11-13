import { describe, expect, it } from "vite-plus/test";
import { agentTask } from "./AgentIdentity.js";

describe("agentTask", () => {
  it("ignores structured input objects from older agent records", () => {
    expect(
      agentTask({
        arguments: {
          input: { path: "workspace/file.txt", text: "内容" },
        },
      }),
    ).toBeUndefined();
  });

  it("reads text parts from delegation input arrays", () => {
    expect(
      agentTask({
        arguments: {
          input: [
            { type: "text", text: "检查启动问题" },
            { type: "image", uri: "areal://blob/1" },
          ],
        },
      }),
    ).toBe("检查启动问题");
  });
});
