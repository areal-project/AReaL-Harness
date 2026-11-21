// 上层 UI 硬护栏棘轮（只减不增）：
// 1) spacing-literal: 禁止新增非 Token 的 padding/margin/gap 字面量
// 2) host-ui-class:   禁止宿主 CSS 新增对 @areal/ui 内部 .areal-* 类的样式穿透
// 3) native-control:  禁止上层业务 TSX 新增绕开 @areal/ui 的裸原生控件
//
//   node scripts/ui-guardrails-lint.mjs          检查（新增或未锁定减少均失败）
//   node scripts/ui-guardrails-lint.mjs --write  锁定减少后的新基线（有新增时拒绝写入）
import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { nativeControlFindings } from "./design-system-rules.mjs";

const gui = fileURLToPath(new URL("../", import.meta.url));

export const GUARDRAIL_RULES = [
  {
    id: "spacing-literal",
    title: "间距魔法值禁令（padding / margin / gap）",
    why: "上层 UI 与组件样式的间距必须来自 tokens.json，避免出现 7px/13px 等散落魔法值。",
    fix: "改用 var(--spacing-*) 等语义间距 Token；缺 Token 时先在 packages/ui/tokens.json 新增并运行 generate。",
  },
  {
    id: "host-ui-class",
    title: "宿主禁穿透 @areal/ui 内部类名（.areal-*）",
    why: "组件边界由 @areal/ui 拥有，页面 CSS 选中组件内部 .areal-* 类会破坏主题与后续升级。",
    fix: "把外观差异做成 @areal/ui 的 variant、slot 或 Token，页面 CSS 只负责外层布局。",
  },
  {
    id: "native-control",
    title: "上层业务禁写裸原生控件（button / input / select / textarea）",
    why: "裸 HTML 控件绕开共享组件，会丢失焦点环、键盘语义、主题 Token 与禁用态一致性。",
    fix: "复用 @areal/ui 的 Button / Input / Select / Textarea 等共享控件；缺形态先补组件 variant。",
  },
];

const RULE_KEYS = GUARDRAIL_RULES.map((rule) => rule.id);
const SPACING_PROP =
  /^(?:padding|margin)(?:-(?:top|right|bottom|left|inline|block)(?:-(?:start|end))?)?$|^(?:row-|column-)?gap$/i;
const NON_ZERO_LENGTH = /(?<![\w.-])-?(?!0(?:\.0+)?(?:px|rem|em)\b)\d*\.?\d+(?:px|rem|em)\b/i;

function stripCssComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
}

/** 扫描单个 CSS 文件中 padding/margin/gap 的非 0 长度字面量。 */
export function spacingLiteralFindings(css) {
  const source = stripCssComments(css);
  const findings = [];
  for (const match of source.matchAll(/(?<=[{;])\s*([\w-]+)\s*:\s*([^;{}]+)(?=[;}])/g)) {
    const property = match[1].trim();
    const value = match[2].trim();
    if (SPACING_PROP.test(property) && NON_ZERO_LENGTH.test(value)) {
      findings.push(`spacing literal: ${property}: ${value}`);
    }
  }
  return findings;
}

/** 从 @areal/ui 的组件 CSS 中提取由组件库拥有的 .areal-* 类名。 */
export function extractUiOwnedClasses(css) {
  const source = stripCssComments(css);
  const classes = new Set();
  for (const match of source.matchAll(/\.(areal-[\w-]+)/g)) {
    classes.add(`.${match[1]}`);
  }
  return classes;
}

/** 扫描宿主 CSS 中命中 @areal/ui 内部 .areal-* 类名的选择器。 */
export function hostUiClassFindings(css, uiOwnedClasses) {
  const source = stripCssComments(css);
  const findings = [];
  for (const match of source.matchAll(/([^{}]+)\{/g)) {
    const selector = match[1].trim();
    if (!selector || selector.startsWith("@")) continue;
    const matched = [...selector.matchAll(/\.(areal-[\w-]+)/g)]
      .map((item) => `.${item[1]}`)
      .filter((name) => uiOwnedClasses.has(name));
    if (matched.length > 0) {
      findings.push(
        `host overrides @areal/ui class (${[...new Set(matched)].join(", ")}): ${selector.replace(/\s+/g, " ")}`,
      );
    }
  }
  return findings;
}

async function listFiles(dir, predicate) {
  const entries = await readdir(dir, { recursive: true });
  return entries
    .map((entry) => entry.replaceAll("\\", "/"))
    .filter(predicate)
    .sort();
}

export async function collectUiOwnedClasses(root = gui) {
  const uiDir = resolve(root, "packages/ui/src");
  const files = await listFiles(
    uiDir,
    (file) => file.endsWith(".css") && !file.startsWith("generated/"),
  );
  const owned = new Set();
  for (const file of files) {
    const source = await readFile(resolve(uiDir, file), "utf8");
    for (const className of extractUiOwnedClasses(source)) owned.add(className);
  }
  return owned;
}

export async function collectGuardrailCounts(root = gui) {
  const files = {};
  const bump = (relPath, ruleId, count) => {
    if (count <= 0) return;
    files[relPath] ??= {};
    files[relPath][ruleId] = (files[relPath][ruleId] ?? 0) + count;
  };

  const uiOwnedClasses = await collectUiOwnedClasses(root);

  const rendererDir = resolve(root, "renderer/src");
  const uiDir = resolve(root, "packages/ui/src");

  const rendererCss = await listFiles(
    rendererDir,
    (file) => file.endsWith(".css") && !file.startsWith("design-system/"),
  );
  for (const file of rendererCss) {
    const source = await readFile(resolve(rendererDir, file), "utf8");
    const rel = `renderer/src/${file}`;
    bump(rel, "spacing-literal", spacingLiteralFindings(source).length);
    bump(rel, "host-ui-class", hostUiClassFindings(source, uiOwnedClasses).length);
  }

  const uiCss = await listFiles(
    uiDir,
    (file) => file.endsWith(".css") && !file.startsWith("generated/"),
  );
  for (const file of uiCss) {
    const source = await readFile(resolve(uiDir, file), "utf8");
    const rel = `packages/ui/src/${file}`;
    bump(rel, "spacing-literal", spacingLiteralFindings(source).length);
  }

  const rendererTsx = await listFiles(
    rendererDir,
    (file) =>
      /\.(?:tsx|jsx)$/.test(file) &&
      !file.startsWith("design-system/") &&
      !file.startsWith("components/ui/") &&
      !file.includes(".test.") &&
      !file.includes(".spec."),
  );
  for (const file of rendererTsx) {
    const source = await readFile(resolve(rendererDir, file), "utf8");
    const rel = `renderer/src/${file}`;
    bump(rel, "native-control", nativeControlFindings(source).length);
  }

  const sortedFiles = Object.fromEntries(
    Object.keys(files)
      .sort()
      .map((key) => [key, files[key]]),
  );
  return {
    total: summarizeTotals(sortedFiles),
    files: sortedFiles,
    uiOwnedClassCount: uiOwnedClasses.size,
  };
}

export function summarizeTotals(files) {
  const total = Object.fromEntries(RULE_KEYS.map((key) => [key, 0]));
  for (const row of Object.values(files)) {
    for (const key of RULE_KEYS) {
      total[key] += row[key] || 0;
    }
  }
  return total;
}

export function compareGuardrailCounts(actualFiles, baselineFiles) {
  const increased = [];
  const decreased = [];
  const allFiles = [
    ...new Set([...Object.keys(baselineFiles), ...Object.keys(actualFiles)]),
  ].sort();
  for (const file of allFiles) {
    for (const key of RULE_KEYS) {
      const before = baselineFiles[file]?.[key] || 0;
      const after = actualFiles[file]?.[key] || 0;
      if (after > before) increased.push({ file, rule: key, before, after });
      if (after < before) decreased.push({ file, rule: key, before, after });
    }
  }
  return { increased, decreased };
}

function formatDiff(items) {
  const byId = new Map(GUARDRAIL_RULES.map((rule) => [rule.id, rule]));
  return items
    .map((item) => {
      const meta = byId.get(item.rule);
      return `- ${item.file} [${item.rule}]: ${item.before} → ${item.after}（${meta?.fix ?? ""}）`;
    })
    .join("\n");
}

export async function verifyUiGuardrails({ root = gui, write = false } = {}) {
  const targetBaseline = resolve(root, "design-system/ui-guardrails-baseline.json");
  const current = await collectGuardrailCounts(root);
  const previous = await readFile(targetBaseline, "utf8").then(JSON.parse, (error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });

  if (write) {
    if (previous) {
      const { increased } = compareGuardrailCounts(current.files, previous.files ?? {});
      assert.deepEqual(
        increased,
        [],
        `--write 只能锁定已减少的基线，请先修复新增违规：\n${formatDiff(increased)}`,
      );
    }
    const payload = {
      $description:
        "上层 UI 硬护栏存量棘轮（只减不增），由 scripts/ui-guardrails-lint.mjs --write 生成。涵盖 spacing-literal / host-ui-class / native-control。",
      rules: GUARDRAIL_RULES.map(({ id, title }) => ({ id, title })),
      total: current.total,
      files: current.files,
    };
    await writeFile(targetBaseline, `${JSON.stringify(payload, null, 2)}\n`);
    return { written: true, total: current.total, uiOwnedClassCount: current.uiOwnedClassCount };
  }

  assert.ok(
    previous,
    "缺少 design-system/ui-guardrails-baseline.json，请运行 node scripts/ui-guardrails-lint.mjs --write 初始化",
  );
  const { increased, decreased } = compareGuardrailCounts(current.files, previous.files ?? {});
  assert.deepEqual(
    increased,
    [],
    `新增上层 UI 护栏违规（请改用 Token / @areal/ui 组件）：\n${formatDiff(increased)}`,
  );
  assert.deepEqual(
    decreased,
    [],
    `上层 UI 存量债已减少，请运行 node scripts/ui-guardrails-lint.mjs --write 锁定更低上限：\n${formatDiff(decreased)}`,
  );
  return { passed: true, total: current.total, uiOwnedClassCount: current.uiOwnedClassCount };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(
    JSON.stringify(await verifyUiGuardrails({ write: process.argv.includes("--write") })),
  );
}
