import { describe, expect, it } from "vite-plus/test";
import { channelQuestionOptions, channelQuestions } from "./data-shapes.js";

describe("channel question shape normalization", () => {
  it("treats malformed questions and options as empty", () => {
    expect(channelQuestions({ questions: { id: "not-an-array" } })).toEqual([]);
    expect(channelQuestionOptions({ options: { value: "not-an-array" } })).toEqual([]);
    expect(channelQuestionOptions({ options: ["可用", 42, null] })).toEqual(["可用"]);
  });

  it("preserves valid questions and string options", () => {
    const question = { id: "q1", options: ["是", "否"] };
    expect(channelQuestions({ questions: [question] })).toEqual([question]);
    expect(channelQuestionOptions(question)).toEqual(["是", "否"]);
  });
});
