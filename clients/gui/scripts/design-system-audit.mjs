import { verifyDesignCatalog } from "./design-system-catalog.mjs";
import { cssFindings, tsxFindings } from "./design-system-rules.mjs";
import { auditDesignChanges } from "./design-system-changes.mjs";
import { verifyLiteralBaseline } from "./design-system-baseline.mjs";
import { verifyMaturity } from "./design-system-maturity.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const catalog = await verifyDesignCatalog();

const root = fileURLToPath(new URL("../renderer/src/", import.meta.url));
const files = ["DecisionCard.css", "prompt-editor/ComposerSurface.css", "SideChat.css", "components/ui/feedback.css", "settings/SettingsPageParts.css", "settings/SettingsPageParts.tsx", "prompt-editor/ComposerSurface.tsx", "prompt-editor/ChatPromptEditor.tsx", "SideChatPane.tsx", "app-shell/SidePane.tsx", "app-shell/SidePaneTabTrigger.tsx"];

assert.equal(cssFindings(".x{font-size:12px;color:#fff;padding:12px}").length, 2);
assert.equal(cssFindings(".x{color:red;background:transparent}").length, 1);
assert.equal(cssFindings("/* color:#fff */ .x{font-size:var(--text-ui-sm);color:var(--color-foreground);padding:12px}").length, 0);
for (const [source, count] of [
  ['<div className="text-sm bg-red-500" />', 2],
  ['<div className={cn("px-4", active && "text-[12px]")} />', 1],
  ['<div className={active ? "text-white" : "bg-blue-600"} />', 2],
  ['<div className={`px-4 ${active ? "text-lg" : "text-xs"}`} />', 2],
  ['<div style={{ fontSize: 12, color: "#fff" }} />', 2],
  ['<div style={{ backgroundColor: "rgb(0 0 0)", fontSize: "1rem" }} />', 2],
  ['<div className="hover:text-sm data-[active]:bg-red-500 [&>p]:text-white" />', 3],
]) assert.equal(tsxFindings(source).length, count, source);
for (const source of [
  '<div className={cn("text-ui-sm bg-surface px-4", active && "text-foreground")} />',
  '<div className={`max-w-[280px] ${active ? "text-ui-base" : "text-ui-sm"}`} />',
  '<div style={{ fontSize: "var(--text-ui-sm)", color: "var(--color-foreground)", width: 280, padding: "12px" }} />',
  '<p>text-sm #fff is content</p>',
]) assert.deepEqual(tsxFindings(source), [], source);

const sources = await Promise.all(files.map(file => readFile(join(root, file), "utf8")));
const owners = await Promise.all(["styles.css", "settings/applicationSettings.ts", "settings/applicationPreferences.ts"].map(file => readFile(join(root, file), "utf8")));
const uiSources = await Promise.all(["generated/foundation.css", "generated/tailwind.css", "theme.ts"].map(file => readFile(new URL(`../packages/ui/src/${file}`, import.meta.url), "utf8")));
const sharedFocus = await readFile(new URL("../../../design/tokens/focus.css", import.meta.url), "utf8");
const webStyle = await readFile(new URL("../../web/style.css", import.meta.url), "utf8");
const coreServer = await readFile(new URL("../../../core/app-server/src/lib.rs", import.meta.url), "utf8");
assert.match(owners[0], /@import\s+["']\.\.\/\.\.\/\.\.\/\.\.\/design\/tokens\/focus\.css["'];/, "GUI imports the shared focus source");
assert.match(coreServer, /concat!\(\s*include_str!\("\.\.\/\.\.\/\.\.\/design\/tokens\/focus\.css"\),\s*"\\n",\s*include_str!\("\.\.\/\.\.\/\.\.\/clients\/web\/style\.css"\)\s*\)/, "Core embeds shared focus CSS before Web CSS");
for (const token of ["--focus-width", "--focus-offset"]) {
  assert.equal([...sharedFocus.matchAll(new RegExp(`${token}\\s*:`, "g"))].length, 1, `${token} has one shared default`);
  assert.match(sharedFocus, new RegExp(`${token}\\s*:\\s*2px\\s*;`), `${token} retains the 2px baseline`);
  for (const [name, source] of [["GUI", owners[0]], ["Web", webStyle], ...files.map((name, index) => [name, sources[index]])]) {
    assert.doesNotMatch(source, new RegExp(`${token}\\s*:`), `${name} must not duplicate ${token}`);
  }
  assert.ok(webStyle.includes(`var(${token})`), `Web consumes ${token}`);
}
// Token 单源：@areal/ui 生成的基础角色与默认调色板，不能在 renderer 的全局主题选择器里再定义一次。
// 组件内的局部重映射（如消息正文把 --text-ui-base 指向内容字号）不受限制。
const ownedTokens = new Set([...uiSources.slice(0, 2).join("\n").matchAll(/(--[\w-]+)\s*:/g)].map(match => match[1]));
const themeSource = await readFile(new URL("../packages/ui/src/generated/themes.css", import.meta.url), "utf8");
for (const match of themeSource.matchAll(/(--[\w-]+)\s*:/g)) ownedTokens.add(match[1]);
assert.match(owners[0], /@import\s+["']@areal\/ui\/themes\.css["'];/, "GUI imports generated default themes for first paint");
const globalSelector = /^(?:@theme|:root|html|\.dark|\.light|\.theme-[\w-]+)(?:\s*,\s*(?:@theme|:root|html|\.dark|\.light|\.theme-[\w-]+|:root\.[\w-]+))*$/;
const redefinitions = [];
for (const file of await rendererCss()) {
  const source = (await readFile(join(root, file), "utf8")).replace(/\/\*[\s\S]*?\*\//g, "");
  for (const block of source.matchAll(/(^|\})\s*([^{}]+?)\s*\{([^{}]*)\}/g)) {
    if (!globalSelector.test(block[2].trim())) continue;
    for (const declaration of block[3].matchAll(/(--[\w-]+)\s*:/g))
      if (ownedTokens.has(declaration[1])) redefinitions.push(`${file} ${block[2].trim()} ${declaration[1]}`);
  }
}
assert.deepEqual(redefinitions, [], `以下变量由 @areal/ui/tokens.json 生成，请修改 tokens.json：\n${redefinitions.join("\n")}`);
async function rendererCss() {
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(root, { recursive: true });
  return entries.filter(file => file.endsWith(".css")).sort();
}
const definitions = new Set([...(sharedFocus + owners.join("\n") + uiSources.join("\n") + sources.join("\n")).matchAll(/(--[\w-]+)["']?\s*:/g)].map(match => match[1]));
const violations = [];
sources.forEach((source, index) => {
  violations.push(...(files[index].endsWith(".css") ? cssFindings(source) : tsxFindings(source)).map(value => `${files[index]}: ${value}`));
  for (const match of source.matchAll(/var\((--[\w-]+)/g)) {
    if (!definitions.has(match[1])) violations.push(`${files[index]}: undefined token ${match[1]}`);
  }
});
assert.deepEqual(violations, [], `设计系统新增硬编码：\n${violations.join("\n")}`);
const changes = await auditDesignChanges();
assert.deepEqual(changes.violations, [], `新增 UI 设计违规：\n${changes.violations.map(item => `${item.file}: ${item.finding}`).join("\n")}`);
const literals = await verifyLiteralBaseline();
const maturity = await verifyMaturity();
console.log(JSON.stringify({ passed: true, catalog, files, changes, literals, maturity, scope: "complete migrated CSS and static JSX className/style literals, including cn, conditionals and templates; dynamic indirect styles are not covered; layout numbers remain component-owned" }));
