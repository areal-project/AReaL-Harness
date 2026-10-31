import { readFile, readdir } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

// R-CHECK-020：界面说明每条至多 30 个汉字，确认类至多 50 个；超出的先删实现机制，再考虑帮助文档链接。
const gui = fileURLToPath(new URL("../", import.meta.url));
export const COPY_LIMIT = 30;
export const CONFIRM_LIMIT = 50;
const han = /\p{Script=Han}/gu;

/** 计数只看汉字：ICU 参数、英文名词和标点不计入。 */
export function copyLength(text) {
  return text.replace(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g, "").match(han)?.length ?? 0;
}
export const copyLimit = (key) => (/confirm/i.test(key) ? CONFIRM_LIMIT : COPY_LIMIT);

function messageEntries(path, source) {
  return [...source.matchAll(/"([\w.-]+)":\s*\{\s*"zh-CN":\s*"((?:[^"\\]|\\.)*)"/g)].map(
    ([, key, text]) => ({ where: `${path}#${key}`, key, text }),
  );
}
// JSX 文本与字符串字面量：绕过 i18n 的中文同样受预算约束。
function literalEntries(path, source) {
  const entries = [];
  for (const match of source.matchAll(/>([^<>{}]+)<|"([^"\n]*)"|`([^`\n]*)`/g)) {
    const text = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    // 含 \n 的模板是交给模型的证据文本，不是界面文案。
    if (!han.test(text) || text.includes("\\n")) continue;
    han.lastIndex = 0;
    const line = source.slice(0, match.index).split("\n").length;
    entries.push({ where: `${path}:${line}`, key: text, text });
  }
  return entries;
}

export async function collectCopyBudget({ root = gui } = {}) {
  const messages = resolve(root, "renderer/src/i18n/messages");
  const entries = [];
  for (const file of (await readdir(messages)).filter((name) => name.endsWith(".ts")).sort()) {
    const path = resolve(messages, file);
    entries.push(...messageEntries(relative(root, path), await readFile(path, "utf8")));
  }
  const renderer = resolve(root, "renderer/src");
  for (const file of (await readdir(renderer, { recursive: true })).sort()) {
    if (!file.endsWith(".tsx") || /(?:^|\/)design-system\/|\.test\./.test(file)) continue;
    const path = resolve(renderer, file);
    entries.push(...literalEntries(relative(root, path), await readFile(path, "utf8")));
  }
  return entries
    .map((entry) => ({ ...entry, length: copyLength(entry.text), limit: copyLimit(entry.key) }))
    .filter((entry) => entry.length > entry.limit);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const over = await collectCopyBudget();
  for (const entry of over)
    console.error(`${entry.where}: ${entry.length}/${entry.limit} ${entry.text.slice(0, 60)}`);
  if (over.length) {
    console.error(`R-CHECK-020: ${over.length} copy strings exceed the budget.`);
    process.exit(1);
  }
  console.log("R-CHECK-020: all interface copy is within budget.");
}
