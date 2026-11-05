import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { makeTempDir } from "./support/temp.mjs";
import { join } from "node:path";
import test from "node:test";

test("public UI Skills retain content scanning and do not admit private Skills", async () => {
  const root = await makeTempDir("areal-public-inventory-");
  const gui = join(root, "clients/gui");
  const put = async (path, contents) => {
    const target = join(gui, path);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, contents);
  };
  const check = () =>
    spawnSync(process.execPath, [join(gui, "scripts/verify-public.mjs")], {
      encoding: "utf8",
    });
  try {
    await mkdir(join(root, "design/tokens"), { recursive: true });
    await put(
      "scripts/verify-public.mjs",
      await readFile(new URL("./verify-public.mjs", import.meta.url)),
    );
    await put(
      "../../services/workbench/src/assets/builtin-skills/openai-skill-creator.source.json",
      JSON.stringify({ files: [] }),
    );
    for (const path of [
      "app/LICENSE",
      "renderer/ZCODE-LICENSE",
      "licenses/material-icon-theme-LICENSE",
      "THIRD-PARTY-NOTICES.md",
      "../../services/workbench/src/assets/builtin-skills/openai-skill-creator/LICENSE.txt",
      "../../services/workbench/src/assets/builtin-skills/openai-skill-creator/SKILL.md",
      "packages/ui/skills/areal-ui-guide/SKILL.md",
      "packages/ui/skills/areal-ui-critique/SKILL.md",
    ])
      await put(path, "Public distribution content\n");
    const accepted = check();
    assert.equal(accepted.status, 0, accepted.stderr);
    const unexpected = "packages/ui/skills/private/SKILL.md";
    await put(unexpected, "Private agent instructions\n");
    const rejected = check();
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /Private artifact: packages\/ui\/skills\/private\/SKILL\.md/);
    await rm(join(gui, unexpected));
    await put("packages/ui/skills/areal-ui-guide/SKILL.md", "/" + "Users/private/workspace");
    const privateValue = check();
    assert.notEqual(privateValue.status, 0);
    assert.match(
      privateValue.stderr,
      /Private source value: packages\/ui\/skills\/areal-ui-guide\/SKILL\.md/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
