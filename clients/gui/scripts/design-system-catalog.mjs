import assert from "node:assert/strict";
import { readFile, writeFile, readdir, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const guiRoot = fileURLToPath(new URL("../", import.meta.url));
const text = value => typeof value === "string" && value.trim().length > 0;
const cells = value => String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
const list = (value, label) => assert.ok(Array.isArray(value) && value.length > 0, `${label}: expected nonempty array`);
function unique(items, label) {
  list(items, label);
  assert.equal(new Set(items).size, items.length, `${label}: duplicate entry`);
}
async function source(root, path) {
  assert.ok(text(path) && !path.startsWith("/") && !path.includes("\\"), `invalid source path: ${path}`);
  const absolute = resolve(root, path);
  assert.ok(!relative(root, absolute).startsWith(".."), `source escapes GUI: ${path}`);
  assert.ok((await stat(absolute)).isFile(), `source is not a file: ${path}`);
  return readFile(absolute, "utf8");
}
async function reference(root, value) {
  assert.ok(text(value), "missing document reference");
  const [path, anchor, extra] = value.split("#");
  assert.equal(extra, undefined, `invalid document reference: ${value}`);
  const document = await source(root, path);
  if (anchor !== undefined) {
    assert.ok(/^[a-z][a-z0-9-]*$/.test(anchor), `invalid document anchor: ${value}`);
    const headings = [...document.matchAll(/^#{1,6} +(.+)$/gm)].map(match => match[1].toLowerCase().replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, "").replace(/\s/g, "-"));
    assert.equal(headings.filter(value => value === anchor).length, 1, `missing/duplicate document anchor: ${value}`);
  }
}
const entryExports = new Map();
async function uiEntryExports(root) {
  if (!entryExports.has(root)) {
    const read = async name => new Set([...(await readFile(join(root, `packages/ui/src/${name}.ts`), "utf8")).matchAll(/export\s*\{([^}]+)\}/g)]
      .flatMap(match => match[1].split(",").map(item => item.trim().replace(/^type\s+/, "").split(/\s+as\s+/).at(-1))).filter(Boolean));
    entryExports.set(root, { index: await read("index"), wip: await read("wip") });
  }
  return entryExports.get(root);
}
function block(document, name, body) {
  const start = `<!-- BEGIN GENERATED: ${name} -->`;
  const end = `<!-- END GENERATED: ${name} -->`;
  assert.equal(document.split(start).length, 2, `missing/duplicate marker: ${start}`);
  assert.equal(document.split(end).length, 2, `missing/duplicate marker: ${end}`);
  const from = document.indexOf(start) + start.length, to = document.indexOf(end);
  assert.ok(to >= from, `reversed markers: ${name}`);
  return document.slice(0, from) + `\n\n${body}\n\n` + document.slice(to);
}

// 本目录是声明与派生输出的合同，不解析 JSX，也不把声明当作运行/视觉验收。
export async function verifyDesignCatalog({ write = false, root = guiRoot } = {}) {
  const dataRoot = join(root, "design-system");
  const registry = JSON.parse(await readFile(join(dataRoot, "registry.json"), "utf8"));
  assert.equal(registry.schemaVersion, 1, "registry.schemaVersion must be 1");
  unique(registry.tokenSources, "tokenSources");
  const tokenSources = await Promise.all(registry.tokenSources.map(path => source(root, path)));
  const sharedFocus = await readFile(new URL("../../../design/tokens/focus.css", import.meta.url), "utf8");
  const definitions = new Set([...(sharedFocus + tokenSources.join("\n")).matchAll(/(--[\w-]+)["']?\s*:/g)].map(match => match[1]));
  list(registry.tokenGroups, "tokenGroups");
  const tokenNames = [];
  for (const group of registry.tokenGroups) {
    assert.ok(text(group.title), "token group needs a title");
    list(group.tokens, group.title);
    for (const pair of group.tokens) {
      assert.ok(Array.isArray(pair) && pair.length === 2 && pair.every(text), `${group.title}: expected [name, role]`);
      assert.ok(definitions.has(pair[0]), `registry: undefined production token ${pair[0]}`);
      tokenNames.push(pair[0]);
    }
  }
  unique(tokenNames, "tokens");
  list(registry.components, "components");
  unique(registry.components.map(item => item.id), "component ids");
  const components = new Set(registry.components.map(item => item.id));
  for (const component of registry.components) {
    assert.ok(/^[A-Z]\w*$/.test(component.id) && text(component.purpose), `invalid component: ${component.id}`);
    await source(root, component.source);
    if (component.importFrom !== undefined) assert.ok(/^@areal\/[a-z-]+$/.test(component.importFrom) || component.importFrom === "@areal/ui/wip", `invalid package import: ${component.id}`);
    // 成熟度只由包入口决定：目录里的 importFrom 必须与组件实际所在的入口一致。
    if (component.importFrom === "@areal/ui" || component.importFrom === "@areal/ui/wip") {
      const entry = component.importFrom === "@areal/ui" ? "index" : "wip";
      assert.ok((await uiEntryExports(root))[entry].has(component.id), `${component.id} is not exported by ${component.importFrom}; update registry.json importFrom`);
    }
  }
  list(registry.patterns, "patterns");
  unique(registry.patterns.map(item => item.id), "pattern ids");
  const patterns = new Map(registry.patterns.map(item => [item.id, item]));
  let rules = 0;
  for (const pattern of registry.patterns) {
    assert.ok(/^P-[A-Z]+$/.test(pattern.id), `invalid pattern id: ${pattern.id}`);
    for (const key of ["intent", "variation", "acceptance"]) assert.ok(text(pattern[key]), `${pattern.id}: missing ${key}`);
    for (const key of ["components", "slots", "states"]) unique(pattern[key], `${pattern.id}.${key}`);
    for (const id of pattern.components) assert.ok(components.has(id), `${pattern.id}: unknown component ${id}`);
    await source(root, pattern.reference);
    if (pattern.rules !== undefined || pattern.ruleSource !== undefined) {
      unique(pattern.rules, `${pattern.id}.rules`);
      rules += pattern.rules.length;
      const document = await source(root, pattern.ruleSource);
      for (const id of pattern.rules) {
        assert.ok(/^[A-Z]+(?:-[A-Z]+)+-\d{2}$/.test(id), `${pattern.id}: invalid rule id ${id}`);
        assert.equal(document.split(`\`${id}\`：`).length - 1, 1, `${pattern.id}: rule ${id} needs one canonical definition`);
      }
    }
  }
  unique(registry.interactionFamilies.map(item => item.id), "interaction family ids");
  const interactionFamilies = new Set(registry.interactionFamilies.map(item => item.id));
  for (const family of registry.interactionFamilies) {
    assert.ok(/^I-[A-Z]+$/.test(family.id) && text(family.intent), `invalid interaction family ${family.id}`);
    for (const key of ["patterns", "components", "rules"]) unique(family[key], `${family.id}.${key}`);
    for (const id of family.patterns) assert.ok(patterns.has(id), `${family.id}: unknown pattern ${id}`);
    for (const id of family.components) assert.ok(components.has(id), `${family.id}: unknown component ${id}`);
    const document = await source(root, family.ruleSource);
    for (const id of family.rules) assert.equal(document.split(`\`${id}\`：`).length - 1, 1, `${family.id}: rule ${id} needs one canonical definition`);
  }
  const base = registry.baseCandidate;
  assert.ok(base && text(base.id) && /^\d+\.\d+\.\d+$/.test(base.version), "baseCandidate needs id/version");
  for (const key of ["foundations", "primitives", "compositions", "patterns", "acceptance", "limits"]) unique(base[key], `baseCandidate.${key}`);
  for (const title of base.foundations) assert.ok(registry.tokenGroups.some(group => group.title === title), `baseCandidate: unknown foundation ${title}`);
  unique([...base.primitives, ...base.compositions], "baseCandidate component membership");
  const baseComponents = new Set([...base.primitives, ...base.compositions]);
  for (const id of baseComponents) assert.ok(components.has(id), `baseCandidate: unknown component ${id}`);
  for (const id of base.patterns) {
    assert.ok(patterns.has(id), `baseCandidate: unknown pattern ${id}`);
    for (const component of patterns.get(id).components) assert.ok(baseComponents.has(component), `baseCandidate: ${id} needs ${component}`);
  }
  assert.ok(["candidate", "frozen-beta"].includes(base.status), "baseCandidate.status must be candidate or frozen-beta");
  assert.ok(base.snapshot && text(base.snapshot.owner), "baseCandidate.snapshot needs owner");
  await reference(root, base.snapshot.owner);
  assert.ok(base.snapshot.revision === null || /^[a-f0-9]{40}$/.test(base.snapshot.revision), "baseCandidate.snapshot.revision must be null or an exact commit");
  if (base.status === "frozen-beta") assert.ok(base.snapshot.revision !== null, "frozen baseCandidate.snapshot.revision needs an exact commit");
  list(base.admissions, "baseCandidate.admissions");
  unique(base.admissions.map(item => item.id), "baseCandidate.admissions ids");
  for (const item of base.admissions) assert.ok(baseComponents.has(item.id), `baseCandidate: unknown admitted member ${item.id}`);
  for (const id of baseComponents) assert.ok(base.admissions.some(item => item.id === id), `baseCandidate: missing admission ${id}`);
  list(base.evidence, "baseCandidate.evidence");
  unique(base.evidence.map(item => item.id), "baseCandidate.evidence ids");
  const evidenceIds = new Set(base.evidence.map(item => item.id));
  for (const item of base.evidence) {
    assert.ok(/^E-[A-Z]+$/.test(item.id), `invalid evidence id ${item.id}`);
    await source(root, item.checker);
    await reference(root, item.report);
  }
  const exports = [];
  for (const item of base.admissions) {
    await reference(root, item.contract);
    unique(item.consumers, `${item.id}.consumers`);
    for (const consumer of item.consumers) await source(root, consumer);
    for (const key of ["variants", "states", "evidence"]) {
      unique(item[key], `${item.id}.${key}`);
      assert.ok(item[key].every(value => text(value) && /^[A-Za-z0-9][A-Za-z0-9/-]*$/.test(value)), `${item.id}.${key}: expected finite named values`);
    }
    for (const id of item.evidence) assert.ok(evidenceIds.has(id), `${item.id}: unknown evidence ${id}`);
    const names = item.exports ?? [item.id];
    unique(names, `${item.id}.exports`);
    assert.ok(names.includes(item.id) && names.every(name => /^[A-Z]\w*$/.test(name)), `${item.id}: invalid exports`);
    exports.push(...names);
  }
  unique(exports, "baseCandidate exports");
  const surfaces = (await readdir(join(dataRoot, "surfaces"))).filter(name => name.endsWith(".json")).sort();
  list(surfaces, "surface contracts");
  const surfaceIds = [];
  for (const name of surfaces) {
    const path = `design-system/surfaces/${name}`;
    const surface = JSON.parse(await source(root, path));
    assert.equal(surface.schemaVersion, 1, `${path}: schemaVersion must be 1`);
    for (const key of ["id", "intent", "target", "runtime"]) assert.ok(text(surface[key]), `${path}: missing ${key}`);
    assert.ok(["component-preview", "desktop", "remote"].includes(surface.runtime), `${path}: unknown runtime`);
    surfaceIds.push(surface.id);
    const pattern = patterns.get(surface.pattern);
    assert.ok(pattern, `${path}: unknown pattern ${surface.pattern}`);
    await source(root, surface.target);
    if (surface.interactionFamilies !== undefined) {
      unique(surface.interactionFamilies, `${path}.interactionFamilies`);
      for (const id of surface.interactionFamilies) {
        assert.ok(interactionFamilies.has(id), `${path}: unknown interaction family ${id}`);
        assert.ok(registry.interactionFamilies.find(item => item.id === id).patterns.includes(surface.pattern), `${path}: family ${id} does not support ${surface.pattern}`);
      }
    }

    if (pattern.rules !== undefined || surface.rules !== undefined) {
      unique(surface.rules, `${path}.rules`);
      for (const id of surface.rules) assert.ok(pattern.rules?.includes(id), `${path}: unknown rule ${id}`);
      for (const id of pattern.rules ?? []) assert.ok(surface.rules.includes(id), `${path}: missing required rule ${id}`);
    }
    assert.ok(["existing-code", "screenshot", "figma"].includes(surface.reference?.kind), `${path}: missing reference kind`);
    if (surface.reference.kind === "existing-code") await source(root, surface.reference.path);
    else assert.ok(text(surface.reference.visualTarget), `${path}: missing selected visual target`);
    assert.ok(surface.slots && typeof surface.slots === "object", `${path}: missing slots`);
    for (const slot of pattern.slots) list(surface.slots[slot], `${path}.${slot}`);
    for (const [slot, ids] of Object.entries(surface.slots)) {
      assert.ok(pattern.slots.includes(slot), `${path}: unknown slot ${slot}`);
      unique(ids, `${path}.${slot}`);
      for (const id of ids) assert.ok(components.has(id), `${path}: unknown component ${id}`);
    }
    list(surface.states, `${path}.states`);
    unique(surface.states.map(item => item.id), `${path}.state ids`);
    for (const state of pattern.states) assert.ok(surface.states.some(item => item.id === state), `${path}: missing required state ${state}`);
    for (const state of surface.states) assert.ok(text(state.condition) && text(state.expected), `${path}.${state.id}: missing condition/expected`);
    for (const key of ["themes", "fontSizes", "widthModes", "reducedMotion"]) list(surface.conditions?.[key], `${path}.conditions.${key}`);
    assert.ok(surface.conditions.themes.every(value => ["light", "dark"].includes(value)), `${path}: unknown theme condition`);
    assert.ok(surface.conditions.widthModes.every(value => ["wide", "narrow"].includes(value)), `${path}: unknown width mode`);
    assert.ok(surface.conditions.fontSizes.every(value => typeof value === "number" && Number.isFinite(value) && value > 0), `${path}: invalid font size condition`);
    assert.ok(surface.conditions.reducedMotion.every(value => typeof value === "boolean"), `${path}: invalid reduced motion condition`);
    list(surface.invariants, `${path}.invariants`);
    assert.ok(surface.invariants.every(text), `${path}: empty invariant`);
    assert.ok(["pending", "captured", "compared"].includes(surface.evidence?.status), `${path}: missing evidence status`);
    assert.ok(Array.isArray(surface.evidence.artifacts) && Array.isArray(surface.evidence.gaps), `${path}: missing artifacts/gaps`);
    if (surface.evidence.status === "pending") list(surface.evidence.gaps, `${path}: pending evidence needs explicit gaps`);
    if (surface.evidence.status !== "pending") {
      list(surface.evidence.artifacts, `${path}: non-pending evidence needs artifacts`);
      assert.ok(surface.evidence.artifacts.every(item => text(item.path) && /^[a-f0-9]{64}$/.test(item.sha256) && text(item.state)), `${path}: artifact needs path/sha256/state`);
    }
    if (surface.evidence.status === "compared") assert.ok(text(surface.reference.visualTarget), `${path}: compared needs a selected visual target`);
  }
  unique(surfaceIds, "surface ids");
  const componentTable = "## 生产组件（生成）\n\n| ID | 生产所有者 | 用途 |\n| --- | --- | --- |\n" + registry.components.map(item => `| ${item.id} | [${item.id}](../${item.source}) | ${cells(item.purpose)} |`).join("\n");
  const patternTable = "| ID / 用户任务 | 最小组合 / 生产参考 | 允许变化 | 验收重点 |\n| --- | --- | --- | --- |\n" + registry.patterns.map(item => `| ${item.id} ${cells(item.intent)} | ${item.components.join(" + ")}；[参考](../${item.reference}) | ${cells(item.variation)} | ${cells(item.acceptance)} |`).join("\n");
  const catalog = "// 由 design-system/registry.json 生成；运行 pnpm --dir clients/gui design:sync。\n// 只记录角色与定义名，数值始终从生产 CSS 读取。\nexport const tokenGroups = " + JSON.stringify(registry.tokenGroups, null, 2) + " as const;\nexport const baseCandidate = " + JSON.stringify(base, null, 2) + " as const;\n";
  const outputs = new Map([["renderer/src/design-system/catalog.ts", catalog]]);
  const sourceEntry = base.admissions.map(item => {
    const component = registry.components.find(component => component.id === item.id);
    const path = relative("renderer/src/design-system", component.source).replace(/\.tsx?$/, ".js");
    return `export { ${(item.exports ?? [item.id]).join(", ")} } from "${component.importFrom ?? (path.startsWith(".") ? path : `./${path}`)}";`;
  }).join("\n") + "\n";
  outputs.set("renderer/src/design-system/base-components.ts", sourceEntry);
  const admissionTable = "| 成员 | 合同 / 生产消费者 | 有限变体 | 状态 | 证据ID |\n| --- | --- | --- | --- | --- |\n" + base.admissions.map(item => `| ${item.id} | [合同](../${item.contract})；${item.consumers.map(path => `[消费者](../${path})`).join("、")} | ${item.variants.join(", ")} | ${item.states.join(", ")} | ${item.evidence.join(", ")} |`).join("\n");
  const baseSummary = `候选 ID：\`${base.id}\`；版本：\`${base.version}\`；状态：\`${base.status}\`。\n\n来源快照：${base.snapshot.revision ? `\`${base.snapshot.revision}\`` : "待最终验收后记录"}；冻结与兼容所有者：[${base.snapshot.owner}](../${base.snapshot.owner})。\n\n| 层 | 准入范围 |\n| --- | --- |\n| Foundations | ${base.foundations.join("、")} |\n| Primitives | ${base.primitives.join("、")} |\n| Compositions | ${base.compositions.join("、")} |\n| Patterns | ${base.patterns.join("、")} |\n\n### 成员准入\n\n${admissionTable}\n\n证据ID统一映射到 [Base证据索引](base-evidence.md)。路径验证只确认引用存在，不解析JSX证明消费者采用；真实符号导出由TypeScript检查。\n\n### 验收条件\n\n${base.acceptance.map(value => `- ${value}`).join("\n")}\n\n### 边界\n\n${base.limits.map(value => `- ${value}`).join("\n")}`;
  for (const [file, name, body] of [["inventory.md", "components", componentTable], ["patterns.md", "patterns", patternTable], ["base.md", "base", baseSummary]]) {
    const path = `design-system/${file}`;
    outputs.set(path, block(await source(root, path), name, body));
  }
  const familyTable = "| ID / 用户意图 | 既有组合 | 生产所有者 | 规则 |\n| --- | --- | --- | --- |\n" + registry.interactionFamilies.map(item => `| ${item.id} ${cells(item.intent)} | ${item.patterns.join(", ")} | ${item.components.join(", ")} | ${item.rules.join(", ")} |`).join("\n");
  outputs.set("design-system/interactions.md", block(await source(root, "design-system/interactions.md"), "interaction-families", familyTable));
  const stale = [];
  for (const [path, content] of outputs) {
    let previous;
    try { previous = await readFile(join(root, path), "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (previous === content) continue;
    if (write) await writeFile(join(root, path), content);
    else stale.push(path);
  }
  assert.equal(stale.length, 0, `Design catalog is stale: ${stale.join(", ")}. Run pnpm --dir clients/gui design:sync; do not edit generated blocks.`);
  return { components: components.size, patterns: patterns.size, tokens: tokenNames.length, surfaces: surfaces.length, rules, interactionFamilies: interactionFamilies.size, outputs: outputs.size };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.ok(process.argv.slice(2).every(arg => ["--write", "--check"].includes(arg)), "usage: design-system-catalog.mjs [--write|--check]");
  assert.ok(!(process.argv.includes("--write") && process.argv.includes("--check")), "choose --write or --check");
  console.log(JSON.stringify({ passed: true, mode: process.argv.includes("--write") ? "write" : "check", ...await verifyDesignCatalog({ write: process.argv.includes("--write") }) }));
}
