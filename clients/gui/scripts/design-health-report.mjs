// 设计系统活体体检与规则总览（Rule-as-Code，零手写文档）：
// 直接从 tokens.json、@areal/ui 组件清单与全部确定性 Lint 基线实时汇总当前生效规矩、债务与组件毕业进度。
//
//   node scripts/design-health-report.mjs                终端可读总览
//   node scripts/design-health-report.mjs --json         机器可读 JSON
//   node scripts/design-health-report.mjs --html <file>  输出自包含亮/暗自适应 HTML 体检页
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const gui = fileURLToPath(new URL("../", import.meta.url));

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function countLeafTokens(node) {
  if (!node || typeof node !== "object") return 0;
  if ("$value" in node || "value" in node) return 1;
  let total = 0;
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith("$")) continue;
    total += countLeafTokens(value);
  }
  return total;
}

function parseFrontmatter(markdown) {
  const match = /^---\n([\s\S]*?)\n---/.exec(markdown);
  if (!match) return {};
  const meta = {};
  for (const line of match[1].split("\n")) {
    const entry = /^([\w-]+)\s*:\s*(.+)$/.exec(line.trim());
    if (entry) meta[entry[1]] = entry[2].trim().replace(/^["']|["']$/g, "");
  }
  return meta;
}

export async function collectDesignHealth(root = gui) {
  const [
    tokensRaw,
    verifiedManifest,
    allowlist,
    literalBaseline,
    guardrailsBaseline,
    restyleBaseline,
    layersBaseline,
    a11yBaseline,
    popupBaseline,
    honestyBaseline,
  ] = await Promise.all([
    readFile(resolve(root, "packages/ui/tokens.json"), "utf8"),
    readJson(resolve(root, "design-system/verified-components.json")),
    readJson(resolve(root, "packages/ui/experimental-allowlist.json")),
    readJson(resolve(root, "design-system/literal-baseline.json")),
    readJson(resolve(root, "design-system/ui-guardrails-baseline.json")),
    readJson(resolve(root, "design-system/restyle-baseline.json")),
    readJson(resolve(root, "design-system/layers-baseline.json")),
    readJson(resolve(root, "design-system/a11y-lint-baseline.json")),
    readJson(resolve(root, "design-system/popup-anchor-baseline.json")),
    readJson(resolve(root, "design-system/ui-honesty-baseline.json")),
  ]);

  const tokensJson = JSON.parse(tokensRaw);
  const tokenGroups = Object.entries(tokensJson)
    .filter(([key]) => !key.startsWith("$"))
    .map(([group, value]) => ({ group, count: countLeafTokens(value) }))
    .filter((item) => item.count > 0);
  const tokenTotal = tokenGroups.reduce((sum, item) => sum + item.count, 0);
  const foundationTokens =
    countLeafTokens(tokensJson.foundation) + countLeafTokens(tokensJson.themes);
  const paletteEngineTokens = countLeafTokens(tokensJson.palette);

  const uiSrcDir = resolve(root, "packages/ui/src");
  const uiMdFiles = (await readdir(uiSrcDir, { recursive: true }))
    .map((file) => file.replaceAll("\\", "/"))
    .filter((file) => file.endsWith(".md") && !file.startsWith("generated/"))
    .sort();
  const verifiedIds = new Set((verifiedManifest.components ?? []).map((item) => item.id));
  const components = [];
  for (const file of uiMdFiles) {
    const content = await readFile(resolve(uiSrcDir, file), "utf8");
    const meta = parseFrontmatter(content);
    if (!meta.id) continue;
    components.push({
      id: meta.id,
      layer: meta.layer || file.split("/")[0],
      maturity: meta.status || meta.maturity || "unknown",
      verified: verifiedIds.has(meta.id),
    });
  }
  const byLayer = {};
  for (const comp of components) {
    byLayer[comp.layer] = (byLayer[comp.layer] || 0) + 1;
  }

  const guardrails = [
    {
      id: "color-literal",
      title: "颜色魔法值禁令",
      enforcer: "design-system-baseline.mjs",
      why: "颜色必须走语义 Token，自动适配明暗与自定义主题。",
      debt: literalBaseline.total?.color ?? 0,
    },
    {
      id: "typography-literal",
      title: "字号魔法值禁令",
      enforcer: "design-system-baseline.mjs",
      why: "字号必须走字体角色 Token，支持用户字号缩放。",
      debt: literalBaseline.total?.typography ?? 0,
    },
    {
      id: "radius-literal",
      title: "圆角魔法值禁令",
      enforcer: "design-system-baseline.mjs",
      why: "圆角按控件/面板/浮层角色统一。",
      debt: literalBaseline.total?.radius ?? 0,
    },
    {
      id: "spacing-literal",
      title: "间距魔法值禁令",
      enforcer: "ui-guardrails-lint.mjs",
      why: "padding / margin / gap 禁止新增硬编码 px/rem/em。",
      debt: guardrailsBaseline.total?.["spacing-literal"] ?? 0,
    },
    {
      id: "host-ui-class",
      title: "宿主禁穿透 @areal/ui 类名",
      enforcer: "ui-guardrails-lint.mjs",
      why: "页面 CSS 不得选中 @areal/ui 内部 .areal-* 类。",
      debt: guardrailsBaseline.total?.["host-ui-class"] ?? 0,
    },
    {
      id: "native-control",
      title: "上层业务禁写裸原生控件",
      enforcer: "ui-guardrails-lint.mjs + design-system-changes.mjs",
      why: "复用 @areal/ui 共享按钮/输入/选择控件，保持焦点与键盘一致。",
      debt: guardrailsBaseline.total?.["native-control"] ?? 0,
    },
    {
      id: "restyle",
      title: "禁改 @areal/ui 外观与 [data-slot]",
      enforcer: "restyle-lint.mjs",
      why: "外观差异收敛为组件 variant/slot，页面只管布局。",
      debt: Array.isArray(restyleBaseline) ? restyleBaseline.length : 0,
    },
    {
      id: "layers",
      title: "层级 z-index Token 约束",
      enforcer: "layers-lint.mjs",
      why: "浮层/弹窗/提示共享统一层级阶梯，避免互盖。",
      debt: Array.isArray(layersBaseline) ? layersBaseline.length : 0,
    },
    {
      id: "a11y",
      title: "无障碍与键盘语义护栏",
      enforcer: "a11y-lint.mjs",
      why: "可交互元素保留语义角色、标签与键盘可达。",
      debt: Array.isArray(a11yBaseline) ? a11yBaseline.length : 0,
    },
    {
      id: "popup-anchor",
      title: "浮层锚点防飘移护栏",
      enforcer: "popup-anchor-lint.mjs",
      why: "Popover / Menu 必须锚定到真实触发器，不出现错位。",
      debt: Array.isArray(popupBaseline) ? popupBaseline.length : 0,
    },
    {
      id: "ui-honesty",
      title: "界面诚实度与内部词禁令",
      enforcer: "ui-honesty-lint.mjs",
      why: "禁止向用户泄露 Core/Host/回执/快照与原始异常文本。",
      debt: Array.isArray(honestyBaseline) ? honestyBaseline.length : 0,
    },
    {
      id: "zero-tolerance",
      title: "零容忍硬规则（动效 / 术语 / 文案预算 / 原生 title / transition-all）",
      enforcer: "motion-lint + terms-lint + copy-budget + oxlint",
      why: "已彻底清零的硬边界，任何新增立即阻断。",
      debt: 0,
    },
  ].map((item) => ({
    ...item,
    status: item.debt === 0 ? "clean" : "ratchet",
  }));

  const stableCount = components.filter((item) => item.maturity === "stable").length;
  const experimentalCount = components.filter((item) => item.maturity === "experimental").length;
  const verifiedCount = components.filter((item) => item.verified).length;
  const allowlistCount = Object.keys(allowlist).filter((key) => !key.startsWith("$")).length;
  const totalDebt = guardrails.reduce((sum, item) => sum + item.debt, 0);

  return {
    generatedAt: new Date().toISOString(),
    humanEntries: [
      "DESIGN.md（审美宪法 + Taste Log）",
      ".agents/skills/areal-ui-guide/SKILL.md（开工指南）",
      ".agents/skills/areal-ui-critique/SKILL.md（视觉验收）",
    ],
    tokens: {
      lines: tokensRaw.trimEnd().split("\n").length,
      total: tokenTotal,
      foundation: foundationTokens,
      paletteEngine: paletteEngineTokens,
      groups: tokenGroups,
    },
    components: {
      total: components.length,
      verified: verifiedCount,
      stable: stableCount,
      experimental: experimentalCount,
      experimentalAllowlist: allowlistCount,
      byLayer,
      verifiedIds: [...verifiedIds].sort(),
    },
    guardrails,
    summary: {
      enforcedGuardrails: guardrails.length,
      cleanGuardrails: guardrails.filter((item) => item.debt === 0).length,
      ratchetGuardrails: guardrails.filter((item) => item.debt > 0).length,
      totalDebt,
    },
  };
}

export function formatTerminalReport(report) {
  const lines = [];
  lines.push("AReaL Harness Design System Health（自动生成，代码即真相）");
  lines.push("========================================================");
  lines.push(`人看入口: ${report.humanEntries.join(" | ")}`);
  lines.push(
    `Tokens  : 语义基础 ${report.tokens.foundation} 个 + 调色板引擎参数 ${report.tokens.paletteEngine} 个（合计 ${report.tokens.total}，tokens.json ${report.tokens.lines} 行）`,
  );
  lines.push(
    `组件库  : ${report.components.total} 个（verified ${report.components.verified} / stable ${report.components.stable} / experimental ${report.components.experimental}，生产豁免 ${report.components.experimentalAllowlist} 条）`,
  );
  lines.push(
    `硬护栏  : ${report.summary.enforcedGuardrails} 条生效（${report.summary.cleanGuardrails} 条已清零，${report.summary.ratchetGuardrails} 条棘轮收敛中，总存量债 ${report.summary.totalDebt}）`,
  );
  lines.push("");
  lines.push("生效中的确定性 Lint 护栏：");
  for (const item of report.guardrails) {
    const tag = item.debt === 0 ? "[已清零]" : `[存量 ${String(item.debt).padStart(3, " ")}]`;
    lines.push(`  ${tag} ${item.title} (${item.enforcer})`);
  }
  return lines.join("\n");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function renderHtmlReport(report) {
  const verifiedPct = report.components.total
    ? ((report.components.verified / report.components.total) * 100).toFixed(1)
    : "0.0";
  const rows = report.guardrails
    .map(
      (item) => `<tr>
        <td><strong>${escapeHtml(item.title)}</strong><div class="sub">${escapeHtml(item.why)}</div></td>
        <td><code>${escapeHtml(item.enforcer)}</code></td>
        <td class="num"><span class="pill ${item.debt === 0 ? "ok" : "warn"}">${item.debt === 0 ? "0 · 已清零" : `${item.debt} · 棘轮锁定`}</span></td>
      </tr>`,
    )
    .join("");
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>AReaL Harness Design System Health</title>
<style>
  :root { color-scheme: light dark; --bg: #ffffff; --fg: #181a1f; --muted: #667085; --card: #f7f8fa; --border: #e4e7ec; --ok: #15803d; --warn: #b45309; --radius: 10px; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #141518; --fg: #f2f4f7; --muted: #98a2b3; --card: #1d1f24; --border: #2c303a; --ok: #4ade80; --warn: #fbbf24; }
  }
  body { margin: 24px auto; max-width: 880px; padding: 0 16px; background: var(--bg); color: var(--fg); font: 14px/1.55 -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif; }
  h1 { font-size: 20px; margin: 0 0 6px; }
  .sub { color: var(--muted); font-size: 12px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin: 16px 0 20px; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); padding: 14px; }
  .val { font-size: 22px; font-weight: 700; margin: 4px 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  table { width: 100%; border-collapse: collapse; background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
  th, td { padding: 10px 12px; border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; }
  th { font-size: 12px; color: var(--muted); font-weight: 600; }
  td.num { text-align: right; white-space: nowrap; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  .pill { display: inline-block; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--border); font-size: 12px; font-weight: 600; }
  .pill.ok { color: var(--ok); }
  .pill.warn { color: var(--warn); }
</style>
</head>
<body>
  <h1>AReaL Harness Design System Health</h1>
  <div class="sub">自动生成自源码、tokens.json 与确定性 Lint 基线 · 生成时间 ${escapeHtml(report.generatedAt)}</div>
  <div class="grid">
    <div class="card"><div class="sub">Token 唯一源</div><div class="val">${report.tokens.total}</div><div class="sub">${report.tokens.lines} 行 · ${report.tokens.groups.length} 大类</div></div>
    <div class="card"><div class="sub">组件封口进度</div><div class="val">${report.components.verified} / ${report.components.total}</div><div class="sub">verified ${verifiedPct}% · stable ${report.components.stable} · exp ${report.components.experimental}</div></div>
    <div class="card"><div class="sub">生效硬护栏</div><div class="val">${report.summary.enforcedGuardrails}</div><div class="sub">${report.summary.cleanGuardrails} 清零 · ${report.summary.ratchetGuardrails} 棘轮锁定</div></div>
    <div class="card"><div class="sub">总存量债（只减不增）</div><div class="val">${report.summary.totalDebt}</div><div class="sub">实验豁免 ${report.components.experimentalAllowlist} 条</div></div>
  </div>
  <table>
    <thead><tr><th>硬护栏与意图</th><th>执行脚本</th><th style="text-align:right">当前状态</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</body>
</html>
`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await collectDesignHealth();
  const htmlIndex = process.argv.indexOf("--html");
  if (htmlIndex >= 0) {
    const outPath = process.argv[htmlIndex + 1];
    if (!outPath) throw new Error("--html requires an output file path");
    await writeFile(resolve(process.cwd(), outPath), renderHtmlReport(report));
    console.log(JSON.stringify({ written: outPath, summary: report.summary }));
  } else if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatTerminalReport(report));
  }
}
