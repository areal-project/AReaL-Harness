import { describe, expect, it } from "vite-plus/test";
import { markdownFileLocation } from "./path.js";

describe("Markdown file locations", () => {
  it("separates a line after decoding a spaced path", () => {
    expect(markdownFileLocation("src/a%20b.ts:12:4")).toEqual({ path: "src/a b.ts", line: 12 });
    expect(markdownFileLocation("src/a.ts#L12-L20")).toEqual({ path: "src/a.ts", line: 12 });
    expect(markdownFileLocation("./src/a%20b.ts#L120")).toEqual({ path: "src/a b.ts", line: 120 });
  });
  it("decodes HTML filename markers and literal escapes exactly once", () => {
    expect(markdownFileLocation("/tmp/%E4%B8%AD%E6%96%87%20%2520%23L12%3F.html")).toEqual({
      path: "/tmp/中文 %20#L12?.html",
      line: undefined,
    });
    expect(markdownFileLocation("/tmp/a%23b.%68tml").path).toBe("/tmp/a#b.html");
  });
  it("does not decode escaped HTML path separators", () => {
    expect(markdownFileLocation("/tmp/%2fserver.html").path).toBe("/tmp/%2fserver.html");
    expect(markdownFileLocation("/tmp/%5cserver.html").path).toBe("/tmp/%5cserver.html");
  });
  it("does not turn encoded filename markers into line syntax", () => {
    expect(markdownFileLocation("src/foo%23L12").line).toBeUndefined();
    expect(markdownFileLocation("src/foo%3A12").line).toBeUndefined();
  });
});
