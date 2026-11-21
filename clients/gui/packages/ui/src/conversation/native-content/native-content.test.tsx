import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import {
  nativeContentToText,
  parseNativeContent,
  projectNativeContent,
} from "../../lib/conversation-content.js";
import { NativeContent } from "./native-content.js";

describe("NativeContent contract (R-NATIVECONTENT-003, R-CONTENT-029, R-CONTENT-030)", () => {
  it("validates version 1 bounds, rejects invalid schemas, and projects signed bar-chart values", () => {
    expect(
      parseNativeContent({ version: 2, type: "callout", title: "x", text: "y" }),
    ).toBeUndefined();
    expect(
      parseNativeContent({
        version: 1,
        type: "table",
        title: "Bad",
        columns: ["A", "B"],
        rows: [["only-one"]],
      }),
    ).toBeUndefined();

    const parsed = parseNativeContent({
      version: 1,
      type: "bar-chart",
      title: "变更对比",
      unit: "ms",
      items: [
        { label: "之前", value: 120 },
        { label: "差值", value: -40 },
      ],
    });
    expect(parsed).toBeDefined();
    if (!parsed) return;

    const text = nativeContentToText(parsed);
    expect(text).toContain("之前");
    expect(text).toContain("-40");

    const streamingBlocks = projectNativeContent('```areal-ui\n{"version":1', true);
    expect(streamingBlocks[0]?.kind).toBe("pending");

    const html = renderToStaticMarkup(<NativeContent value={parsed} />);
    expect(html).toContain('aria-label="变更对比"');
    expect(html).toContain("-40 ms");
    expect(html).toContain("查看数据");
  });
});
