import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// R-CHECK-021：过渡时长用 --motion-* token，常驻循环用 var(--motion-loop)，两种减少动效开关才都能停住。
const gui = fileURLToPath(new URL("../", import.meta.url));
const ROOTS = ["renderer/src", "packages"];
// gen-ui 的资源在沙箱 iframe 里运行，拿不到设计 token。
const SKIP = /(?:^|\/)(?:node_modules|dist|generated|vendor)\/|^packages\/gen-ui\/assets\//;
// 对话流的动效由对话流改造统一处理；迁移后从这里删除。
export const EXCEPTIONS = [
  { file: "renderer/src/workbench.css", match: "turn-thinking-shimmer" },
  { file: "renderer/src/workbench.css", match: "transform 300ms" },
  { file: "renderer/src/workbench.css", match: "height 300ms" },
  { file: "packages/ui/src/conversation/thinking-status/thinking-status.css", match: "infinite" },
];

const DECLARATION =
  /(?<![\w-])(transition|transition-duration|transition-property|animation|animation-iteration-count)\s*:\s*([^;{}]*)/g;
const LITERAL_DURATION = /(?<![\w.(-])(\d*\.?\d+)m?s\b/g;

/** 返回一条声明违反的规则；时长写在 var() 回退值里的不算。 */
export function motionProblem(property, value) {
  const bare = value.replace(/var\([^()]*(?:\([^()]*\)[^()]*)*\)/g, "var()");
  if (property.startsWith("transition")) {
    if (/(?:^|[\s,])all(?=$|[\s,])/.test(bare))
      return "transition all animates layout too; name the properties";
    if (property !== "transition-property")
      for (const [, number] of bare.matchAll(LITERAL_DURATION))
        if (Number(number) !== 0)
          return "use var(--motion-fast|normal|slow) instead of a literal duration";
    return null;
  }
  if (/\binfinite\b/.test(bare)) return "use var(--motion-loop) instead of infinite";
  return null;
}

export function lintCss(path, source) {
  const problems = [];
  for (const match of source.matchAll(DECLARATION)) {
    const [text, property, value] = match;
    const problem = motionProblem(property, value);
    if (!problem) continue;
    if (EXCEPTIONS.some((item) => item.file === path && text.includes(item.match))) continue;
    const line = source.slice(0, match.index).split("\n").length;
    problems.push({ where: `${path}:${line}`, problem, text: text.replace(/\s+/g, " ").trim() });
  }
  return problems;
}

export async function collectMotionLint({ root = gui } = {}) {
  const problems = [];
  for (const base of ROOTS) {
    for (const file of (await readdir(resolve(root, base), { recursive: true })).sort()) {
      const path = `${base}/${file}`.replaceAll("\\", "/");
      if (!path.endsWith(".css") || SKIP.test(path)) continue;
      problems.push(...lintCss(path, await readFile(resolve(root, path), "utf8")));
    }
  }
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = await collectMotionLint();
  for (const item of problems) console.error(`${item.where}: ${item.problem}\n  ${item.text}`);
  if (problems.length) {
    console.error(`R-CHECK-021: ${problems.length} motion declarations bypass the motion tokens.`);
    process.exit(1);
  }
  console.log("R-CHECK-021: all transitions and loops follow the motion tokens.");
}
