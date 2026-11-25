import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { ImageDisclosure } from "./image-disclosure.js";

describe("ImageDisclosure contract (R-IMAGEDISCLOSURE-002, R-IMAGEDISCLOSURE-003, R-IMAGEDISCLOSURE-005)", () => {
  it("starts collapsed by default and renders unavailable feedback outside the disclosure", () => {
    const availableHtml = renderToStaticMarkup(
      <ImageDisclosure label="已查看图片 · mock.png" state="available">
        <img
          src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="
          alt="mock"
        />
      </ImageDisclosure>,
    );
    expect(availableHtml).toContain("已查看图片 · mock.png");
    expect(availableHtml).toContain('aria-expanded="false"');
    expect(availableHtml).toContain('alt="mock"');

    const unavailableHtml = renderToStaticMarkup(
      <ImageDisclosure
        label="已查看图片 · mock.png"
        state="unavailable"
        message="图片已不可用，原引用保留。"
      />,
    );
    expect(unavailableHtml).toContain('aria-expanded="false"');
    expect(unavailableHtml).toContain('role="status"');
    expect(unavailableHtml).toContain("图片已不可用，原引用保留。");
  });
});
