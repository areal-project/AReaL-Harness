import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { MessageCodeBlock } from "./message-code-block.js";

describe("MessageCodeBlock contract (R-MESSAGECODEBLOCK-002)", () => {
  it("renders inline preview alongside source toggle when closed, and source only when no preview is supplied", () => {
    const withPreview = renderToStaticMarkup(
      <MessageCodeBlock
        code="graph TD; A-->B;"
        language="mermaid"
        streaming={false}
        fontSizePx={13}
        CodeComponent={({ code }) => <pre>{code}</pre>}
        preview={<div data-testid="mermaid-preview">diagram</div>}
      />,
    );
    expect(withPreview).toContain('aria-label="预览图形"');
    expect(withPreview).toContain('aria-label="查看源码"');
    expect(withPreview).toContain('data-testid="mermaid-preview"');

    const codeOnly = renderToStaticMarkup(
      <MessageCodeBlock
        code="graph TD; A-->"
        language="mermaid"
        streaming
        fontSizePx={13}
        CodeComponent={({ code }) => <pre>{code}</pre>}
      />,
    );
    expect(codeOnly).not.toContain('aria-label="预览图形"');
    expect(codeOnly).toContain("graph TD; A--&gt;");
  });
});
