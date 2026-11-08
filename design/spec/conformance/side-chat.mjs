// 侧边聊天的行为验收：只用角色、读屏名称和文字。约定同 send-run-stop.mjs。
const pane = (page) => page.getByRole("region", { name: "侧边聊天", exact: true });

export const checks = [
  {
    id: "side-chat-empty-state",
    flow: "window.side-chat",
    async run({ open, expect }) {
      const page = await open("window.side-chat");
      const tabs = page.getByRole("tablist", { name: "侧边面板标签" });
      await expect(tabs.getByRole("tab", { name: "侧边聊天" })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await expect(pane(page).getByText("岔开一个问题，主聊天留在原处。")).toBeVisible();
      await expect(pane(page).getByText("讨论会保留，可从相关讨论中恢复。")).toBeVisible();
      await expect(pane(page).getByRole("button", { name: "新讨论" })).toBeVisible();
      await expect(pane(page).getByRole("button", { name: "相关侧边讨论" })).toBeVisible();
    },
  },
  {
    id: "side-chat-composer-at-bottom",
    flow: "window.side-chat",
    async run({ open, expect }) {
      const page = await open("window.side-chat");
      const input = pane(page).getByRole("textbox");
      await expect(input).toBeVisible();
      await expect(pane(page).getByRole("button", { name: "发送" })).toBeDisabled();
      await expect(pane(page).getByRole("button", { name: "更改权限" })).toHaveCount(0);
      const lead = await pane(page).getByText("岔开一个问题，主聊天留在原处。").boundingBox();
      const box = await input.boundingBox();
      if (!(lead && box && box.y > lead.y))
        throw new Error("expected composer below the empty state");
    },
  },
  {
    id: "side-chat-send-enables",
    flow: "window.side-chat",
    async run({ open, expect }) {
      const page = await open("window.side-chat");
      const input = pane(page).getByRole("textbox");
      await input.click();
      await page.keyboard.type("这个函数的边界怎么定？");
      await expect(pane(page).getByRole("button", { name: "发送" })).toBeEnabled();
    },
  },
];
