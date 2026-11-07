import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { validateRuleDocuments } from "./design-rules.mjs";

const hash = (text) => createHash("sha256").update(text).digest("hex");
const base = () => ({
  documents: new Map([
    [
      "design/rules.md",
      '<a id="r-control-001"></a>\n\n<!-- rule:R-CONTROL-001 -->\n必须使用公共控件。\n',
    ],
  ]),
  inventory: [{ path: "design/rules.md", role: "consumer", status: "active" }],
  registry: {
    schemaVersion: 1,
    entryDocuments: ["design/rules.md"],
    entryByteLimit: 512,
    rules: [
      {
        id: "R-CONTROL-001",
        title: "公共控件",
        owner: "design/rules.md#r-control-001",
        strength: "must",
        textSha256: hash("必须使用公共控件。"),
      },
    ],
  },
});

test("canonical rule and reference resolve without mutating input", () => {
  const input = base();
  input.documents.set("design/entry.md", "[R-CONTROL-001](rules.md#r-control-001)\n");
  input.inventory.push({ path: "design/entry.md", role: "maintainer", status: "active" });
  assert.equal(validateRuleDocuments(input).rules, 1);
});

test("visible rule prefixes preserve wording hashes", () => {
  const input = base();
  input.documents.set(
    "design/rules.md",
    '<a id="r-control-001"></a>\n\n`R-CONTROL-001` 必须使用公共控件。\n',
  );
  assert.equal(validateRuleDocuments(input).rules, 1);
});

test("existing explicit IDs define a rule without a duplicate comment", () => {
  const input = base();
  input.documents.set(
    "design/rules.md",
    '<a id="r-control-001"></a>\n\n`CONV-READ-01`：必须使用公共控件。\n',
  );
  input.registry.rules[0].id = "CONV-READ-01";
  input.registry.rules[0].textSha256 = hash("`CONV-READ-01`：必须使用公共控件。");
  assert.equal(validateRuleDocuments(input).rules, 1);
});

test("component contracts keep at most ten must rules", () => {
  const input = base();
  const template = input.registry.rules[0];
  input.registry.rules = Array.from({ length: 11 }, (_, index) => ({
    ...template,
    id: `R-CONTROL-${String(index + 1).padStart(3, "0")}`,
    owner: "clients/gui/packages/ui/src/control/control.md#规则",
  }));
  assert.throws(() => validateRuleDocuments(input), /too many must rules.*11 > 10/);
});

for (const fixture of JSON.parse(
  await readFile(new URL("fixtures/design-rules/cases.json", import.meta.url), "utf8"),
)) {
  test(fixture.name, () => {
    const input = base();
    const document = input.documents.get("design/rules.md");
    switch (fixture.mutation) {
      case "empty-rule-category":
        input.registry.rules[0].id = "R--001";
        input.documents.set(
          "design/rules.md",
          document.replace("rule:R-CONTROL-001", "rule:R--001"),
        );
        break;
      case "duplicate-definition":
        input.documents.set("design/rules.md", document + document);
        break;
      case "unknown-reference":
        input.documents.set(
          "design/rules.md",
          document + "\n[R-UNKNOWN-001](rules.md#r-unknown-001)\n",
        );
        break;
      case "missing-owner":
        input.registry.rules[0].owner = "design/missing.md#r-control-001";
        break;
      case "wrong-anchor":
        input.registry.rules[0].owner = "design/rules.md#wrong";
        break;
      case "missing-strength":
        delete input.registry.rules[0].strength;
        break;
      case "duplicate-id":
        input.registry.rules.push({ ...input.registry.rules[0] });
        break;
      case "unregistered-norm":
        input.documents.set("design/rules.md", document + "\n不得重放未知提交。\n");
        break;
      case "entry-growth":
        input.registry.entryByteLimit = 10;
        break;
      case "unclassified-document":
        input.documents.set("design/other.md", "# Another document\n");
        break;
      case "missing-migration":
        input.inventory[0].status = "redirect";
        input.inventory[0].target = "design/missing.md";
        break;
      case "wording-change":
        input.documents.set(
          "design/rules.md",
          document.replace("必须使用公共控件。", "必须使用另一个控件。"),
        );
        break;
    }
    assert.throws(() => validateRuleDocuments(input), new RegExp(fixture.error));
  });
}
