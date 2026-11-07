import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { renderPalette } from "./palette.mjs";

export const root = fileURLToPath(new URL("../", import.meta.url));
const extension = (token) => token.$extensions?.["build.areal.ui"] ?? {};
const banner =
  "/* Generated from @areal/ui/tokens.json. Run pnpm --dir clients/gui --filter @areal/ui generate. */\n";
const scalar = String;
function serialize(token, name) {
  const value = token.$value;
  if (extension(token).css) {
    assert.equal(typeof value, "string");
    return value;
  }
  if (token.$type === "number") {
    assert.equal(typeof value, "number");
    assert.ok(Number.isFinite(value));
    return scalar(value);
  }
  if (token.$type === "fontFamily") {
    assert.equal(typeof value, "string");
    return value;
  }
  if (["dimension", "duration"].includes(token.$type)) {
    assert.ok(value && typeof value === "object", `CSS expression needs extension: ${name}`);
    assert.ok(
      Number.isFinite(value.value) && ["px", "rem", "ms", "s"].includes(value.unit),
      `invalid value: ${name}`,
    );
    return `${scalar(value.value)}${value.unit}`;
  }
  assert.fail(`unsupported token type: ${name}`);
}
function hex(value) {
  assert.equal(value.colorSpace, "srgb");
  assert.equal(value.components.length, 3);
  return (
    "#" +
    value.components
      .map((number) => {
        assert.ok(Number.isFinite(number) && number >= 0 && number <= 1);
        return Math.round(number * 255)
          .toString(16)
          .padStart(2, "0");
      })
      .join("")
  );
}
function luminance(color) {
  const rgb = color
    .slice(1)
    .match(/../g)
    .map((value) => parseInt(value, 16) / 255)
    .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}
export function renderFoundations(tokens) {
  const seen = new Set(),
    definitions = [],
    mappings = [],
    dark = [];
  for (const [key, token] of Object.entries(tokens.foundation)) {
    const name = extension(token).name ?? key;
    assert.ok(/^[a-z][a-z0-9-]+$/.test(name), `invalid name: ${name}`);
    assert.ok(!seen.has(name), `duplicate CSS role: ${name}`);
    seen.add(name);
    assert.ok(token.$description?.trim(), `missing meaning: ${name}`);
    const line = `  --${name}: ${serialize(token, name)};`;
    definitions.push(line);
    if (extension(token).tailwind) mappings.push(line);
    if (extension(token).dark !== undefined)
      dark.push(`  --${name}: ${serialize({ ...token, $value: extension(token).dark }, name)};`);
  }
  const themes = Object.fromEntries(
    ["light", "dark"].map((mode) => {
      const input = Object.fromEntries(
        Object.entries(tokens.themes).map(([name, token]) => {
          const value = mode === "dark" ? (extension(token).dark ?? token.$value) : token.$value;
          return [name, token.$type === "color" ? hex(value) : value];
        }),
      );
      const a = luminance(input.foreground),
        b = luminance(input.background);
      assert.ok(
        (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) >= 4.5,
        `${mode} body contrast is below 4.5:1`,
      );
      return [mode, input];
    }),
  );
  const reducedMotion = Object.entries(tokens.foundation)
    .filter(([name]) => name.startsWith("motion-"))
    .map(([name, token]) => {
      const value = extension(token).reducedMotion ?? (token.$type === "duration" ? "0ms" : null);
      assert.ok(value !== null, `missing reduced motion value: ${name}`);
      return `--${extension(token).name ?? name}: ${value};`;
    })
    .join(" ");
  return {
    themes,
    foundation:
      banner +
      `:root {\n${definitions.join("\n")}\n}\n.dark {\n${dark.join("\n")}\n}\n` +
      `:root[data-reduced-motion="true"] { ${reducedMotion} }\n@media (prefers-reduced-motion: reduce) { :root:not([data-reduced-motion="false"]) { ${reducedMotion} } }\n`,
    tailwind: banner + `@theme {\n${mappings.join("\n")}\n}\n`,
  };
}
// 给使用者和 Agent 的速查表：从 tokens.json 与 theme.ts 生成，不手工维护数值。
export function renderTokenReference(tokens, themes, paletteVariables) {
  const groups = [
    ["字号", /^text-|^ui-font/],
    ["行高与字重", /^line-height|^ui-font-weight|^tracking/],
    ["间距与尺寸", /^spacing-|^reading-width/],
    ["圆角", /^radius-/],
    ["阴影", /^shadow-/],
    ["状态色与语义色", /^color-/],
    ["动效与层级", /^motion-|^ease-|^layer-/],
    ["其他", /./],
  ];
  const cell = (value) => String(value).replace(/\|/g, "\\|");
  const rows = Object.entries(tokens.foundation).map(([key, token]) => {
    const name = extension(token).name ?? key,
      dark = extension(token).dark;
    return {
      name,
      value:
        serialize(token, name) +
        (dark !== undefined ? `（暗色 ${serialize({ ...token, $value: dark }, name)}）` : ""),
      meaning: token.$description,
    };
  });
  const used = new Set();
  let out =
    "<!-- Generated from tokens.json and src/theme.ts. Run pnpm --dir clients/gui --filter @areal/ui generate. -->\n# @areal/ui Token 速查\n\n" +
    "写样式时按用途选这里的变量，不写字面量。数值与派生公式只在 [tokens.json](../../tokens.json) 修改；[theme.ts](../theme.ts) 保留公开调用与 WCAG 算法，[palette.ts](palette.ts) 是构建时生成的普通 TypeScript。\n";
  for (const [title, pattern] of groups) {
    const list = rows.filter((row) => !used.has(row.name) && pattern.test(row.name));
    if (!list.length) continue;
    list.forEach((row) => used.add(row.name));
    out +=
      `\n## ${title}\n\n| 变量 | 默认值 | 用途 |\n| --- | --- | --- |\n` +
      list
        .map((row) => `| \`--${row.name}\` | \`${cell(row.value)}\` | ${cell(row.meaning)} |`)
        .join("\n") +
      "\n";
  }
  const light = paletteVariables({ ...themes.light, translucentSidebar: true }, false),
    dark = paletteVariables({ ...themes.dark, translucentSidebar: true }, true);
  for (const name of Object.keys(light)) {
    assert.ok(
      tokens.palette?.roles[name]?.meaning && tokens.palette.roles[name].source,
      `missing palette metadata: ${name}`,
    );
    const alias = tokens.palette.roles[name].alias;
    if (alias) assert.ok(tokens.palette.roles[alias], `unknown palette alias: ${name} -> ${alias}`);
  }
  out +=
    `\n## 派生参数与来源\n\n公式限定为已有混色、透明材料、默认覆盖和阴影操作。生成时校验引用方向与循环，运行时不解释数据。来源未记录的旧参数明确保留旧实现证据，不补造截图编号。\`palette.source.preMigration\` 指向迁移前的纯函数及其哈希。\n\n${JSON.stringify(tokens.palette.source.preMigration)}\n\n| 参数 | 记录 |\n| --- | --- |\n` +
    Object.entries(tokens.palette.parameters)
      .map(([name, value]) => `| \`${name}\` | ${cell(JSON.stringify(value))} |`)
      .join("\n") +
    "\n";
  out +=
    "\n## 参考值与语义派生\n\n参考输入为 background、foreground、accent 和 contrast；透明侧栏偏好选择已有材料。引用只允许参考值进入语义层，组件只映射语义层。\n\n| 参考值 | 值 | 来源 |\n| --- | --- | --- |\n" +
    Object.entries(tokens.palette.references)
      .map(([name, entry]) => `| \`${name}\` | \`${cell(entry.value)}\` | ${cell(entry.source)} |`)
      .join("\n") +
    "\n\n| 语义角色 | 派生公式 | 默认主题覆盖 | 用途与来源 |\n| --- | --- | --- | --- |\n" +
    Object.entries(tokens.palette.semantic)
      .map(
        ([name, entry]) =>
          `| \`${name}\` | \`${cell(JSON.stringify(entry.value))}\` | \`${cell(JSON.stringify(entry.defaultOverrides ?? []))}\` | ${cell(entry.meaning)} ${cell(entry.source)} |`,
      )
      .join("\n") +
    "\n";
  out +=
    "\n## 调色板（由主题输入派生，用户可在外观设置中覆盖）\n\n| 变量 | 层与角色 | 语义引用与组件映射 | 默认亮色 | 默认暗色 |\n| --- | --- | --- | --- | --- |\n" +
    Object.keys(light)
      .map(
        (name) =>
          `| \`${name}\` | ${tokens.palette.roles[name].layer} · ${cell(tokens.palette.roles[name].meaning)} | ${cell(tokens.palette.roles[name].ref)} ${cell(tokens.palette.roles[name].mapping ?? "")} | \`${cell(light[name])}\` | \`${cell(dark[name])}\` |`,
      )
      .join("\n") +
    "\n";
  return out;
}
export async function writeOrCheck(path, output, check) {
  if (check)
    assert.equal(await readFile(path, "utf8"), output, `generated asset out of date: ${path}`);
  else {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, output);
  }
}
export function verifyThemeSource(source) {
  assert.ok(!/#[\da-f]{3,8}\b/i.test(source), "theme.ts color literal belongs in tokens.json");
  const tree = ts.createSourceFile("theme.ts", source, ts.ScriptTarget.Latest, true);
  // 仅允许十六进制解码、WCAG亮度与对比度算法、百分比混色与半点步进中的已知常量。
  const algorithmConstants = new Set([
    1, 2, 16, 100, 255, 0.04045, 12.92, 0.055, 1.055, 2.4, 0.2126, 0.7152, 0.0722, 0.05, 1.05,
  ]);
  const inspect = (node, algorithm) => {
    const insideAlgorithm = ts.isFunctionDeclaration(node)
      ? [
          "readableForeground",
          "relativeLuminance",
          "colorContrastRatio",
          "minimumPercent",
          "mixHex",
        ].includes(node.name?.text)
      : algorithm;
    if (ts.isNumericLiteral(node)) {
      assert.ok(insideAlgorithm, "theme.ts numeric parameter belongs in tokens.json");
      assert.ok(
        algorithmConstants.has(Number(node.text)),
        `undocumented color algorithm constant: ${node.text}`,
      );
    }
    ts.forEachChild(node, (child) => inspect(child, insideAlgorithm));
  };
  inspect(tree, false);
}
export async function loadPaletteVariables() {
  const [themeSource, paletteSource] = await Promise.all([
    readFile(resolve(root, "src/theme.ts"), "utf8"),
    readFile(resolve(root, "src/generated/palette.ts"), "utf8"),
  ]);
  verifyThemeSource(themeSource);
  const moduleURL = (source) => {
    const js = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    return `data:text/javascript;base64,${Buffer.from(js).toString("base64")}`;
  };
  const { paletteVariables } = await import(
    moduleURL(
      themeSource.replace('"./generated/palette.js"', JSON.stringify(moduleURL(paletteSource))),
    )
  );
  return paletteVariables;
}
export async function generateFoundations(check = false) {
  const tokens = JSON.parse(await readFile(resolve(root, "tokens.json"), "utf8"));
  const result = renderFoundations(tokens);
  await writeOrCheck(resolve(root, "src/generated/palette.ts"), renderPalette(tokens), check);
  const paletteVariables = await loadPaletteVariables();
  const defaultVariables = paletteVariables(
    { ...result.themes.light, translucentSidebar: true },
    false,
  );
  result.tailwind += `@theme {\n${Object.entries(defaultVariables)
    .filter(([name]) => /^--(?:color|shadow)-/.test(name))
    .map(([name, value]) => `  ${name}: ${value};`)
    .join("\n")}\n}\n`;
  const themeCSS =
    banner +
    Object.entries(result.themes)
      .map(
        ([mode, input]) =>
          `:root${mode === "dark" ? ".dark" : ", :root.light"} {\n${Object.entries(
            paletteVariables({ ...input, translucentSidebar: true }, mode === "dark"),
          )
            .map(([name, value]) => `  ${name}: ${value};`)
            .join("\n")}\n}`,
      )
      .join("\n") +
    "\n";
  for (const [name, output] of Object.entries({
    "foundation.css": result.foundation,
    "tailwind.css": result.tailwind,
    "themes.css": themeCSS,
    "tokens.md": renderTokenReference(tokens, result.themes, paletteVariables),
    "theme-defaults.ts":
      "// Generated from tokens.json.\nexport const DEFAULT_THEME_INPUTS = " +
      JSON.stringify(result.themes, null, 2) +
      " as const;\n",
  }))
    await writeOrCheck(resolve(root, "src/generated", name), output, check);
  return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await generateFoundations(process.argv.includes("--check"));
  console.log(
    JSON.stringify({ passed: true, mode: process.argv.includes("--check") ? "check" : "generate" }),
  );
}
