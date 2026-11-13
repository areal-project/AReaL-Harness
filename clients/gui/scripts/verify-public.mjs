import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
const root = fileURLToPath(new URL("..", import.meta.url));
const skip = new Set(["node_modules", "dist", ".stage", "test-results", "playwright-report"]);
const creatorRoot = "../../services/workbench/src/assets/builtin-skills/openai-skill-creator";
const creatorManifest = JSON.parse(
  await readFile(join(root, `${creatorRoot}.source.json`), "utf8"),
);
const creatorSkill = `${creatorRoot}/SKILL.md`;
// UI 包随包分发的使用与审查指南是公开产品文档，继续参与下方内容扫描。
const publicSkills = new Set([
  creatorSkill,
  "packages/ui/skills/areal-ui-guide/SKILL.md",
  "packages/ui/skills/areal-ui-critique/SKILL.md",
]);
for (const entry of creatorManifest.files) {
  assert.ok(!entry.path.startsWith("/") && !entry.path.split("/").includes(".."));
  const bytes = await readFile(join(root, creatorRoot, entry.path));
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    entry.sha256,
    `Bundled Skill changed: ${entry.path}`,
  );
}
let files = 0;
const rendererBridgeBypasses = [];
async function scan(dir) {
  for (const item of await readdir(dir, { withFileTypes: true })) {
    if (skip.has(item.name)) continue;
    const path = join(dir, item.name),
      rel = relative(root, path);
    assert.ok(
      (publicSkills.has(rel) && item.isFile()) ||
        !/^AGENTS\.md$|^SKILL\.md$|^\.env(?:\.|$)|\.(p12|p8|mobileprovision|key)$/i.test(item.name),
      `Private artifact: ${rel}`,
    );
    assert.ok(
      ![".agents", ".codex", "research", "captures", ".git"].includes(item.name),
      `Development artifact: ${rel}`,
    );
    if (item.isDirectory()) {
      await scan(path);
      continue;
    }
    files++;
    if (
      /\.(?:[cm]?js|tsx?|css|json|yaml|md)$/.test(path) &&
      !rel.startsWith("scripts/verify-public")
    ) {
      const text = await readFile(path, "utf8");
      if (
        rel.startsWith("renderer/src/") &&
        // 与 oxlint no-renderer-desktop-bridge 一致：只有 desktop-services.ts 读 preload。
        rel !== "renderer/src/desktop-services.ts" &&
        /\barealDesktop\b/.test(text)
      )
        rendererBridgeBypasses.push(rel);
      assert.ok(
        !/\/Users\/|registry\.npmmirror|registry\.npm\.alibaba|BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/.test(
          text,
        ),
        `Private source value: ${rel}`,
      );
      assert.ok(
        rel.startsWith("scripts/") || !/@deepseek-ai\/dsh-/.test(text),
        `Legacy DSH dependency: ${rel}`,
      );
    }
  }
}
await scan(root);
await scan(join(root, "../../services/workbench/src"));
await scan(join(root, "../../design/tokens"));
assert.deepEqual(
  rendererBridgeBypasses,
  [],
  `Renderer preload access belongs to desktop-services.ts: ${rendererBridgeBypasses.join(", ")}`,
);
for (const path of [
  "app/LICENSE",
  "renderer/ZCODE-LICENSE",
  "licenses/material-icon-theme-LICENSE",
  "THIRD-PARTY-NOTICES.md",
  `${creatorRoot}/LICENSE.txt`,
])
  assert.ok((await readFile(join(root, path))).length);
console.log(
  JSON.stringify({
    passed: true,
    files,
    scope:
      "GUI and shared token public source inventory; dependency licenses retained during staging",
  }),
);
