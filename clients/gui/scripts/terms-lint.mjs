import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 同一个东西只用一个名字：界面文案里出现弃用的叫法即失败。新增一条前先和产品确认用哪个词。
const gui = fileURLToPath(new URL("../", import.meta.url));
const MESSAGES = "renderer/src/i18n/messages";
export const TERMS = [
  { use: "定时任务", avoid: ["自动化", "定时安排"] },
  { use: "工作树", avoid: ["Worktree"] },
  { use: "侧边聊天", avoid: ["旁路"] },
  { use: "子代理", avoid: ["子智能体"] },
  { use: "Bot", avoid: ["Personal Agent", "私人助理"] },
  { use: "Skills", avoid: ["技能"] },
  { use: "…", avoid: ["..."] },
  { use: "“”", avoid: ["「", "」"] },
];
export const EN_TERMS = [
  { use: "Canceled", avoid: ["Cancelled", "cancelled"] },
  { use: "Canceling", avoid: ["Cancelling", "cancelling"] },
];
// 搜索关键词保留旧叫法，方便按旧名找到设置。
const ALIASES = /^settings\.search\./;

/** 从消息目录源码里取出每条中文文案。 */
export function chineseMessages(source) {
  return [...source.matchAll(/"([\w.-]+)"\s*:\s*\{\s*"zh-CN"\s*:\s*("(?:[^"\\]|\\.)*")/g)].map(
    (match) => ({ id: match[1], text: JSON.parse(match[2]), index: match.index }),
  );
}

/** 从消息目录源码里取出每条英文文案。 */
export function englishMessages(source) {
  return [
    ...source.matchAll(
      /"([\w.-]+)"\s*:\s*\{\s*"zh-CN"\s*:\s*"(?:[^"\\]|\\.)*"\s*,\s*(?:"en"|en)\s*:\s*("(?:[^"\\]|\\.)*")/g,
    ),
  ].map((match) => ({ id: match[1], text: JSON.parse(match[2]), index: match.index }));
}

export function lintTerms(path, source, terms = TERMS, enTerms = EN_TERMS) {
  const problems = [];
  for (const message of chineseMessages(source).filter((item) => !ALIASES.test(item.id)))
    for (const term of terms)
      for (const word of term.avoid)
        if (message.text.includes(word))
          problems.push({
            where: `${path}:${source.slice(0, message.index).split("\n").length}`,
            problem: `“${word}”改用“${term.use}”`,
            text: message.text,
          });
  for (const message of englishMessages(source).filter((item) => !ALIASES.test(item.id)))
    for (const term of enTerms)
      for (const word of term.avoid)
        if (new RegExp(`\\b${word}\\b`).test(message.text))
          problems.push({
            where: `${path}:${source.slice(0, message.index).split("\n").length}`,
            problem: `“${word}”改用美式拼写“${term.use}”`,
            text: message.text,
          });
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = [];
  for (const file of (await readdir(resolve(gui, MESSAGES))).sort())
    if (file.endsWith(".ts"))
      problems.push(
        ...lintTerms(`${MESSAGES}/${file}`, await readFile(resolve(gui, MESSAGES, file), "utf8")),
      );
  for (const item of problems) console.error(`${item.where}: ${item.problem}\n  ${item.text}`);
  if (problems.length) {
    console.error(`terms: ${problems.length} messages use a retired name.`);
    process.exit(1);
  }
  console.log(`terms: ${TERMS.length} terms consistent across the message catalog.`);
}
