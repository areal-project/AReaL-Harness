import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { QuestionCard } from "./question-card.js";

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
});
