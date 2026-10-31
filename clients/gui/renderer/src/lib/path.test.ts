import { describe, expect, it } from "vite-plus/test";
import { markdownFileLocation } from "./path.js";

describe("Markdown file locations", () => {
  it("separates a line after decoding a spaced path", () => {
    expect(markdownFileLocation("src/a%20b.ts:12:4")).toEqual({ path: "src/a b.ts", line: 12 });
    expect(markdownFileLocation("src/a.ts#L12-L20")).toEqual({ path: "src/a.ts", line: 12 });
  });
  it("does not turn encoded filename markers into line syntax", () => {
    expect(markdownFileLocation("src/foo%23L12").line).toBeUndefined();
    expect(markdownFileLocation("src/foo%3A12").line).toBeUndefined();
  });
});
