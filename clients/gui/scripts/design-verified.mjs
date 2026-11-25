// 已迁移组件的确定性检查（design-system/verified-components.json）：
// 合同长度、强制规则有可追溯的检查、组件 CSS 只引用 Token、宿主 CSS 不覆盖组件内部、行为表被测试读取。
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../../../", import.meta.url));
const stripComments = (css) =>
  css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
// CSS 规范不允许在 @media / @container 查询条件里使用 var(--*)，剥离查询头同时保留行号。
const stripAtQueryPreludes = (css) =>
  css.replace(/@(?:media|container)\b[^{]*/g, (query) => query.replace(/[^\n]/g, " "));
const lineOf = (text, index) => text.slice(0, index).split("\n").length;

/** 组件 CSS 中绕过 Token 的字面量：长度（0 和 1px 发丝线除外）、颜色、时长与缓动曲线。 */
export function literalFindings(css) {
  const source = stripAtQueryPreludes(stripComments(css));
  const findings = [];
  const patterns = [
    [
      /(?<![\w-])(\d*\.?\d+)(px|rem|em)\b/g,
      (match) => !(match[2] === "px" && Number(match[1]) <= 1),
    ],
    [/#[0-9a-fA-F]{3,8}\b/g, () => true],
    [/\b(?:rgba?|hsla?|oklch|oklab)\(/g, () => true],
    [/(?<![\w-])\d*\.?\d+m?s\b/g, () => true],
    [/cubic-bezier\(/g, () => true],
  ];
  for (const [pattern, keep] of patterns)
    for (const match of source.matchAll(pattern))
      if (keep(match))
        findings.push({ index: match.index, text: `${lineOf(source, match.index)}: ${match[0]}` });
  return findings.sort((a, b) => a.index - b.index).map((finding) => finding.text);
}

/** 宿主 CSS 里选中组件内部 class 的规则。 */
export function hostOverrides(css, selectors) {
  const source = stripComments(css);
  const findings = [];
  for (const match of source.matchAll(/([^{}]+)\{/g)) {
    const selector = match[1].trim();
    if (selector.startsWith("@")) continue;
    for (const internal of selectors) {
      const escaped = internal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`${escaped}(?![\\w-])`).test(selector))
        findings.push(
          `${lineOf(source, match.index + match[0].length - selector.length - 1)}: ${selector.replace(/\s+/g, " ")}`,
        );
    }
  }
  return findings;
}

async function cssFiles(directory) {
  return (await readdir(directory, { recursive: true }))
    .filter((file) => file.endsWith(".css"))
    .map((file) => resolve(directory, file));
}

export async function verifyComponents({ root = repository } = {}) {
  const manifest = JSON.parse(
    await readFile(resolve(root, "clients/gui/design-system/verified-components.json"), "utf8"),
  );
  const registry = JSON.parse(
    await readFile(resolve(root, "clients/gui/design-system/rule-registry.json"), "utf8"),
  );
  const problems = [];
  const contracts = new Set(manifest.components.map((component) => component.contract));
  for (const component of manifest.components) {
    const contract = await readFile(resolve(root, component.contract), "utf8");
    for (const id of component.enforces ?? [])
      if (
        !registry.rules.some(
          (rule) => rule.id === id && rule.owner.startsWith(`${component.contract}#`),
        )
      )
        problems.push(`${component.id} 声明保证 ${id}，但该规则不在 ${component.contract}`);
    const lines = contract.trimEnd().split("\n").length;
    if (lines > manifest.contractMaxLines)
      problems.push(`${component.contract}: ${lines} 行，超过 ${manifest.contractMaxLines} 行上限`);
    for (const style of component.styles)
      for (const finding of literalFindings(await readFile(resolve(root, style), "utf8")))
        problems.push(`${style}:${finding} 是字面量，请改用 Token（packages/ui/tokens.json）`);
  }
  const ruled = registry.rules.filter(
    (rule) =>
      contracts.has(rule.owner.split("#")[0]) || manifest.rules.some((item) => item.id === rule.id),
  );
  for (const rule of ruled)
    if (
      (rule.strength === "must" || manifest.rules.some((item) => item.id === rule.id)) &&
      (!rule.check || rule.check === "review")
    )
      problems.push(`${rule.id} 是强制规则，正文需要“**检查：**\`测试路径\`”`);
  for (const item of manifest.rules) {
    const rule = registry.rules.find((rule) => rule.id === item.id);
    if (!rule) {
      problems.push(`${item.id} 不在 rule-registry.json`);
      continue;
    }
    if (!item.behaviorTable) continue;
    await readFile(resolve(root, item.behaviorTable)).catch(() =>
      problems.push(`${item.id} 的行为表不存在：${item.behaviorTable}`),
    );
    const test = rule.check && (await readFile(resolve(root, rule.check), "utf8").catch(() => ""));
    if (!test?.includes(basename(item.behaviorTable)))
      problems.push(`${rule.check ?? item.id} 没有读取行为表 ${basename(item.behaviorTable)}`);
  }
  const selectors = manifest.components.flatMap((component) => component.internalSelectors);
  for (const directory of manifest.hostStyles)
    for (const file of await cssFiles(resolve(root, directory)))
      for (const finding of hostOverrides(await readFile(file, "utf8"), selectors))
        problems.push(
          `${relative(root, file)}:${finding} 覆盖了组件内部样式，请给组件加部件或 Token`,
        );
  assert.deepEqual(problems, [], `设计系统已迁移组件检查失败：\n${problems.join("\n")}`);
  return { components: manifest.components.length, rules: ruled.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  console.log(JSON.stringify(await verifyComponents()));
