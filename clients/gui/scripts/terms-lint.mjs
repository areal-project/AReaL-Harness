import { readFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 同一个东西只用一个名字，并执行 DESIGN.md 的 UX Writing 铁律：
// 词典真源位于 design-system/terminology.json，新增一条前先与产品确认标准词。
const gui = fileURLToPath(new URL("../", import.meta.url));
const MESSAGES = "renderer/src/i18n/messages";
const terminology = JSON.parse(
  readFileSync(resolve(gui, "design-system/terminology.json"), "utf8"),
);
export const TERMS = terminology.terms;
export const EN_TERMS = terminology.enTerms;
export const UX_COPY_BANS = terminology.uxCopyBans;
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

export function lintTerms(
  path,
  source,
  terms = TERMS,
  enTerms = EN_TERMS,
  uxCopyBans = UX_COPY_BANS,
) {
  const problems = [];
  for (const message of chineseMessages(source).filter((item) => !ALIASES.test(item.id))) {
    const line = source.slice(0, message.index).split("\n").length;
    for (const term of terms) {
      for (const word of term.avoid ?? [])
        if (message.text.includes(word))
          problems.push({
            where: `${path}:${line}`,
            problem: `“${word}”改用“${term.use}”`,
            text: message.text,
          });
      for (const word of term.avoidWord ?? [])
        if (new RegExp(`\\b${word}\\b`).test(message.text))
          problems.push({
            where: `${path}:${line}`,
            problem: `“${word}”改用“${term.use}”`,
            text: message.text,
          });
    }
    const trimmed = message.text.trim();
    for (const phrase of uxCopyBans?.filler?.phrases ?? [])
      if (trimmed.includes(phrase))
        problems.push({
          where: `${path}:${line}`,
          problem: `${uxCopyBans.filler.message}（命中“${phrase}”）`,
          text: message.text,
        });
    if ((uxCopyBans?.bareEmptyState?.exact ?? []).includes(trimmed))
      problems.push({
        where: `${path}:${line}`,
        problem: uxCopyBans.bareEmptyState.message,
        text: message.text,
      });
    if ((uxCopyBans?.genericConfirm?.exact ?? []).includes(trimmed))
      problems.push({
        where: `${path}:${line}`,
        problem: uxCopyBans.genericConfirm.message,
        text: message.text,
      });
  }
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
    console.error(`terms: ${problems.length} messages use a retired name or banned UX copy.`);
    process.exit(1);
  }
  console.log(
    `terms: ${TERMS.length} terms and UX Writing guardrails consistent across the message catalog.`,
  );
}
