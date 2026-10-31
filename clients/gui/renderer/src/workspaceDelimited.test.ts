import { describe, expect, it } from "vite-plus/test";
import { parseDelimitedPreview } from "./workspaceDelimited.js";

describe("workspace delimited previews", () => {
  it("reads CRLF, quoted delimiters, escaped quotes and multiline fields", () => {
    expect(parseDelimitedPreview('\ufeffa,b\r\n"x,y","say ""hi""\nnext"\r\n', ",")).toEqual({
      rows: [
        ["a", "b"],
        ["x,y", 'say "hi"\nnext'],
      ],
      truncated: false,
      malformed: false,
    });
  });
  it("preserves empty TSV columns and a final blank field", () => {
    expect(parseDelimitedPreview("a\t\tc\n\t\t", "\t").rows).toEqual([
      ["a", "", "c"],
      ["", "", ""],
    ]);
  });
  it("bounds displayed rows and columns without calling the source complete", () => {
    const result = parseDelimitedPreview(
      Array.from({ length: 250 }, () => Array(110).fill("x").join(",")).join("\n"),
      ",",
    );
    expect(result.rows).toHaveLength(200);
    expect(result.rows[0]).toHaveLength(100);
    expect(result.truncated).toBe(true);
  });
  it("reports incomplete or misplaced quotes instead of presenting corrupted cells", () => {
    expect(parseDelimitedPreview('"a\nb', ",").malformed).toBe(true);
    expect(parseDelimitedPreview('"a"oops,b', ",").malformed).toBe(true);
    expect(parseDelimitedPreview('ab"cd', ",").malformed).toBe(true);
  });
});
