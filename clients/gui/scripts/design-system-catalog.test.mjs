import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyDesignCatalog } from "./design-system-catalog.mjs";

const gui = fileURLToPath(new URL("../", import.meta.url));
// 只复制目录检查所需文件；变异和生成均在临时目录，不写入产品工作树。
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "areal-design-contract-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(join(gui, "design-system"), join(root, "design-system"), { recursive: true });
  const registry = JSON.parse(await readFile(join(root, "design-system/registry.json"), "utf8"));
  const sources = [
    ...registry.tokenSources,
    ...registry.components.map(item => item.source),
    ...registry.patterns.map(item => item.reference),
    "renderer/src/design-system/catalog.ts",
    "renderer/src/design-system/base-components.ts",
    "packages/ui/src/index.ts",
    "packages/ui/src/wip.ts",
    registry.baseCandidate.snapshot.owner.split("#")[0],
    ...registry.baseCandidate.admissions.flatMap(item => [item.contract.split("#")[0], ...item.consumers]),
    ...registry.baseCandidate.evidence.flatMap(item => [item.checker, item.report.split("#")[0]]),
  ];
  for (const name of await readdir(join(root, "design-system/surfaces"))) {
    const item = JSON.parse(await readFile(join(root, "design-system/surfaces", name), "utf8"));
    sources.push(item.target);
    if (item.reference.kind === "existing-code") sources.push(item.reference.path);
  }
  for (const source of new Set(sources)) {
    await mkdir(dirname(join(root, source)), { recursive: true });
    await cp(join(gui, source), join(root, source));
  }
  const pattern = registry.patterns.find(item => item.id === "P-CONVERSATION");
  pattern.ruleSource = "design-system/patterns.md";
  pattern.rules = ["CONV-READ-01"];
  pattern.states = ["ready", "busy", "failed", "unknown", "reading-history"];
  const surface = {
    schemaVersion: 1, id: "conversation-contract-check", intent: "检查对话规则引用，不验收UI",
    pattern: "P-CONVERSATION", target: pattern.reference, runtime: "component-preview",
    reference: { kind: "existing-code", path: "renderer/src/Messages.tsx", visualTarget: null },
    rules: ["CONV-READ-01"],
    slots: { timeline: ["Messages", "TurnExecution", "ToolEvent"], composer: ["ConversationComposer"], context: ["ToolEvent"] },
    states: ["ready", "busy", "failed", "unknown", "reading-history"].map(id => ({ id, condition: "固定输入", expected: "按规则核对" })),
    conditions: { themes: ["dark"], fontSizes: [14], widthModes: ["wide"], reducedMotion: [true] },
    invariants: ["目录检查不证明运行行为"], evidence: { status: "pending", artifacts: [], gaps: ["未运行组件"] },
  };
  // 避免已有同模式页面因测试替换必需规则产生无关失败。
  for (const name of await readdir(join(root, "design-system/surfaces"))) {
    const p = join(root, "design-system/surfaces", name);
    if (JSON.parse(await readFile(p, "utf8")).pattern === "P-CONVERSATION") await rm(p);
  }
  const save = async () => {
    await writeFile(join(root, "design-system/registry.json"), JSON.stringify(registry));
    await writeFile(join(root, "design-system/surfaces/conversation-contract-check.json"), JSON.stringify(surface));
  };
  return { root, registry, pattern, surface, save };
}

test("规则引用合法且旧设置合同无需补字段", async t => {
  const f = await fixture(t); await f.save();
  const result = await verifyDesignCatalog({ root: f.root, write: true });
  assert.ok(result.surfaces >= 4);
});
test("对话合同不能遗漏模式要求的规则", async t => {
  const f = await fixture(t); delete f.surface.rules; await f.save();
  await assert.rejects(verifyDesignCatalog({ root: f.root, write: true }), /rules/);
});
test("对话合同不能发明规则ID", async t => {
  const f = await fixture(t); f.surface.rules.push("CONV-INVENTED-01"); await f.save();
  await assert.rejects(verifyDesignCatalog({ root: f.root, write: true }), /unknown rule CONV-INVENTED-01/);
});
test("目录规则必须指向唯一定义", async t => {
  const f = await fixture(t); f.pattern.rules = ["CONV-MISSING-01"]; f.surface.rules = ["CONV-MISSING-01"]; await f.save();
  await assert.rejects(verifyDesignCatalog({ root: f.root, write: true }), /CONV-MISSING-01.*definition/);
});
test("动态题不能遗漏历史阅读检查点", async t => {
  const f = await fixture(t); f.surface.states = f.surface.states.filter(item => item.id !== "reading-history"); await f.save();
  await assert.rejects(verifyDesignCatalog({ root: f.root, write: true }), /missing required state reading-history/);
});

test("交互分类不能引用不存在的生产所有者", async t => {
  const f = await fixture(t); f.registry.interactionFamilies[0].components.push("InventedControl"); await f.save();
  await assert.rejects(verifyDesignCatalog({ root: f.root, write: true }), /unknown component InventedControl/);
});
test("页面不能发明交互分类", async t => {
  const f = await fixture(t); f.surface.interactionFamilies = ["I-INVENTED"]; await f.save();
  await assert.rejects(verifyDesignCatalog({ root: f.root, write: true }), /unknown interaction family I-INVENTED/);
});

test("Base rejects an unknown promotion status", async t => {
  const f = await fixture(t); f.registry.baseCandidate.status = "released"; await f.save();
  await assert.rejects(verifyDesignCatalog({ root: f.root, write: true }), /baseCandidate.status/);
});
test("Base requires admission coverage for every member", async t => {
  const f = await fixture(t); delete f.registry.baseCandidate.admissions; await f.save();
  await assert.rejects(verifyDesignCatalog({ root: f.root, write: true }), /baseCandidate.admissions/);
});
test("Base rejects unknown and duplicate admissions", async t => {
  for (const duplicate of [false, true]) {
    const f = await fixture(t);
    const entry = f.registry.baseCandidate.admissions[0];
    f.registry.baseCandidate.admissions = [...f.registry.baseCandidate.admissions, { ...entry, id: duplicate ? "Button" : "InventedControl" }];
    await f.save();
    await assert.rejects(verifyDesignCatalog({ root: f.root, write: true }), duplicate ? /duplicate entry/ : /unknown admitted member InventedControl/);
  }
});
test("Base rejects broken contract and consumer references", async t => {
  for (const field of ["contract", "consumers"]) {
    const f = await fixture(t);
    f.registry.baseCandidate.admissions[0][field] = field === "contract" ? "renderer/src/missing-contract.md" : ["renderer/src/missing-consumer.tsx"];
    await f.save();
    await assert.rejects(verifyDesignCatalog({ root: f.root, write: true }), /missing-(contract|consumer)/);
  }
});
test("Base rejects empty finite state sets", async t => {
  const f = await fixture(t);
  f.registry.baseCandidate.admissions[0].states = []; await f.save();
  await assert.rejects(verifyDesignCatalog({ root: f.root, write: true }), /Button.states/);
});
test("A frozen Base requires an exact source revision", async t => {
  const f = await fixture(t); f.registry.baseCandidate.status = "frozen-beta";
  f.registry.baseCandidate.snapshot = { owner: "design-system/base.md", revision: null }; await f.save();
  await assert.rejects(verifyDesignCatalog({ root: f.root, write: true }), /snapshot.revision/);
});
test("Base source entry drift requires regeneration", async t => {
  const f = await fixture(t); await f.save();
  await verifyDesignCatalog({ root: f.root, write: true });
  await writeFile(join(f.root, "renderer/src/design-system/base-components.ts"), "export {};\n");
  await assert.rejects(verifyDesignCatalog({ root: f.root }), /Design catalog is stale.*base-components/);
});

test("Base rejects an omitted member and unmapped evidence", async t => {
  const missing = await fixture(t);
  missing.registry.baseCandidate.admissions = missing.registry.baseCandidate.admissions.filter(item => item.id !== "Button"); await missing.save();
  await assert.rejects(verifyDesignCatalog({ root: missing.root, write: true }), /missing admission Button/);
  const unknown = await fixture(t);
  unknown.registry.baseCandidate.admissions[0].evidence = ["E-INVENTED"]; await unknown.save();
  await assert.rejects(verifyDesignCatalog({ root: unknown.root, write: true }), /unknown evidence E-INVENTED/);
});
test("Base rejects a broken evidence anchor", async t => {
  const f = await fixture(t);
  f.registry.baseCandidate.evidence[0].report = "design-system/base.md#missing-proof"; await f.save();
  await assert.rejects(verifyDesignCatalog({ root: f.root, write: true }), /missing-proof/);
});
