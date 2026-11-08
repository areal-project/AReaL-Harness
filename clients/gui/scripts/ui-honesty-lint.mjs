// 界面只说用户能认出的事：用户文案不外露内部用语和状态。存量写进基线，只减不增。
//   node scripts/ui-honesty-lint.mjs           检查：出现基线外的新问题就失败
//   node scripts/ui-honesty-lint.mjs --write   重写基线（只允许删掉已修好的条目）
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const baselinePath = resolve(root, "design-system/ui-honesty-baseline.json");
const han = /\p{Script=Han}/u;

// 实现层用词：用户不需要知道这些就能完成操作。诊断页和问题反馈的词条不受限。
export const INTERNAL_TERMS = [
  "Core",
  "Host",
  "Store",
  "revision",
  "generation",
  "快照",
  "受理",
  "回执",
  "实例",
  "观察",
  "核对",
];
const DIAGNOSTIC_KEYS =
  /^(?:settings\.diagnostics\.|bugReport\.|settings\.pluginCenter\.(?:snapshotScope|doctor|pluginDoctor|readDoctorReport))/;
// 用显示文字当编号：改名、改语言或改形态时会出现同一个东西两个编号。
const ID_CALLS =
  /\b(?:showPanel|selectPanel|onPanel|setPanel|retainSelectedTab|setSettingsTab|exposePanel)\(\s*["'`]([^"'`]*\p{Script=Han}[^"'`]*)["'`]/gu;
const ID_COMPARE = /[!=]==\s*["']([^"']*\p{Script=Han}[^"']*)["']/gu;
const LOCALE_DATE = /\.(?:toLocaleString|toLocaleDateString|toLocaleTimeString)\(\)/g;
// 视图只读呈现器给出的用户状态，不直接读 Host/Core 的连接与加载字段。
const INTERNAL_STATE =
  /\b(?:hostState|summariesLoaded|summariesFreshness)\b|\bstate\??\.connected\b/g;
const TEXT_ASSERTION = /getByText\(\s*["'`]([^"'`]*\p{Script=Han}[^"'`]*)["'`]/gu;

function fingerprint(seen, file, kind, snippet) {
  const identity = `${file}\0${kind}\0${snippet}`;
  const occurrence = (seen.get(identity) ?? 0) + 1;
  seen.set(identity, occurrence);
  return createHash("sha256").update(identity).update(String(occurrence)).digest("hex");
}

async function files(dir, accept) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const path = resolve(entry.parentPath, entry.name);
    if (!/node_modules|\/design-system\//.test(path) && accept(path)) out.push(path);
  }
  return out.sort();
}

function messageEntries(source) {
  return [...source.matchAll(/"([\w.-]+)":\s*\{\s*"zh-CN":\s*"((?:[^"\\]|\\.)*)"/g)].map(
    ([, key, text]) => ({ key, text }),
  );
}

function code(source) {
  return source
    .split("\n")
    .filter((line) => !/^\s*(?:\/\/|\*|\/\*)/.test(line))
    .join("\n");
}

export async function collectUiHonesty() {
  const seen = new Map();
  const findings = [];
  const add = (file, kind, snippet) =>
    findings.push({ file, kind, snippet, fingerprint: fingerprint(seen, file, kind, snippet) });
  const messages = resolve(root, "renderer/src/i18n/messages");
  const copy = new Set();
  for (const path of await files(messages, (p) => p.endsWith(".ts"))) {
    const file = relative(root, path);
    for (const { key, text } of messageEntries(await readFile(path, "utf8"))) {
      copy.add(text);
      if (DIAGNOSTIC_KEYS.test(key)) continue;
      const term = INTERNAL_TERMS.find((word) => text.includes(word));
      if (term) add(file, "internal-term", `${key}: ${term}`);
    }
  }
  const renderer = resolve(root, "renderer/src");
  for (const path of await files(
    renderer,
    (p) => /\.tsx?$/.test(p) && !/\.test\.|\/i18n\//.test(p),
  )) {
    const file = relative(root, path);
    const source = code(await readFile(path, "utf8"));
    for (const match of source.matchAll(/["'`]([^"'`\n]*\p{Script=Han}[^"'`\n]*)["'`]/gu))
      copy.add(match[1]);
    for (const [, id] of source.matchAll(ID_CALLS)) add(file, "cjk-identifier", id);
    for (const [, id] of source.matchAll(ID_COMPARE)) add(file, "cjk-identifier", id);
    for (const match of source.matchAll(LOCALE_DATE)) add(file, "unlocalized-date", match[0]);
    if (/\/(?:views|settings)\/[^/]+\.tsx$/.test(path))
      for (const match of source.matchAll(INTERNAL_STATE))
        add(file, "internal-state-in-view", match[0]);
  }
  // 后台与原生外壳的文案同样会上屏。
  for (const dir of ["../../services/workbench/src", "app/src"])
    for (const path of await files(resolve(root, dir), (p) => /\.(?:c?js|ts)$/.test(p)))
      for (const match of code(await readFile(path, "utf8")).matchAll(
        /["'`]([^"'`\n]*\p{Script=Han}[^"'`\n]*)["'`]/gu,
      ))
        copy.add(match[1]);
  // 验收脚本按文字断言时，文字必须仍在产品里；否则测试在守护一段已删的文案。
  // 脚本自己造的夹具文字（在脚本里出现不止一次）和带插值的模板不算。
  const shipped = [...copy].join("\n");
  // 词条里的 {参数} 和 ICU 复数在断言里已经展开，按片段比对。
  const fragments = [...copy].flatMap((value) =>
    value.split(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/).filter((part) => han.test(part)),
  );
  const assembled = (text) =>
    text
      .split(/[\d.,]+|[A-Za-z][\w.-]*/)
      .filter((part) => han.test(part))
      .every(
        (part) => shipped.includes(part.trim()) || fragments.some((f) => f.includes(part.trim())),
      );
  for (const path of await files(resolve(root, "scripts"), (p) => p.endsWith("smoke.mjs"))) {
    const file = relative(root, path);
    const source = await readFile(path, "utf8");
    for (const [, text] of source.matchAll(TEXT_ASSERTION))
      if (
        han.test(text) &&
        !text.includes("${") &&
        source.split(text).length === 2 &&
        !shipped.includes(text) &&
        !assembled(text)
      )
        add(file, "stale-text-assertion", text);
  }
  return findings;
}

export function compareUiHonesty(findings, baseline) {
  const admitted = new Set(baseline.map((entry) => entry.fingerprint));
  return findings.filter((finding) => !admitted.has(finding.fingerprint));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const findings = await collectUiHonesty();
  const previous = await readFile(baselinePath, "utf8").then(JSON.parse, (error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (process.argv.includes("--write")) {
    if (previous && !process.argv.includes("--init")) {
      const added = compareUiHonesty(findings, previous);
      assert.deepEqual(added, [], "--write only removes fixed entries; fix new findings instead");
    }
    await writeFile(baselinePath, `${JSON.stringify(findings, null, 2)}\n`);
    console.log(JSON.stringify({ written: findings.length }));
  } else {
    assert.ok(previous, "missing design-system/ui-honesty-baseline.json");
    const added = compareUiHonesty(findings, previous);
    for (const finding of added)
      console.error(`${finding.file}: ${finding.kind}: ${finding.snippet}`);
    assert.equal(added.length, 0, "new user-facing internal state or copy");
    const counts = Object.fromEntries(
      [...new Set(findings.map((f) => f.kind))].map((kind) => [
        kind,
        findings.filter((f) => f.kind === kind).length,
      ]),
    );
    console.log(
      JSON.stringify({
        findings: findings.length,
        resolved: previous.length - findings.length,
        counts,
      }),
    );
  }
}
