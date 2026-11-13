import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../../../", import.meta.url));
export const normative =
  /必须|不得|不能|不应|禁止|默认|不允许|只能|应当|不要|不可|不再|仅限|需要|应保持|须|不(?:把|用|在|让|从|按|以|自动|新增|重复|改|扩大|读取|写入|使用|维护|承载|继承|等于|替代|拥有|伪造|暴露|代表|证明|另|建|取消|将|因|丢|清|强)|保留|沿用|复用|优先|先核对|先说明|先固定|明确|分别报告|每组截图|每个发布|记录源码|\b(?:must|shall|should|default|never|cannot|do not|must not)\b/i;
const ruleId =
  /\b(?:R-[A-Z0-9-]+-\d{3}|(?:NAV|INPUT|OBSERVE|READ|RETURN|DECIDE|MANAGE|RECOVER|CONV|SET|WT)-[A-Z0-9-]+-\d{2})\b/g;
const digest = (text) => createHash("sha256").update(text).digest("hex");
const anchor = (text) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, "")
    .replace(/\s/g, "-");

// 规则正文末尾的“**检查：**”声明它由哪个测试或脚本保证；登记表的 check 字段由 --write 从这里生成。
export function declaredCheck(text) {
  const match = /\*\*检查：\*\*\s*(?:`([^`]+)`|(人工 review))/.exec(text);
  return match ? (match[1] ?? "review") : undefined;
}
const ruleTitle = (text) =>
  text
    .replace(/\*\*[^*]+\*\*[\s\S]*$/, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`/g, "")
    .replace(/^[A-Z]+(?:-[A-Z]+)+-\d{2}[：:]\s*/, "")
    .split(/[。；]/)[0]
    .trim()
    .slice(0, 60);

export function ruleBlocks(document) {
  const blocks = [];
  let section = "";
  let generated = false;
  let fenced = false;
  let frontmatter = document.startsWith("---\n");
  let line = 1;
  for (const raw of document.split(/\n\s*\n/)) {
    const text = raw.trim();
    const start = line;
    line += raw.split("\n").length + 1;
    if (frontmatter) {
      if (text.split("\n").filter((value) => value === "---").length >= 2) frontmatter = false;
      continue;
    }
    if (text.includes("<!-- BEGIN GENERATED:")) generated = true;
    if (generated) {
      if (text.includes("<!-- END GENERATED:")) generated = false;
      continue;
    }
    if (/^```|^~~~/.test(text)) {
      if ((text.match(/^```|^~~~/gm) ?? []).length % 2) fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    if (/^#{1,6} /.test(text)) {
      section = anchor(text.split("\n")[0].replace(/^#+ /, ""));
      continue;
    }
    if (!text || /^<!--(?! rule:)/.test(text) || text.startsWith("<a id=")) continue;
    const parts = /^[-*] |^\d+\. |^\|/.test(text) ? text.split("\n") : [text];
    for (const [index, part] of parts.entries()) {
      if (part.startsWith("|") && /^\|[\s:|-]+$/.test(parts[index + 1] ?? "")) continue;
      const marker = /<!-- rule:([A-Z0-9-]+) -->\s*/.exec(part);
      const prefix = /^(?:[-*] |\d+\. |\| )?`(R-[A-Z0-9-]+-\d{3})` /.exec(part);
      const legacy = /^(?:[-*] |\d+\. |\| )?`([A-Z]+(?:-[A-Z]+)+-\d{2})`[：:(（]/.exec(part);
      blocks.push({
        text: marker
          ? part.replace(marker[0], "")
          : prefix
            ? part.replace(`\`${prefix[1]}\` `, "")
            : part,
        id: marker?.[1] ?? prefix?.[1] ?? legacy?.[1],
        section,
        line: start,
        raw: part,
      });
    }
  }
  return blocks;
}

export function validateRuleDocuments({
  documents,
  inventory,
  registry,
  structuredSources = new Map(),
  refresh = false,
}) {
  assert.equal(registry.schemaVersion, 1, "unsupported rule registry version");
  const index = new Map(inventory.map((item) => [item.path, item]));
  assert.equal(index.size, inventory.length, "duplicate inventory document");
  for (const path of documents.keys()) assert.ok(index.has(path), `unclassified document: ${path}`);
  for (const item of inventory) {
    assert.ok(documents.has(item.path), `missing inventory document: ${item.path}`);
    assert.ok(
      ["consumer", "maintainer", "cross-product", "process-evidence"].includes(item.role),
      `invalid document role: ${item.path}`,
    );
    assert.ok(
      ["active", "redirect", "archived", "generated"].includes(item.status),
      `invalid document status: ${item.path}`,
    );
    if (item.status === "redirect")
      assert.ok(documents.has(item.target), `missing migration target: ${item.path}`);
  }
  const rules = new Map();
  for (const rule of registry.rules) {
    assert.match(
      rule.id,
      /^(?:R-[A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)*-\d{3}|[A-Z]+(?:-[A-Z]+)+-\d{2})$/,
      `invalid rule ID: ${rule.id}`,
    );
    assert.ok(!rules.has(rule.id), `duplicate rule: ${rule.id}`);
    assert.ok(
      ["must", "default", "explore"].includes(rule.strength),
      `invalid strength: ${rule.id}`,
    );
    assert.ok(rule.title && rule.owner && rule.textSha256, `incomplete rule: ${rule.id}`);
    rules.set(rule.id, rule);
  }
  // R-CHECK-023：组件合同只留需要判断的强制规则；超过上限说明该拆组件或把规则写成检查。
  const mustByContract = new Map();
  for (const rule of rules.values()) {
    const owner = rule.owner.split("#")[0];
    if (rule.strength !== "must" || !/\/packages\/ui\/src\/.+\.md$/.test(owner)) continue;
    mustByContract.set(owner, (mustByContract.get(owner) ?? 0) + 1);
  }
  for (const [owner, count] of mustByContract)
    assert.ok(count <= 10, `too many must rules in component contract ${owner}: ${count} > 10`);
  const definitions = new Map();
  for (const [path, document] of documents) {
    const item = index.get(path);
    if (["archived", "generated", "redirect"].includes(item.status)) continue;
    for (const block of ruleBlocks(document)) {
      if (block.id) {
        if (refresh && !rules.has(block.id)) {
          // 新规则由脚本登记；强度默认 default，需要 must 时在登记表里改强度。
          const rule = {
            id: block.id,
            title: ruleTitle(block.text),
            owner: `${path}#${block.section}`,
            strength: "default",
            textSha256: digest(block.text),
          };
          registry.rules.push(rule);
          rules.set(rule.id, rule);
        }
        assert.ok(rules.has(block.id), `unknown rule definition: ${block.id}`);
        definitions.set(block.id, [...(definitions.get(block.id) ?? []), { ...block, path }]);
      }
      if (
        normative.test(block.text) &&
        !block.id &&
        !item.translationOf &&
        !registry.rules.some(
          (rule) =>
            rule.locator === "paragraph" &&
            rule.owner === `${path}#${block.section}` &&
            rule.textSha256 === digest(block.text),
        )
      ) {
        assert.ok(
          (item.nonNormative ?? []).includes(digest(block.text)),
          `unregistered normative paragraph: ${path}:${block.line}`,
        );
      }
    }
    for (const id of document.match(ruleId) ?? [])
      assert.ok(rules.has(id), `unknown rule reference: ${id} in ${path}`);
  }
  for (const rule of rules.values()) {
    const [path, fragment] = rule.owner.split("#");
    if (rule.locator === "json-pointer") {
      assert.ok(structuredSources.has(path), `missing owner: ${rule.owner}`);
      const value = fragment
        .slice(1)
        .split("/")
        .reduce(
          (value, key) => value?.[key.replaceAll("~1", "/").replaceAll("~0", "~")],
          structuredSources.get(path),
        );
      assert.equal(typeof value, "string", `missing owner pointer: ${rule.owner}`);
      assert.equal(digest(value), rule.textSha256, `wording hash mismatch: ${rule.id}`);
      continue;
    }
    assert.ok(documents.has(path), `missing owner: ${rule.owner}`);
    const found =
      rule.locator === "paragraph"
        ? ruleBlocks(documents.get(path))
            .filter((block) => digest(block.text) === rule.textSha256)
            .map((block) => ({ ...block, path }))
        : (definitions.get(rule.id) ?? []);
    assert.equal(found.length, 1, `definition count for ${rule.id}: ${found.length}`);
    // 规则 ID 在正文里唯一定义，owner 跟随定义所在的文件与章节，由 --write 同步。
    if (
      refresh &&
      rule.locator !== "paragraph" &&
      !documents.get(found[0].path).includes(`<a id="${fragment}"></a>`)
    )
      rule.owner = `${found[0].path}#${found[0].section}`;
    const [ownerPath, ownerFragment] = rule.owner.split("#");
    assert.equal(found[0].path, ownerPath, `wrong owner for ${rule.id}`);
    assert.ok(
      found[0].section === ownerFragment ||
        documents.get(ownerPath).includes(`<a id="${ownerFragment}"></a>`),
      `owner anchor mismatch: ${rule.owner}`,
    );
    const check = declaredCheck(found[0].text);
    if (refresh) {
      if (rule.textSha256 !== digest(found[0].text)) rule.title = ruleTitle(found[0].text);
      rule.textSha256 = digest(found[0].text);
      if (check) rule.check = check;
      else delete rule.check;
    }
    assert.equal(
      rule.check,
      check,
      `check mismatch: ${rule.id}; 正文的“检查：”改动后运行 node scripts/design-rules.mjs --write`,
    );
    assert.equal(
      digest(found[0].text),
      rule.textSha256,
      `wording hash mismatch: ${rule.id}; 正文改动后运行 node scripts/design-rules.mjs --write`,
    );
  }
  const entryBytes = registry.entryDocuments.reduce((total, path) => {
    assert.ok(documents.has(path), `missing entry document: ${path}`);
    return total + Buffer.byteLength(documents.get(path));
  }, 0);
  assert.ok(
    entryBytes <= registry.entryByteLimit,
    `entry bytes ${entryBytes} exceed ${registry.entryByteLimit}`,
  );
  const activeDesignDocBytes = [...documents]
    .filter(
      ([path]) =>
        /^(design\/|clients\/gui\/design-system\/)/.test(path) &&
        !path.split("/").includes("archive"),
    )
    .reduce((total, [, document]) => total + Buffer.byteLength(document), 0);
  return {
    rules: rules.size,
    documents: documents.size,
    activeDesignDocBytes,
    userEntryDocBytes: entryBytes,
    activeReduction:
      1 - activeDesignDocBytes / (registry.baseline?.activeDesignDocBytes ?? activeDesignDocBytes),
  };
}

async function markdownPaths(directory) {
  return (
    await Promise.all(
      (await readdir(directory, { withFileTypes: true })).map(async (entry) => {
        const path = resolve(directory, entry.name);
        if (entry.isDirectory()) return markdownPaths(path);
        return entry.isFile() && path.endsWith(".md") ? [path] : [];
      }),
    )
  ).flat();
}

export async function collectDesignRuleMetrics({ root = repository } = {}) {
  const registry = JSON.parse(
    await readFile(resolve(root, "clients/gui/design-system/rule-registry.json"), "utf8"),
  );
  assert.ok(Array.isArray(registry.entryDocuments), "rule registry requires entryDocuments");
  const paths = (
    await Promise.all(
      ["design", "clients/gui/design-system"].map((path) => markdownPaths(resolve(root, path))),
    )
  )
    .flat()
    .filter((path) => !relative(root, path).split(/[\\/]/).includes("archive"));
  const sizes = await Promise.all(paths.map(async (path) => (await readFile(path)).length));
  const entrySizes = await Promise.all(
    registry.entryDocuments.map(async (path) => (await readFile(resolve(root, path))).length),
  );
  return {
    activeDesignDocBytes: sizes.reduce((total, size) => total + size, 0),
    userEntryDocBytes: entrySizes.reduce((total, size) => total + size, 0),
  };
}

export async function verifyDesignRules({ root = repository, write = false } = {}) {
  const registry = JSON.parse(
    await readFile(resolve(root, "clients/gui/design-system/rule-registry.json"), "utf8"),
  );
  const inventory = JSON.parse(
    await readFile(resolve(root, "clients/gui/design-system/document-inventory.json"), "utf8"),
  );
  const paths = [
    ...(
      await Promise.all(
        [
          "design",
          "clients/gui/design-system",
          "clients/gui/packages/ui/src",
          "clients/gui/renderer/src",
        ].map((path) => markdownPaths(resolve(root, path))),
      )
    ).flat(),
    ...["README.md", "README.en.md", "agent-guide.md", "token-reference.md"].map((path) =>
      resolve(root, "clients/gui/packages/ui", path),
    ),
  ];
  const documents = new Map(
    await Promise.all(
      paths.map(async (path) => [
        relative(root, path).replaceAll("\\", "/"),
        await readFile(path, "utf8"),
      ]),
    ),
  );
  const structuredSources = new Map(
    await Promise.all(
      [
        ...new Set(
          registry.rules
            .filter((rule) => rule.locator === "json-pointer")
            .map((rule) => rule.owner.split("#")[0]),
        ),
      ].map(async (path) => [path, JSON.parse(await readFile(resolve(root, path), "utf8"))]),
    ),
  );
  // 规则 ID 定义的正文摘要由本脚本生成，不手算；--write 只刷新已能唯一定位的定义。
  const result = validateRuleDocuments({
    documents,
    inventory,
    registry,
    structuredSources,
    refresh: write,
  });
  // 声明的检查必须真实存在，并在文件里写明规则 ID，让规则与测试可以互相追溯。
  for (const rule of registry.rules.filter((rule) => rule.check && rule.check !== "review")) {
    const target = await readFile(resolve(root, rule.check), "utf8").catch(() => null);
    assert.ok(target !== null, `missing check for ${rule.id}: ${rule.check}`);
    assert.ok(target.includes(rule.id), `${rule.check} does not mention ${rule.id}`);
  }
  if (write)
    await writeFile(
      resolve(root, "clients/gui/design-system/rule-registry.json"),
      JSON.stringify(registry, null, 2) + "\n",
    );
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  console.log(
    JSON.stringify(await verifyDesignRules({ write: process.argv.includes("--write") }), null, 2),
  );
