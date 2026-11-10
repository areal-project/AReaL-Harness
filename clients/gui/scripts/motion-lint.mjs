import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// R-CHECK-021：时长用 --motion-* token、曲线用 --ease-* token、常驻循环用 var(--motion-loop)，减少动效时才能全部归零。
const gui = fileURLToPath(new URL("../", import.meta.url));
const ROOTS = ["renderer/src", "packages"];
// gen-ui 的资源在沙箱 iframe 里运行，拿不到设计 token。
const SKIP = /(?:^|\/)(?:node_modules|dist|generated|vendor)\/|^packages\/gen-ui\/assets\//;
const DECLARATION =
  /(?<![\w-])(transition|transition-duration|transition-property|transition-timing-function|animation|animation-duration|animation-iteration-count|animation-timing-function)\s*:\s*([^;{}]*)/g;
const LITERAL_EASING =
  /(?<![\w-])(?:(?:ease|ease-in|ease-out|ease-in-out)(?![\w-])|cubic-bezier\()/;
const LITERAL_DURATION = /(?<![\w.(-])(\d*\.?\d+)m?s\b/g;

/** 返回一条声明违反的规则；时长写在 var() 回退值里的不算。 */
export function motionProblem(property, value) {
  const bare = value.replace(/var\([^()]*(?:\([^()]*\)[^()]*)*\)/g, "var()");
  if (property.startsWith("transition") && /(?:^|[\s,])all(?=$|[\s,])/.test(bare))
    return "transition all animates layout too; name the properties";
  if (property.endsWith("-property") || property.endsWith("-iteration-count")) {
    if (/\binfinite\b/.test(bare)) return "use var(--motion-loop) instead of infinite";
    return null;
  }
  for (const [, number] of bare.matchAll(LITERAL_DURATION))
    if (Number(number) !== 0) return "use a var(--motion-*) duration instead of a literal one";
  if (LITERAL_EASING.test(bare)) return "use a var(--ease-*) curve instead of a literal easing";
  if (/\binfinite\b/.test(bare)) return "use var(--motion-loop) instead of infinite";
  return null;
}

const UTILITY = /(?<![\w-])(?:duration-\d+|ease-(?:in|out|in-out)|animate-\[[^\]]*\])(?![\w-])/g;

/** 组件里的 Tailwind 动效类同样要走变量：duration-(--motion-*)、ease-(--ease-*)。 */
export function lintSource(path, source) {
  const problems = [];
  for (const match of source.matchAll(UTILITY)) {
    if (match[0] === "duration-0") continue;
    const line = source.slice(0, match.index).split("\n").length;
    problems.push({
      where: `${path}:${line}`,
      problem: "use duration-(--motion-*) / ease-(--ease-*) instead of a literal motion utility",
      text: match[0],
    });
  }
  return problems;
}

export function lintCss(path, source) {
  const problems = [];
  for (const match of source.matchAll(DECLARATION)) {
    const [text, property, value] = match;
    const problem = motionProblem(property, value);
    if (!problem) continue;
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
      if (SKIP.test(path)) continue;
      if (path.endsWith(".css"))
        problems.push(...lintCss(path, await readFile(resolve(root, path), "utf8")));
      else if (/\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path))
        problems.push(...lintSource(path, await readFile(resolve(root, path), "utf8")));
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
