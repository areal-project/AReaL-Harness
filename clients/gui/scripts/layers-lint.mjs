import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// R-CHECK-024（D-005）：五个机制中可以静态检查的四个。存量写进基线，只减不增；见 design/spec/README.md#检查。
const gui = fileURLToPath(new URL("../", import.meta.url));
const repository = resolve(gui, "../..");
const baselinePath = resolve(gui, "design-system/layers-baseline.json");
const CSS_ROOTS = ["renderer/src", "packages/ui/src"];
const SKIP = /(?:^|\/)(?:node_modules|dist|generated|vendor|design-system)\//;

// 原料层：只有生成器能用，组件和页面引用用途名。
const PRIMITIVE = /var\(\s*--(radius-(?:2xs|xs|sm|md|lg|xl|2xl|3xl|4xl))\s*[,)]/g;
// 材质：模糊只在材质定义里出现，其余地方只能引用材质变量。
const MATERIAL_FILES = new Set(["packages/ui/src/materials.css"]);
const BACKDROP = /backdrop-filter\s*:\s*([^;{}]+)/g;
const VAR_FALLBACK = /var\(\s*--([\w-]+)\s*,/g;
const CLASS = /\.(-?[_a-zA-Z][\w-]*)/g;
// 主题开关与原子工具类不属于任何组件。
const NOT_COMPONENT = /^(?:dark|light|relative|absolute|hidden|flex|grid|block|sr-only)$/;
const SPEC_NUMBER =
  /(?<![\w.-])\d*\.?\d+(?:px|ms|s|rem|em|dvh|svh|vh|%)(?![\w-])|#[0-9a-fA-F]{3,8}\b/g;
const SPEC_WORDS =
  /\b(?:React|Lexical|Electron|Tailwind|Core|Host|renderer|packages\/|tokens\.json|\w+\.(?:tsx?|css|mjs))\b/g;

// 前景色手调的半透明底：悬停、选中、分隔线各有用途变量，手调的深浅会和它们对不上。
const TINT =
  /color-mix\(\s*in\s+[\w-]+\s*,\s*var\(--color-foreground\)\s*[\d.]+%\s*,\s*transparent\s*\)/g;
// 选中、当前项的底色只能取选中类用途变量，保证选中永远不比悬停淡。
const SELECTED_STATE =
  /\[(?:aria-selected|aria-current|data-selected|data-current)(?:="?(?:true|page)"?)?\]/;
const SELECTED_TOKEN = /^var\(--color-(?:[\w-]*selected[\w-]*|sidebar-item|accent)\)$/;

// 外观属性：页面只能决定组件放在哪、多大，不能改它长什么样（D-005 外观走变体）。
const APPEARANCE =
  /(?:^|;)\s*(?:color|background[\w-]*|border[\w-]*|outline[\w-]*|box-shadow|font[\w-]*|line-height|letter-spacing|text-[\w-]+|opacity|filter|backdrop-filter|padding[\w-]*|fill|stroke)\s*:/;
/** 选择器真正作用的元素：最后一段复合选择器，去掉 :not()/:has() 里的条件。 */
const subject = (selector) =>
  selector
    .split(",")
    .map((part) => {
      let text = part;
      while (/:(?:not|has)\([^()]*\)/.test(text))
        text = text.replace(/:(?:not|has)\([^()]*\)/g, "");
      return text
        .trim()
        .split(/\s*[\s>+~]\s*/)
        .pop();
    })
    .join(" ");
const lineOf = (source, index) => source.slice(0, index).split("\n").length;
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));

/** 生成的 Token CSS 里定义过的变量；对它们写回退值永远不会生效。 */
export function definedTokens(generatedCss) {
  return new Set([...generatedCss.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1].slice(2)));
}

/** 组件库样式里出现、且组件自己渲染出来的类名，视为组件的外观边界。 */
export function componentClasses(css, rendered) {
  const classes = new Set();
  for (const block of stripComments(css).matchAll(/([^{}]+)\{/g)) {
    if (block[1].trim().startsWith("@")) continue;
    for (const match of block[1].matchAll(CLASS))
      if (
        !NOT_COMPONENT.test(match[1]) &&
        new RegExp(`(?<![\\w-])${match[1]}(?![\\w-])`).test(rendered)
      )
        classes.add(match[1]);
  }
  return classes;
}

export function lintCss(path, source, { tokens, classes, isPackage }) {
  const text = stripComments(source);
  const findings = [];
  const push = (kind, index, snippet) =>
    findings.push({
      file: path,
      kind,
      line: lineOf(text, index),
      snippet: snippet.replace(/\s+/g, " ").trim(),
    });
  for (const match of text.matchAll(PRIMITIVE)) push("primitive", match.index, match[0]);
  for (const match of text.matchAll(TINT)) push("tint", match.index, match[0]);
  for (const block of text.matchAll(/([^{}]+)\{([^{}]*)\}?/g)) {
    if (!SELECTED_STATE.test(block[1])) continue;
    for (const declaration of (block[2] ?? "").matchAll(
      /(?:^|;)\s*background(?:-color)?\s*:\s*([^;]+)/g,
    ))
      if (
        !SELECTED_TOKEN.test(declaration[1].replace(/!important/, "").trim()) &&
        !/^(?:transparent|none|inherit)$/.test(declaration[1].trim())
      )
        push("selected", block.index + block[0].indexOf("{") + declaration.index, declaration[0]);
  }
  for (const match of text.matchAll(BACKDROP))
    if (!/^\s*(?:none|var\(--material-[\w-]+\))\s*$/.test(match[1]) && !MATERIAL_FILES.has(path))
      push("material", match.index, match[0]);
  if (isPackage)
    for (const match of text.matchAll(VAR_FALLBACK))
      if (tokens.has(match[1])) push("fallback", match.index, match[0]);
  if (!isPackage)
    for (const block of text.matchAll(/([^{}]+)\{([^{}]*)\}?/g)) {
      const selector = block[1].trim();
      if (selector.startsWith("@") || /^(?:from|to|\d+%)/.test(selector)) continue;
      if (!APPEARANCE.test(block[2] ?? "")) continue;
      for (const match of subject(selector).matchAll(CLASS))
        if (classes.has(match[1])) {
          push(
            "restyle",
            block.index + block[0].indexOf(selector),
            `.${match[1]} in ${selector.split("\n").pop()}`,
          );
          break;
        }
    }
  return findings;
}

export function lintSpec(path, source) {
  const findings = [];
  for (const [index, line] of source.split("\n").entries()) {
    const content = line.replace(/^\s*#.*$/, "");
    for (const match of content.matchAll(SPEC_NUMBER))
      findings.push({ file: path, kind: "spec-number", line: index + 1, snippet: match[0] });
    for (const match of content.matchAll(SPEC_WORDS))
      findings.push({ file: path, kind: "spec-word", line: index + 1, snippet: match[0] });
  }
  return findings;
}

export function fingerprint(findings) {
  const seen = new Map();
  return findings.map((finding) => {
    const identity = `${finding.file}\0${finding.kind}\0${finding.snippet}`;
    const occurrence = (seen.get(identity) ?? 0) + 1;
    seen.set(identity, occurrence);
    return {
      ...finding,
      fingerprint: createHash("sha256").update(identity).update(String(occurrence)).digest("hex"),
    };
  });
}

async function files(root, base, extension) {
  return (await readdir(resolve(root, base), { recursive: true }))
    .map((file) => `${base}/${file}`.replaceAll("\\", "/"))
    .filter((path) => path.endsWith(extension) && !SKIP.test(`${path}`))
    .sort();
}

export async function collectLayersLint({
  root = gui,
  specRoot = resolve(repository, "design/spec"),
} = {}) {
  const generated = await readdir(resolve(root, "packages/ui/src/generated"));
  let generatedCss = "";
  for (const name of generated.filter((name) => name.endsWith(".css")))
    generatedCss += await readFile(resolve(root, "packages/ui/src/generated", name), "utf8");
  const tokens = definedTokens(generatedCss);
  let rendered = "";
  for (const path of await files(root, "packages/ui/src", ".tsx"))
    rendered += await readFile(resolve(root, path), "utf8");
  const classes = new Set();
  for (const path of await files(root, "packages/ui/src", ".css"))
    for (const name of componentClasses(await readFile(resolve(root, path), "utf8"), rendered))
      classes.add(name);
  const findings = [];
  for (const base of CSS_ROOTS)
    for (const path of await files(root, base, ".css"))
      findings.push(
        ...lintCss(path, await readFile(resolve(root, path), "utf8"), {
          tokens,
          classes,
          isPackage: path.startsWith("packages/"),
        }),
      );
  for (const path of await files(specRoot, ".", ".yaml"))
    findings.push(
      ...lintSpec(`design/spec/${path.slice(2)}`, await readFile(resolve(specRoot, path), "utf8")),
    );
  return fingerprint(findings);
}

export function compareLayers(findings, baseline) {
  const admitted = new Set(baseline.map((entry) => entry.fingerprint));
  const current = new Set(findings.map((entry) => entry.fingerprint));
  return {
    added: findings.filter((finding) => !admitted.has(finding.fingerprint)),
    fixed: baseline.filter((entry) => !current.has(entry.fingerprint)),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const findings = await collectLayersLint();
  const record = ({ file, kind, snippet, fingerprint }) => ({ file, kind, snippet, fingerprint });
  if (process.argv.includes("--write")) {
    const baseline = JSON.parse(await readFile(baselinePath, "utf8").catch(() => "[]"));
    const { added } = compareLayers(findings, baseline);
    if (added.length && !process.argv.includes("--admit")) {
      for (const item of added)
        console.error(`${item.file}:${item.line} ${item.kind} ${item.snippet}`);
      console.error(
        `layers: --write only removes fixed entries; ${added.length} new findings need a fix.`,
      );
      process.exit(1);
    }
    await writeFile(baselinePath, `${JSON.stringify(findings.map(record), null, 2)}\n`);
    console.log(`layers: baseline holds ${findings.length} findings.`);
  } else {
    const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
    const { added, fixed } = compareLayers(findings, baseline);
    for (const item of added)
      console.error(`${item.file}:${item.line} ${item.kind} ${item.snippet}`);
    if (added.length) {
      console.error(
        `layers: ${added.length} new findings. Use purpose tokens, material definitions or component variants; see design/spec/README.md#检查.`,
      );
      process.exit(1);
    }
    if (fixed.length)
      console.log(
        `layers: ${fixed.length} baseline entries are fixed; run with --write to shrink it.`,
      );
    const counts = Object.groupBy(findings, (item) => item.kind);
    console.log(
      `layers: no new findings (${Object.entries(counts)
        .map(([kind, items]) => `${kind} ${items.length}`)
        .join(", ")}).`,
    );
  }
}
