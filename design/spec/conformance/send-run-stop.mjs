// 输入框试点的行为验收。只用角色、可读名称和可见文字，任何实现都能跑。
// 约定：实现提供一个入口 URL，接受 ?state=<flows 中的状态>&theme=light|dark，
// 用 fixtures/send-run-stop.json 渲染该状态，并按其中 agent 段回应操作。
import fixture from "../fixtures/send-run-stop.json" with { type: "json" };

const STOP = /^(停止|暂停执行)$/;
const draft = fixture.states["home.draft"].draft;
const rejected = Object.keys(fixture.agent.rejects)[0];

export const checks = [
  {
    id: "home-empty-cannot-send",
    flow: "home.empty",
    async run({ open, expect }) {
      const page = await open("home.empty");
      await expect(page.getByText(fixture.project.name)).toBeVisible();
      await expect(page.getByRole("textbox")).toBeVisible();
      await expect(page.getByRole("button", { name: "发送", exact: true })).toBeDisabled();
    },
  },
  {
    id: "home-send-starts-running",
    flow: "home.draft → thread.running",
    async run({ open, expect }) {
      const page = await open("home.empty");
      await page.getByRole("textbox").click();
      await page.keyboard.type(draft);
      await expect(page.getByRole("button", { name: "发送", exact: true })).toBeEnabled();
      await page.keyboard.press("Enter");
      await expect(page.getByText(draft)).toBeVisible();
      await expect(page.getByRole("button", { name: STOP })).toBeVisible();
      await expect(page.getByText(fixture.agent.firstStep)).toBeVisible();
    },
  },
  {
    id: "running-send-queues",
    flow: "thread.running → thread.queued",
    async run({ open, expect }) {
      const page = await open("thread.running");
      await page.getByRole("textbox").click();
      await page.keyboard.type("顺便更新 README");
      await expect(page.getByRole("button", { name: "发送", exact: true })).toBeEnabled();
      await page.getByRole("button", { name: "发送", exact: true }).click();
      await expect(page.getByRole("region", { name: "待发送消息" })).toContainText("顺便更新 README");
      await expect(page.getByRole("button", { name: STOP })).toBeVisible();
    },
  },
  {
    id: "stop-keeps-content",
    flow: "thread.running → thread.stopped",
    async run({ open, expect }) {
      const page = await open("thread.running");
      const user = fixture.conversations["thread-running"].turns[0].user;
      await page.getByRole("button", { name: STOP }).click();
      await expect(page.getByRole("button", { name: "发送", exact: true })).toBeVisible();
      await expect(page.getByText(user)).toBeVisible();
      await expect(page.getByText("你暂停了本轮执行")).toBeVisible();
    },
  },
  {
    id: "rejected-keeps-draft",
    flow: "thread.sending → thread.error",
    async run({ open, expect }) {
      const page = await open("thread.idle");
      await page.getByRole("textbox").click();
      await page.keyboard.type(rejected);
      await page.keyboard.press("Enter");
      await expect(page.getByText(fixture.agent.rejects[rejected])).toBeVisible();
      await expect(page.getByRole("textbox")).toHaveText(rejected);
      await expect(page.getByRole("button", { name: "发送", exact: true })).toBeEnabled();
    },
  },
  {
    id: "queued-state-renders",
    flow: "thread.queued",
    async run({ open, expect }) {
      const page = await open("thread.queued");
      const queued = fixture.states["thread.queued"].queue[0];
      await expect(page.getByRole("region", { name: "待发送消息" })).toContainText(queued);
      await expect(page.getByRole("button", { name: STOP })).toBeVisible();
    },
  },
];
