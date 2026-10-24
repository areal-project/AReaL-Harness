import { createRequire } from "node:module";

const require = createRequire(new URL("../renderer/package.json", import.meta.url));
const ts = require("typescript");

const rawColor = /#[\da-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i;
const literalSize = /\b\d+(?:\.\d+)?(?:px|rem|em)\b/;
function declarationFindings(property, value, allowTokenDefinitions = true) {
  const out = [];
  if ((property === "font-size" || property === "font") && literalSize.test(value)) out.push(`literal typography: ${property}: ${value}`);
  if ((!property.startsWith("--") || !allowTokenDefinitions) && rawColor.test(value)) out.push(`literal color: ${property}: ${value}`);
  if (["color", "background", "background-color", "border-color"].includes(property) &&
    /^[a-z]+$/i.test(value.trim()) && !/^(inherit|initial|unset|revert|transparent|currentcolor|none)$/i.test(value.trim())) {
    out.push(`literal color: ${property}: ${value}`);
  }
  return out;
}
function cssFindings(css, allowTokenDefinitions = true) {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...source.matchAll(/(?<=[{;])\s*([\w-]+)\s*:\s*([^;{}]+)(?=[;}])/g)]
    .flatMap(([, property, value]) => declarationFindings(property, value, allowTokenDefinitions));
}
function classFindings(value) {
  return value.split(/\s+/).filter(Boolean).flatMap(token => {
    const utility = token.split(/:(?![^\[]*\])/).at(-1).replace(/^!/, "");
    if (/^text-(?:xs|sm|base|lg|xl|[2-9]xl)(?:\/.*)?$/.test(utility) ||
      /^text-\[(?:length:)?\d/.test(utility) || /^\[font-size:/.test(utility)) return [`literal typography class: ${token}`];
    if (/^(?:text|bg|border|ring|outline|divide|decoration|shadow|fill|stroke|from|via|to)(?:-[a-z]+)?-(?:(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}|black|white)(?:\/.*)?$/.test(utility) ||
      /^(?:text|bg|border|ring|outline|fill|stroke)-\[/.test(utility) && !utility.includes("var(--") && !utility.includes("--color-") ||
      /^\[(?:color|background(?:-color)?|border-color):/.test(utility) && !utility.includes("var(--")) return [`literal color class: ${token}`];
    return [];
  });
}
function tsxFindings(source, allowTokenDefinitions = true) {
  const tree = ts.createSourceFile("settings.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out = [];
  const strings = (node, visit) => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) visit(node.text);
    ts.forEachChild(node, child => strings(child, visit));
  };
  const scan = node => {
    if (ts.isJsxAttribute(node) && node.initializer) {
      if (node.name.text === "className") strings(node.initializer, value => out.push(...classFindings(value)));
      if (node.name.text === "style" && ts.isJsxExpression(node.initializer) && node.initializer.expression && ts.isObjectLiteralExpression(node.initializer.expression)) {
        for (const property of node.initializer.expression.properties) {
          if (!ts.isPropertyAssignment(property)) continue;
          const name = property.name.getText(tree).replace(/^["']|["']$/g, "").replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
          if (ts.isNumericLiteral(property.initializer) && ["font-size", "font"].includes(name)) out.push(`literal typography style: ${name}: ${property.initializer.text}`);
          strings(property.initializer, value => out.push(...declarationFindings(name, value, allowTokenDefinitions)));
        }
      }
    }
    ts.forEachChild(node, scan);
  };
  scan(tree);
  return out;
}


export function nativeControlFindings(source) {
  const tree = ts.createSourceFile("surface.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out = [];
  const scan = node => {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      ts.isIdentifier(node.tagName) && ["button", "input", "select", "textarea"].includes(node.tagName.text)) {
      out.push(`native control: <${node.tagName.text}>; use the existing shared control or add a shared variant`);
    }
    ts.forEachChild(node, scan);
  };
  scan(tree);
  return out;
}

// 圆角字面量只进入存量基线，不作为增量硬错误：组件局部几何允许存在，但数量只能减少。
// 0、百分比和 var() 不计入。
function radiusFindings(css) {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...source.matchAll(/(?<=[{;])\s*(border(?:-(?:top|bottom|start|end)-(?:left|right|start|end))?-radius)\s*:\s*([^;{}]+)(?=[;}])/g)]
    .filter(([, , value]) => !value.includes("var(--") && /(?:^|[\s(,])(?!0(?:px)?\b)\d+(?:\.\d+)?px\b/.test(value))
    .map(([, property, value]) => `literal radius: ${property}: ${value.trim()}`);
}

export { cssFindings, tsxFindings, radiusFindings };
