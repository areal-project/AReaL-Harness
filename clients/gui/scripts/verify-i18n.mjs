import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(gui, "../..");
const require = createRequire(join(gui, "renderer/package.json"));
const ts = require("typescript");
const { parse, TYPE } = await import(
  pathToFileURL(require.resolve("@formatjs/icu-messageformat-parser")).href
);
const catalogs = new Map();
const messageArguments = new Map();
const issues = [];
const add = (file, source, node, message) =>
  issues.push(
    `${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}: ${message}`,
  );

async function sourceFile(file) {
  const text = await readFile(join(gui, file), "utf8");
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
}
function argumentsOf(nodes, output = new Set()) {
  for (const node of nodes) {
    if (
      [
        TYPE.argument,
        TYPE.number,
        TYPE.date,
        TYPE.time,
        TYPE.select,
        TYPE.plural,
        TYPE.tag,
      ].includes(node.type)
    )
      output.add(node.value);
    if (node.options)
      for (const option of Object.values(node.options)) argumentsOf(option.value, output);
    if (node.children) argumentsOf(node.children, output);
  }
  return [...output].sort();
}
for (const entry of (await readdir(join(gui, "renderer/src/i18n/messages"))).sort()) {
  if (!entry.endsWith(".ts")) continue;
  const file = `renderer/src/i18n/messages/${entry}`,
    source = await sourceFile(file);
  const visit = (node) => {
    if (
      ts.isPropertyAssignment(node) &&
      ts.isStringLiteral(node.name) &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      const id = node.name.text;
      if (catalogs.has(id)) add(file, source, node, `Duplicate message ${id}`);
      const pair = Object.fromEntries(
        node.initializer.properties
          .filter(ts.isPropertyAssignment)
          .map((property) => [property.name.text, property.initializer.text]),
      );
      if (Object.keys(pair).sort().join(",") !== "en,zh-CN")
        add(file, source, node, `Message ${id} must contain exactly en and zh-CN`);
      const args = [];
      for (const locale of ["zh-CN", "en"]) {
        if (typeof pair[locale] !== "string" || !pair[locale].trim()) {
          add(file, source, node, `Missing ${locale} message ${id}`);
          continue;
        }
        try {
          args.push(argumentsOf(parse(pair[locale])));
        } catch (error) {
          add(file, source, node, `Invalid ICU in ${locale} ${id}: ${error.message}`);
        }
      }
      if (args.length === 2 && JSON.stringify(args[0]) !== JSON.stringify(args[1]))
        add(file, source, node, `ICU arguments differ for ${id}: ${JSON.stringify(args)}`);
      catalogs.set(id, pair);
      if (args[0]) messageArguments.set(id, args[0]);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

const { nativeMessages } = require(
  join(gui, "../../services/workbench/src/desktop/core/native-i18n.cjs"),
);
const nativeExamples = {
  "browser.frameQuestion": { origin: "https://example.test:4317" },
  "browser.developmentQuestion": { origin: "http://localhost:4317" },
  "lifecycle.mobileConnections": { count: 7 },
  "lifecycle.activeThread": { value: "thread-原文" },
  "lifecycle.goal": { value: "Keep 原始 objective" },
  "lifecycle.task": { value: "task-原文" },
  "lifecycle.resource": { value: "/原始/path/tool" },
};
for (const [id, pair] of Object.entries(nativeMessages)) {
  const issue = (message) => issues.push(`app/src/core/native-i18n.cjs: ${id}: ${message}`);
  if (Object.keys(pair).sort().join(",") !== "en,zh-CN") issue("must contain exactly en and zh-CN");
  if (typeof pair.en !== typeof pair["zh-CN"]) issue("translation kinds differ");
  for (const locale of ["zh-CN", "en"]) {
    const message = pair[locale];
    if (!["string", "function"].includes(typeof message)) {
      issue(`invalid ${locale} message kind`);
      continue;
    }
    if (typeof message === "function" && !nativeExamples[id]) {
      issue("dynamic message needs a representative example");
      continue;
    }
    const values = nativeExamples[id];
    let output;
    try {
      output = typeof message === "function" ? message(values) : message;
    } catch (error) {
      issue(`invalid ${locale} message: ${error.message}`);
      continue;
    }
    if (typeof output !== "string" || !output.trim()) {
      issue(`empty ${locale} message`);
      continue;
    }
    if (typeof message === "function")
      for (const value of Object.values(values)) {
        if (!output.includes(String(value)))
          issue(`${locale} must preserve dynamic value ${JSON.stringify(value)}`);
      }
  }
}

const visibleProps = new Set([
  "label",
  "title",
  "description",
  "placeholder",
  "aria-label",
  "ariaLabel",
  "alt",
  "clearLabel",
  "actionLabel",
  "emptyLabel",
  "addLabel",
]);
const technicalText = new Set([
  "-y\n@modelcontextprotocol/server-memory",
  "/path/to/marketplace",
  "npx",
  "MY_SERVICE_TOKEN",
  "AReaL Harness",
  "Aa",
  "px",
  "API",
  "API Key",
  "API key",
  "Base URL",
  "MCP",
  "Skills",
  "OAuth",
  "JSON",
  "URL",
  "Token",
  "Tokens",
  "English",
  "简体中文",
  "ChatGPT",
  "OpenAI",
  "GitHub",
  "Chat Completions",
  "Responses",
  "CLI",
  "Core",
  "Runtime",
  "SHA-256",
  "UTC",
  "HTTPS",
  "HTTP",
  "GB",
  "MB",
  "KB",
  "B",
  "ms",
  "s",
  "min",
  "h",
  "m",
  "d",
  "×",
  "+/-",
]);
const human = (text) =>
  /[\p{Script=Han}A-Za-z]/u.test(text) &&
  !technicalText.has(text.trim()) &&
  !/^(?:https?:\/\/|\$?\{|settings\.|common\.|chat\.|terminal\.|markdownTable\.|taskList\.)/.test(
    text.trim(),
  );
const identityLiterals = new Map([
  ["MobileSettings.tsx", new Set(["选择连接方式", "打开配对链接", "确认设备"])],
  [
    "UsageDashboard.tsx",
    new Set(["累计使用", "连续使用", "累计 Token", "今日 Token", "昨日 Token", "Skills 调用"]),
  ],
]);
function stableIdentity(node, source) {
  const file = source.fileName.split("/").at(-1);
  const parent = node.parent;
  if (
    file === "settingsNavigation.tsx" &&
    ts.isPropertyAssignment(parent) &&
    parent.initializer === node &&
    parent.name.getText(source) === "id" &&
    ts.isObjectLiteralExpression(parent.parent)
  ) {
    const label = parent.parent.properties.find(
      (property) => ts.isPropertyAssignment(property) && property.name.getText(source) === "label",
    );
    return label && ts.isStringLiteral(label.initializer) && catalogs.has(label.initializer.text);
  }
  if (file === "ServiceStatusSettings.tsx" && ["编辑目标", "队列", "进程"].includes(node.text)) {
    return (
      ts.isCallExpression(parent) &&
      parent.expression.getText(source) === "onOpen" &&
      parent.arguments.at(-1) === node
    );
  }
  const allowed = identityLiterals.get(file);
  return (
    allowed?.has(node.text) &&
    ((ts.isArrayLiteralExpression(node.parent) && node.parent.elements[0] === node) ||
      (ts.isPropertyAssignment(node.parent) && node.parent.name.getText(source) === "key"))
  );
}
const identityAttribute = (node) =>
  ts.isJsxAttribute(node.parent) &&
  ["value", "key", "id", "name", "data-testid"].includes(node.parent.name.getText());
function visibleExpression(node, source) {
  let current = node;
  while (
    current.parent &&
    (ts.isConditionalExpression(current.parent) ||
      ts.isBinaryExpression(current.parent) ||
      ts.isParenthesizedExpression(current.parent))
  ) {
    if (ts.isConditionalExpression(current.parent) && current.parent.condition === current)
      return false;
    if (
      ts.isBinaryExpression(current.parent) &&
      !["||", "??", "+"].includes(current.parent.operatorToken.getText(source))
    )
      return false;
    current = current.parent;
  }
  const parent = current.parent;
  if (parent && ts.isJsxExpression(parent))
    return (
      !ts.isJsxAttribute(parent.parent) || visibleProps.has(parent.parent.name.getText(source))
    );
  return (
    parent &&
    ts.isPropertyAssignment(parent) &&
    parent.initializer === current &&
    visibleProps.has(parent.name.getText(source).replace(/^['"]|['"]$/g, ""))
  );
}
function rawCopy(source, full) {
  const findings = [];
  const flag = (node, text) => findings.push({ node, text: text.trim() });
  const visit = (node) => {
    if (ts.isJsxText(node) && human(node.text.trim())) flag(node, node.text);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const parent = node.parent;
      const name =
        ts.isJsxAttribute(parent) || ts.isPropertyAssignment(parent)
          ? parent.name.getText(source).replace(/^['"]|['"]$/g, "")
          : "";
      const isName = ts.isPropertyAssignment(parent) && parent.name === node;
      const visible = visibleProps.has(name) && !isName;
      const directJsx = visibleExpression(node, source);
      const chinese = /\p{Script=Han}/u.test(node.text);
      if (
        !isName &&
        !identityAttribute(node) &&
        !stableIdentity(node, source) &&
        human(node.text) &&
        (visible || directJsx || (full && chinese))
      )
        flag(node, node.text);
    }
    if (ts.isTemplateExpression(node) && (full || ts.isJsxExpression(node.parent))) {
      const text = node.head.text + node.templateSpans.map((span) => span.literal.text).join("");
      if (
        /\p{Script=Han}/u.test(text) ||
        (human(text) &&
          !technicalText.has(text.replace(/[·\s]/g, "")) &&
          visibleExpression(node, source))
      )
        flag(node, node.getText(source));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
}
const fixture = ts.createSourceFile(
  "probe.tsx",
  '<button aria-label="New setting">保存</button>',
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
assert.equal(
  rawCopy(fixture, true).length,
  2,
  "raw English accessibility copy and Chinese JSX must both fail",
);
const conditionalFixture = ts.createSourceFile(
  "probe.tsx",
  '<button title={busy ? "Please wait" : "Ready"}>{`Count ${count}`}</button>',
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
assert.equal(
  rawCopy(conditionalFixture, true).length,
  3,
  "conditional labels and visible templates must fail",
);
assert.deepEqual(
  argumentsOf(parse("{count, plural, one {# item for {name}} other {# items for {name}}}")),
  ["count", "name"],
);

async function walk(directory) {
  const files = [];
  for (const item of await readdir(join(gui, directory), { withFileTypes: true })) {
    const file = `${directory}/${item.name}`;
    if (item.isDirectory()) files.push(...(await walk(file)));
    else if (/\.(?:tsx?|js)$/.test(item.name)) files.push(file);
  }
  return files;
}
const settingsFiles = (await walk("renderer/src/settings")).filter(
  (file) => !file.endsWith("provider-ui-state.js"),
);
const shared = [
  "renderer/src/McpAppsWorkspace.tsx",
  "renderer/src/components/ui/dialog.tsx",
  "renderer/src/components/ui/feedback.tsx",
  "renderer/src/app-shell/WorkbenchShell.tsx",
];
for (const file of [...settingsFiles, ...shared]) {
  const source = await sourceFile(file);
  for (const finding of rawCopy(source, file.startsWith("renderer/src/settings/")))
    add(file, source, finding.node, `Unlocalized UI copy ${JSON.stringify(finding.text)}`);
}
const git = (args) =>
  execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
const base =
  process.env.AREAL_I18N_BASE ||
  process.env.AREAL_DESIGN_BASE ||
  (process.env.GITHUB_ACTIONS === "true" ? null : "HEAD");
assert.ok(base, "CI must set AREAL_I18N_BASE or AREAL_DESIGN_BASE to audit committed UI changes");
const revision = git(["rev-parse", "--verify", `${base}^{commit}`]).trim();
const changed = new Set([
  ...git(["diff", "--name-only", revision, "--", "clients/gui/renderer/src"]).trim().split("\n"),
  ...git(["ls-files", "--others", "--exclude-standard", "--", "clients/gui/renderer/src"])
    .trim()
    .split("\n"),
]);
let incrementalFiles = 0;
for (const repoFile of changed) {
  if (
    !/\.(tsx?|jsx)$/.test(repoFile) ||
    /\.test\.[tj]sx?$/.test(repoFile) ||
    /\/(?:i18n|design-system)\//.test(repoFile)
  )
    continue;
  const file = relative(gui, join(repo, repoFile));
  if (settingsFiles.includes(file) || shared.includes(file)) continue;
  let source;
  try {
    source = await sourceFile(file);
  } catch (error) {
    if (error.code === "ENOENT") continue;
    throw error;
  }
  let previous = [];
  try {
    previous = rawCopy(
      ts.createSourceFile(
        file,
        git(["show", `${revision}:${repoFile}`]),
        ts.ScriptTarget.Latest,
        true,
      ),
      false,
    );
  } catch (error) {
    if (git(["ls-tree", "--name-only", revision, "--", repoFile]).trim()) throw error;
  }
  const counts = new Map();
  for (const finding of previous) counts.set(finding.text, (counts.get(finding.text) || 0) + 1);
  for (const finding of rawCopy(source, false)) {
    const count = counts.get(finding.text) || 0;
    if (count) counts.set(finding.text, count - 1);
    else add(file, source, finding.node, `New UI copy needs i18n ${JSON.stringify(finding.text)}`);
  }
  incrementalFiles++;
}
for (const file of [...settingsFiles, ...shared, "renderer/src/App.tsx"]) {
  const source = await sourceFile(file);
  const checkUse = (node, id, values) => {
    if (!catalogs.has(id)) {
      add(file, source, node, `Unknown message ${id}`);
      return;
    }
    const required = messageArguments.get(id) || [];
    if (!required.length) return;
    if (!values) {
      add(file, source, node, `Missing ICU arguments for ${id}: ${required.join(", ")}`);
      return;
    }
    if (ts.isObjectLiteralExpression(values) && !values.properties.some(ts.isSpreadAssignment)) {
      const supplied = new Set(
        values.properties
          .filter(
            (property) =>
              ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property),
          )
          .map((property) => property.name.text),
      );
      const missing = required.filter((name) => !supplied.has(name));
      if (missing.length)
        add(file, source, node, `Missing ICU arguments for ${id}: ${missing.join(", ")}`);
    }
  };
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(source) === "t" &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    )
      checkUse(node, node.arguments[0].text, node.arguments[1]);
    if (ts.isObjectLiteralExpression(node)) {
      const properties = node.properties.filter(ts.isPropertyAssignment);
      const id = properties.find((property) => property.name.getText(source) === "id")?.initializer;
      if (id && ts.isStringLiteral(id) && catalogs.has(id.text)) {
        const parent = node.parent;
        if (
          ts.isCallExpression(parent) &&
          parent.expression.getText(source).endsWith(".formatMessage")
        )
          checkUse(node, id.text, parent.arguments[1]);
        else
          checkUse(
            node,
            id.text,
            properties.find((property) => property.name.getText(source) === "values")?.initializer,
          );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}
if (issues.length) {
  console.error(issues.join("\n"));
  process.exitCode = 1;
} else
  console.log(
    JSON.stringify({
      passed: true,
      messages: catalogs.size,
      nativeMessages: Object.keys(nativeMessages).length,
      fullCoverageFiles: settingsFiles.length + shared.length,
      incrementalFiles,
      base: revision,
      scope:
        "bundled renderer catalogs and ICU arguments, paired native catalog and representative dynamic outputs, raw settings copy and new visible renderer copy; external content and arbitrary dynamic data flow require UI review",
    }),
  );
