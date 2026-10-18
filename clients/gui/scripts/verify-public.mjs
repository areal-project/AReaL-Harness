import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
const root = fileURLToPath(new URL("..", import.meta.url));
const skip = new Set(["node_modules", "dist", ".stage", "test-results", "playwright-report"]);
let files = 0;
async function scan(dir) {
  for (const item of await readdir(dir, { withFileTypes: true })) {
    if (skip.has(item.name)) continue;
    const path = join(dir, item.name),
      rel = relative(root, path);
    assert.ok(
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
for (const path of [
  "app/LICENSE",
  "renderer/ZCODE-LICENSE",
  "licenses/material-icon-theme-LICENSE",
  "THIRD-PARTY-NOTICES.md",
])
  assert.ok((await readFile(join(root, path))).length);
console.log(
  JSON.stringify({
    passed: true,
    files,
    scope: "public source inventory; dependency licenses retained during staging",
  }),
);
