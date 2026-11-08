import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 同一个东西只用一个名字：界面文案里出现弃用的叫法即失败。新增一条前先和产品确认用哪个词。
const gui = fileURLToPath(new URL("../", import.meta.url));
const MESSAGES = "renderer/src/i18n/messages";
export const TERMS = [{ use: "定时任务", avoid: ["自动化"] }];

/** 从消息目录源码里取出每条中文文案。 */
export function chineseMessages(source) {
  return [...source.matchAll(/"([\w.-]+)"\s*:\s*\{\s*"zh-CN"\s*:\s*("(?:[^"\\]|\\.)*")/g)].map(
    (match) => ({ id: match[1], text: JSON.parse(match[2]), index: match.index }),
  );
}

export function lintTerms(path, source, terms = TERMS) {
  const problems = [];
  for (const message of chineseMessages(source))
    for (const term of terms)
      for (const word of term.avoid)
        if (message.text.includes(word))
          problems.push({
            where: `${path}:${source.slice(0, message.index).split("\n").length}`,
            problem: `“${word}”改用“${term.use}”`,
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
