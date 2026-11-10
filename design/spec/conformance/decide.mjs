// 审批与提问卡片的行为验收。约定同 send-run-stop.mjs。
import fixture from "../fixtures/send-run-stop.json" with { type: "json" };

const STOP = /^(停止|暂停执行)$/;
const approval = fixture.conversations["thread-approval"].decision;
const question = fixture.conversations["thread-question"].decision;
const replies = fixture.agent.decisions;

export const checks = [
  {
    id: "approval-allow-continues",
    flow: "thread.approval → thread.running",
    async run({ open, expect }) {
      const page = await open("thread.approval");
      const card = page.getByRole("region", { name: "工具审批" });
      await expect(card).toContainText(approval.title);
      await expect(card).toContainText(approval.command);
      await card.getByRole("button", { name: /^允许一次/ }).click();
      await expect(page.getByText(replies.allow)).toBeVisible();
      await expect(page.getByRole("region", { name: "工具审批" })).toBeHidden();
      await expect(page.getByRole("button", { name: STOP })).toBeVisible();
    },
  },
  {
    id: "approval-deny-continues",
    flow: "thread.approval → thread.running",
    async run({ open, expect }) {
      const page = await open("thread.approval");
      await page
        .getByRole("region", { name: "工具审批" })
        .getByRole("button", { name: /^拒绝/ })
        .click();
      await expect(page.getByText(replies.deny)).toBeVisible();
      await expect(page.getByRole("region", { name: "工具审批" })).toBeHidden();
    },
  },
  {
    id: "question-answer-continues",
    flow: "thread.question → thread.running",
    async run({ open, expect }) {
      const page = await open("thread.question");
      const card = page.getByRole("region", { name: "需要你的回答" });
      await expect(card).toContainText(question.title);
      await expect(card.getByRole("button", { name: "发送", exact: true })).toBeDisabled();
      await card.getByText(question.options[1]).click();
      await card.getByRole("button", { name: "发送", exact: true }).click();
      await expect(
        page.getByText(replies.answer.replace("{answer}", question.options[1])),
      ).toBeVisible();
      await expect(page.getByRole("region", { name: "需要你的回答" })).toBeHidden();
    },
  },
  {
    id: "question-defer-and-reopen",
    flow: "thread.question → thread.question-deferred → thread.question",
    async run({ open, expect }) {
      const page = await open("thread.question");
      await page.getByRole("button", { name: "稍后回答", exact: true }).click();
      await expect(page.getByRole("region", { name: "需要你的回答" })).toBeHidden();
      await page.getByRole("button", { name: "展开待回答问题" }).click();
      await expect(page.getByRole("region", { name: "需要你的回答" })).toContainText(
        question.title,
      );
    },
  },
];
