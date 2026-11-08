// 设置其余十页的行为验收：只用角色、读屏名称和文字。约定同 send-run-stop.mjs。
import { besideGap, gap, height, near } from "./layout.mjs";

const nav = (page) => page.getByRole("navigation", { name: "设置导航" });
const item = (page, name) => nav(page).getByRole("button", { name, exact: true });
const pageRegion = (page, name) => page.getByRole("region", { name, exact: true });

// 每页：导航项、页内应看到的标题和控件。
const PAGES = [
  {
    name: "使用情况",
    state: "window.settings-usage",
    expect: (region) => [
      region.getByText("累计使用", { exact: true }),
      region.getByRole("heading", { level: 2, name: "使用活跃度" }),
      region.getByRole("combobox", { name: "统计年份" }),
      region.getByRole("heading", { level: 2, name: "Skills 排行" }),
    ],
  },
  {
    name: "SnapShots",
    state: "window.settings-snapshots",
    expect: (region) => [region.getByText("此环境尚不支持 SnapShots。")],
  },
  {
    name: "浏览器",
    state: "window.settings-browser",
    expect: (region) => [
      region.getByText("管理链接打开方式和地址栏显示。"),
      region.getByRole("tablist", { name: "网页 URL 和链接打开位置" }),
      region.getByRole("switch", { name: "显示完整网址" }),
      region.getByRole("button", { name: "清除全部浏览数据" }),
    ],
  },
  {
    name: "云端",
    state: "window.settings-cloud",
    expect: (region) => [
      region.getByRole("textbox", { name: "Cloud 后端地址" }),
      region.getByRole("button", { name: "保存", exact: true }),
    ],
  },
  {
    name: "电脑控制",
    state: "window.settings-computer",
    expect: (region) => [
      region.getByRole("tablist", { name: "控制方式" }),
      region.getByRole("switch", { name: "启用电脑控制" }),
      region.getByRole("heading", { level: 2, name: "系统授权" }),
      region.getByRole("button", { name: "停止电脑操作" }),
    ],
  },
  {
    name: "工作树",
    state: "window.settings-worktrees",
    expect: (region) => [
      region.getByText("管理工作树的创建、清理和项目环境。"),
      region.getByRole("textbox", { name: "工作树根目录" }),
      region.getByRole("spinbutton", { name: "保留工作树数量" }),
      region.getByRole("heading", { level: 2, name: "已有工作树" }),
    ],
  },
  {
    name: "钩子",
    state: "window.settings-hooks",
    expect: (region) => [
      region.getByText("按顺序运行工具事件命令，修改后重启后台生效。"),
      region.getByRole("button", { name: "添加钩子" }),
      region.getByRole("button", { name: "编辑提交前检查" }),
      region.getByRole("button", { name: "重启后台并应用" }),
    ],
  },
  {
    name: "模型设置",
    state: "window.settings-models",
    expect: (region) => [
      region.getByRole("complementary", { name: "供应商目录" }),
      region.getByRole("switch", { name: "启用供应商" }),
      region.getByRole("button", { name: "添加模型" }),
    ],
  },
  {
    name: "手机连接",
    state: "window.settings-mobile",
    expect: (region) => [
      region.getByText("用 iPhone 或其他浏览器继续电脑上的工作。"),
      region.getByRole("button", { name: "添加设备" }),
      region.getByRole("heading", { level: 2, name: "设备" }),
    ],
  },
  {
    name: "数据飞轮",
    state: "window.settings-flywheel",
    expect: (region) => [
      region.getByRole("switch", { name: "启用数据飞轮" }),
      region.getByRole("heading", { level: 2, name: "队列与失败" }),
      region.getByRole("navigation", { name: "上传记录分页" }),
    ],
  },
];

export const checks = [
  {
    id: "settings-pages-reach-each",
    flow: "window.settings → 每个 window.settings-*",
    async run({ open, expect }) {
      const page = await open("window.settings");
      for (const target of PAGES) {
        await item(page, target.name).click();
        await expect(page.getByRole("heading", { level: 1, name: target.name })).toBeVisible();
        await expect(item(page, target.name)).toHaveAttribute("aria-current", "page");
      }
    },
  },
  ...PAGES.map((target) => ({
    id: `settings-page-${target.state.slice("window.settings-".length)}`,
    flow: target.state,
    async run({ open, expect }) {
      const page = await open(target.state);
      const region = pageRegion(page, target.name);
      await expect(region.getByRole("heading", { level: 1, name: target.name })).toBeVisible();
      for (const locator of target.expect(region)) await expect(locator).toBeVisible();
    },
  })),
  {
    id: "settings-hooks-order-bounds",
    flow: "window.settings-hooks",
    async run({ open, expect }) {
      const page = await open("window.settings-hooks");
      await expect(page.getByRole("button", { name: "上移 提交前检查" })).toBeDisabled();
      await expect(page.getByRole("button", { name: "下移 提交前检查" })).toBeDisabled();
    },
  },
  {
    id: "settings-browser-segmented",
    flow: "window.settings-browser",
    async run({ open, expect }) {
      const page = await open("window.settings-browser");
      const web = page.getByRole("tablist", { name: "网页 URL 和链接打开位置" });
      const local = page.getByRole("tablist", { name: "本地 URL 打开位置" });
      await expect(web.getByRole("tab", { name: "默认浏览器" })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await expect(local.getByRole("tab", { name: "应用内" })).toHaveAttribute(
        "aria-selected",
        "true",
      );
    },
  },
  {
    id: "settings-mobile-spacing",
    flow: "window.settings-mobile",
    async run({ open, expect }) {
      const page = await open("window.settings-mobile");
      const region = pageRegion(page, "手机连接");
      const title = region.getByRole("heading", { level: 1, name: "手机连接" });
      const add = region.getByRole("button", { name: "添加设备" });
      const relay = region.getByRole("heading", { level: 2, name: "Relay 服务" });
      const devices = region.getByRole("heading", { level: 2, name: "设备" });
      await expect(devices).toBeVisible();
      near("标题块→状态卡（spacing-field×2.5）", await gap(title, add), 40);
      near("状态卡→Relay 服务（spacing-section）", await gap(add, relay), 24);
      near("Relay 服务→设备（spacing-section）", await gap(relay, devices), 24);
      near(
        "设备标题→设备卡（spacing-inline）",
        await gap(devices, region.getByText("我的 iPhone")),
        8,
      );
      near("添加设备按钮高（spacing-control）", await height(add), 28);
      near(
        "开启内网连接按钮高（spacing-control）",
        await height(region.getByRole("button", { name: "开启内网连接" })),
        28,
      );
    },
  },
  {
    id: "settings-models-catalog-separator",
    flow: "window.settings-models",
    async run({ open, expect }) {
      const page = await open("window.settings-models");
      const catalog = page.getByRole("complementary", { name: "供应商目录" });
      const enabled = catalog.getByRole("button", { name: "示例服务" });
      const disabled = catalog.getByText("未启用", { exact: true });
      await expect(disabled).toBeVisible();
      // 线在下一组的块顶边：按钮下缘到线 spacing-field；线（border-width-default）到组名行框顶 spacing-field。
      near("上一组按钮→分隔线（spacing-field）", await gap(enabled, disabled), 16);
      const above = await enabled.boundingBox();
      const below = await disabled.boundingBox();
      near(
        "按钮下缘→组名行框（spacing-field + 线 + spacing-field）",
        below.y - (above.y + above.height),
        33,
      );
    },
  },
  {
    id: "settings-usage-calendar-spacing",
    flow: "window.settings-usage",
    async run({ open, expect }) {
      const page = await open("window.settings-usage");
      const region = pageRegion(page, "使用情况");
      const monday = region.getByText("周一", { exact: true });
      const january = region.getByText("1月", { exact: true });
      const less = region.getByText("少", { exact: true });
      await expect(monday).toBeVisible();
      near("行名列→周列（spacing-inline）", await besideGap(monday, january), 8);
      near("日历→图例（spacing-inline×1.5）", await gap(monday, less), 12);
      near(
        "图例→当天详情（spacing-inline×2.5）",
        await gap(less, region.getByText("使用时间", { exact: true })),
        20,
      );
    },
  },
];
