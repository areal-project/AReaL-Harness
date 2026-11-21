import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { QuestionCard, QuestionSummary } from "./question-card.js";

describe("QuestionCard contract (R-QUESTIONCARD-002)", () => {
  it("reflects unselected, selected, and disabled/busy states without fabricating completion", () => {
    const unselected = renderToStaticMarkup(
      <QuestionCard
        title="选择运行模式"
        options={["选项 A", "选项 B"]}
        onSelect={() => {}}
        footer={<button type="button">提交</button>}
      />,
    );
    expect(unselected).toContain('data-selected="false"');
    expect(unselected).not.toContain('checked=""');

    const selectedBusy = renderToStaticMarkup(
      <QuestionCard
        title="选择运行模式"
        options={["选项 A", "选项 B"]}
        selected="选项 A"
        disabled
        busy
        onSelect={() => {}}
        footer={<button type="button">提交中</button>}
      />,
    );
    expect(selectedBusy).toContain('data-selected="true"');
    expect(selectedBusy).toContain('checked=""');
    expect(selectedBusy).toContain('disabled=""');
    expect(selectedBusy).toContain('aria-busy="true"');
  });

  it("renders submitted Q&A history as a collapsible summary with muted empty answers", () => {
    const html = renderToStaticMarkup(
      <QuestionSummary
        summary="已回答 2 个问题"
        open
        items={[{ question: "运行环境？", answer: "本地工作区" }, { question: "补充说明？" }]}
      />,
    );
    expect(html).toContain('data-slot="question-summary"');
    expect(html).toContain("已回答 2 个问题");
    expect(html).toContain("本地工作区");
    expect(html).toContain('data-empty="true"');
    expect(html).toContain("未提供回答");
  });
});
