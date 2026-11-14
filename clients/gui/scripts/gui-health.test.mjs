import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const cli = fileURLToPath(new URL("./gui-health.mjs", import.meta.url));
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "areal-health-test-"));
  const root = join(directory, "clients/gui");
  await mkdir(join(directory, "design"), { recursive: true });
  await writeFile(join(directory, "design/principles.md"), "# Principles\n");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const put = async (file, text) => {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), text);
  };
  await put("package.json", JSON.stringify({ scripts: { "test:one": "node one.mjs" } }));
  await put(
    "scripts/test-manifest.json",
    JSON.stringify([
      {
        script: "test:one",
        layer: "contract",
        platforms: ["darwin", "linux"],
        areas: ["health"],
        requires: [],
      },
    ]),
  );
  await put(
    "design-system/literal-baseline.json",
    JSON.stringify({ total: { color: 2, radius: 3, typography: 1 }, files: {} }),
  );
  await put("packages/ui/experimental-allowlist.json", "[]\n");
  await put(
    "design-system/accessibility-baseline.json",
    JSON.stringify({ moderateIssues: 0, contrastExceptions: [] }),
  );
  await put(
    "design-system/rule-registry.json",
    JSON.stringify({
      entryDocuments: [
        "clients/gui/packages/ui/README.md",
        "clients/gui/packages/ui/token-reference.md",
      ],
    }),
  );
  await put("packages/ui/README.md", "# UI\n");
  await put("packages/ui/token-reference.md", "# Tokens\n");
  await put("app/src/main.cjs", "module.exports = {};\n");
  await put("renderer/src/App.tsx", 'import { useState } from "react";\nuseState(1);\n');
  await put(
    "packages/ui/src/button.md",
    '---\nid: button\nlayer: core\nstatus: stable\nexports: ["Button"]\n---\n',
  );
  await put(
    "renderer/src/Consumer.tsx",
    'import { Button } from "@areal/ui";\nexport const view = <Button />;\n',
  );
  const run = (...args) =>
    spawnSync(process.execPath, [cli, "--root", root, ...args], {
      encoding: "utf8",
      env: { ...process.env, AREAL_DESIGN_BASE: "" },
    });
  return {
    root,
    put,
    run,
    baseline: async () => JSON.parse(await readFile(join(root, "health-baseline.json"), "utf8")),
  };
}

test("temporary path source audit still counts hardcoded paths", async (t) => {
  const f = await fixture(t);
  await f.put("scripts/fixture.mjs", 'export const path = "/private/tmp/case";\n');
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).metrics.privateTmpHardcodes.value, 1);
  await f.put("scripts/fixture.mjs", 'export const path = "portable";\n');
  assert.equal(JSON.parse(f.run().stdout).metrics.privateTmpHardcodes.value, 0);
});

test("JSON report counts production code and keeps report-only counts separate", async (t) => {
  const f = await fixture(t);
  await f.put("app/src/vendor/vendor.cjs", "x\n".repeat(1001));
  await f.put("app/src/core/snapshots/build/DesktopSnapShots.cjs", "x\n".repeat(1356));
  await f.put("renderer/src/generated/gen.tsx", "x\n".repeat(1001));
  await f.put("renderer/src/i18n/messages/en.ts", "x\n".repeat(1001));
  await f.put("renderer/src/design-system/preview.tsx", "x\n".repeat(1001));
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.counts.mainSourceLines, 1);
  assert.equal(report.metrics.mainSourceLines.value, report.counts.mainSourceLines);
  assert.equal(report.metrics.mainSourceLines.direction, "down");
  assert.equal(report.metrics.appLines.value, 2);
  assert.equal(report.metrics.appHooks.value, 2);
  assert.equal(report.metrics.literalDebt.value, 6);
  assert.equal(report.metrics.uiAdoptionRatio.value, 0.5);
  assert.equal(report.counts.productionTsxFiles, 2);
  assert.deepEqual(report.largeFiles, {});
});

test("down and up metrics reject regression and write only improvements", async (t) => {
  const f = await fixture(t);
  assert.equal(f.run("--write").status, 0);
  await f.put(
    "renderer/src/App.tsx",
    '// @ts-ignore\nimport { useState } from "react";\nuseState(1);\n',
  );
  const failed = f.run("--check");
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /tsIgnores/);
  assert.match(failed.stderr, /down/);
  assert.notEqual(f.run("--write").status, 0);
  assert.equal((await f.baseline()).tsIgnores.value, 0);
  assert.equal(f.run("--write", "--allow-regression=tsIgnores").status, 0);
  await f.put("renderer/src/Consumer.tsx", "export const view = <div />;\n");
  const up = f.run("--check");
  assert.notEqual(up.status, 0);
  assert.match(up.stderr, /uiAdoptionRatio/);
  assert.match(up.stderr, /up/);
});

test("one explicit exception cannot authorize another metric", async (t) => {
  const f = await fixture(t);
  assert.equal(f.run("--write").status, 0);
  await f.put("renderer/src/App.tsx", "// @ts-ignore\n// @ts-expect-error\nuseState(1);\n");
  assert.notEqual(f.run("--write", "--allow-regression=tsIgnores").status, 0);
  assert.equal((await f.baseline()).tsIgnores.value, 0);
  assert.notEqual(f.run("--write", "--allow-regression=typo").status, 0);
});

test("new 801-line production source is reported despite aggregate improvement", async (t) => {
  const f = await fixture(t);
  await f.put("packages/provider-config/Legacy.cjs", "legacy();\n".repeat(1001));
  assert.equal(f.run("--write").status, 0);
  await f.put("packages/provider-config/Legacy.cjs", "legacy();\n");
  await f.put("packages/provider-config/New.cjs", "newSource();\n".repeat(801));
  const failed = f.run("--check");
  assert.equal(failed.status, 0);
  assert.match(failed.stderr, /New\.cjs/);
  assert.match(failed.stderr, /800/);
});

test("per-path signals report growth, rename, and source restored after deletion", async (t) => {
  const f = await fixture(t);
  await f.put("packages/provider-config/Legacy.cjs", "legacy();\n".repeat(1001));
  assert.equal(f.run("--write").status, 0);
  await f.put("packages/provider-config/Legacy.cjs", "legacy();\n".repeat(1002));
  assert.equal(f.run("--check").status, 0);
  await rename(
    join(f.root, "packages/provider-config/Legacy.cjs"),
    join(f.root, "packages/provider-config/Renamed.cjs"),
  );
  assert.match(f.run("--check").stderr, /Renamed\.cjs/);
  await rm(join(f.root, "packages/provider-config/Renamed.cjs"));
  assert.equal(f.run("--write").status, 0);
  await f.put("packages/provider-config/Legacy.cjs", "legacy();\n".repeat(1001));
  assert.equal(f.run("--check").status, 0);
});

test("Main aggregate reports new small files and permits business removal", async (t) => {
  const f = await fixture(t);
  await f.put("app/src/business.cjs", "business();\n".repeat(3));
  assert.equal(f.run("--write").status, 0);
  await f.put("app/src/business.cjs", "business();\n");
  assert.equal(f.run("--write").status, 0);
  const baseline = await f.baseline();
  assert.equal(baseline.mainSourceLines.value, 2);
  await f.put("app/src/new-business.cjs", "newBusiness();\n");
  const added = f.run("--check");
  assert.equal(added.status, 0);
  assert.match(added.stderr, /mainSourceLines/);
  assert.equal(f.run("--write").status, 0);
  assert.equal((await f.baseline()).mainSourceLines.value, 3);
});

test("Main growth remains visible against base despite unused baseline headroom", async (t) => {
  const f = await fixture(t);
  await f.put("app/src/business.cjs", "business();\n".repeat(3));
  assert.equal(f.run("--write").status, 0);
  await f.put("app/src/business.cjs", "business();\n");
  const git = (...args) => spawnSync("git", args, { cwd: join(f.root, "../.."), encoding: "utf8" });
  assert.equal(git("init", "-q").status, 0);
  assert.equal(git("add", ".").status, 0);
  assert.equal(
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "-qm",
      "reduced Main",
    ).status,
    0,
  );
  const stale = f.run("--check", "--base=HEAD");
  assert.equal(stale.status, 0);
  assert.match(stale.stderr, /mainSourceLines.*baseline exceeds actual Main lines at base/);
  await f.put("app/src/business.cjs", "business();\n".repeat(2));
  const grown = f.run("--check", "--base=HEAD");
  assert.equal(grown.status, 0);
  assert.match(grown.stderr, /mainSourceLines.*Main source grew against base/);
  assert.equal(f.run("--write", "--base=HEAD").status, 0);
  assert.equal((await f.baseline()).mainSourceLines.value, 3);
});

test("an explicit base detects baseline relaxation in the same change", async (t) => {
  const f = await fixture(t);
  const git = (...args) => spawnSync("git", args, { cwd: join(f.root, "../.."), encoding: "utf8" });
  assert.equal(f.run("--write").status, 0);
  assert.equal(git("init", "-q").status, 0);
  assert.equal(git("add", ".").status, 0);
  assert.equal(
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "-qm",
      "baseline",
    ).status,
    0,
  );
  const baseline = await f.baseline();
  baseline.tsIgnores.value = 100;
  await f.put("health-baseline.json", JSON.stringify(baseline));
  const result = f.run("--check", "--base=HEAD");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /tsIgnores/);
  assert.match(result.stderr, /baseline/i);
  const head = git("rev-parse", "HEAD").stdout.trim();
  baseline.$rebaseline = { base: head, reason: "architecture move" };
  await f.put("health-baseline.json", JSON.stringify(baseline));
  assert.equal(f.run("--check", "--base=HEAD").status, 0);
  baseline.$rebaseline.base = "0".repeat(40);
  await f.put("health-baseline.json", JSON.stringify(baseline));
  assert.notEqual(f.run("--check", "--base=HEAD").status, 0);
  delete baseline.$rebaseline.reason;
  await f.put("health-baseline.json", JSON.stringify(baseline));
  assert.match(f.run("--check").stderr, /rebaseline/);
});

async function commitFixture(f) {
  const git = (...args) =>
    spawnSync("git", args, {
      cwd: join(f.root, "../.."),
      encoding: "utf8",
    });
  assert.equal(git("init", "-q").status, 0);
  assert.equal(git("add", ".").status, 0);
  const result = git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "-qm",
    "baseline",
  );
  assert.equal(result.status, 0, result.stderr);
}

test("Main business signal counts new and renamed modules and restored source", async (t) => {
  const f = await fixture(t);
  assert.equal(f.run("--write").status, 0);
  const check = () => f.run("--check", "--metric=mainBusinessLines");
  await f.put("app/src/business.cjs", "module.exports = {};\n");
  assert.match(check().stderr, /mainBusinessLines/);
  await rm(join(f.root, "app/src/business.cjs"));
  await rename(join(f.root, "app/src/main.cjs"), join(f.root, "app/src/renamed.cjs"));
  assert.equal(check().status, 0);
  await f.put("app/src/renamed.cjs", "module.exports = {};\nadded();\n");
  assert.equal(check().status, 0);
  assert.equal(f.run("--check").status, 0);
  await rm(join(f.root, "app/src/renamed.cjs"));
  await f.put("app/src/main.cjs", "");
  assert.equal(f.run("--write").status, 0);
  assert.equal((await f.baseline()).mainBusinessLines.value, 0);
  await f.put("app/src/main.cjs", "module.exports = {};\n");
  assert.equal(check().status, 0);
  await rm(join(f.root, "app/src/main.cjs"));
  assert.equal(check().status, 0);
});

test("native shell exemptions are exact paths and cannot reclassify business against base", async (t) => {
  const f = await fixture(t);
  await f.put("app/src/preload.cjs", "module.exports = {};\n");
  assert.equal(f.run("--write").status, 0);
  const baseline = await f.baseline();
  baseline.$mainNativeSources = { "app/src/preload.cjs": "Electron contextBridge adapter" };
  baseline.mainBusinessLines.value = 1;
  await f.put("health-baseline.json", JSON.stringify(baseline));
  await commitFixture(f);
  const check = () => f.run("--check", "--metric=mainBusinessLines", "--base=HEAD");
  await f.put("app/src/preload.cjs", "module.exports = {};\nadded();\n");
  const green = check();
  assert.equal(green.status, 0, green.stderr);
  const total = f.run("--check", "--metric=mainSourceLines", "--base=HEAD");
  assert.equal(total.status, 0);
  assert.match(total.stderr, /mainSourceLines/);
  assert.match(total.stderr, /Main source grew against base/);
  assert.deepEqual(JSON.parse(green.stdout).mainBusinessSources, { "app/src/main.cjs": 1 });
  baseline.$mainNativeSources["app/src/main.cjs"] = "Reclassified as native";
  baseline.mainBusinessLines.value = 0;
  await f.put("health-baseline.json", JSON.stringify(baseline));
  assert.match(check().stderr, /native exemption added against base/);
  delete baseline.$mainNativeSources["app/src/main.cjs"];
  baseline.mainBusinessLines.value = 1;
  await f.put("health-baseline.json", JSON.stringify(baseline));
  await rename(join(f.root, "app/src/preload.cjs"), join(f.root, "app/src/new-preload.cjs"));
  assert.match(check().stderr, /mainBusinessLines/);
});

for (const metric of ["mainSourceLines", "mainBusinessLines"]) {
  test(`${metric} first baseline is measured against actual current and base sources`, async (t) => {
    const f = await fixture(t);
    assert.equal(f.run("--write").status, 0);
    const baseline = await f.baseline();
    const legacy = { ...baseline };
    delete legacy.mainBusinessLines;
    delete legacy.mainSourceLines;
    delete legacy.$mainNativeSources;
    await f.put("health-baseline.json", JSON.stringify(legacy));
    await commitFixture(f);
    await f.put("health-baseline.json", JSON.stringify(baseline));
    const check = () => f.run("--check", `--metric=${metric}`, "--base=HEAD");
    assert.equal(check().status, 0);
    baseline[metric].value = 2;
    await f.put("health-baseline.json", JSON.stringify(baseline));
    assert.match(check().stderr, /initial baseline must equal actual Main lines/);
    await f.put("app/src/main.cjs", "module.exports = {};\nadded();\n");
    const grown = check();
    assert.equal(grown.status, 0);
    assert.match(grown.stderr, /Main source grew against base/);
    await f.put("app/src/main.cjs", "module.exports = {};\n");
    baseline[metric].value = 1;
    await f.put("health-baseline.json", JSON.stringify(baseline));
    assert.equal(check().status, 0);
  });

  test(`${metric} baseline increases and reused headroom remain visible against actual base`, async (t) => {
    const f = await fixture(t);
    assert.equal(f.run("--write").status, 0);
    await commitFixture(f);
    const baseline = await f.baseline();
    baseline[metric].value++;
    await f.put("health-baseline.json", JSON.stringify(baseline));
    const relaxed = f.run("--check", `--metric=${metric}`, "--base=HEAD");
    assert.equal(relaxed.status, 0);
    assert.match(relaxed.stderr, /baseline relaxed against base/);
    assert.match(relaxed.stderr, /baseline exceeds actual Main lines at base/);
    baseline[metric].value--;
    await f.put("health-baseline.json", JSON.stringify(baseline));
    await f.put("app/src/main.cjs", "");
    const git = (...args) =>
      spawnSync("git", args, { cwd: join(f.root, "../.."), encoding: "utf8" });
    assert.equal(git("add", ".").status, 0);
    assert.equal(
      git(
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.test",
        "commit",
        "-qm",
        "remove business source without refreshing cap",
      ).status,
      0,
    );
    await f.put("app/src/main.cjs", "module.exports = {};\n");
    const restored = f.run("--check", `--metric=${metric}`, "--base=HEAD");
    assert.equal(restored.status, 0);
    assert.match(restored.stderr, /Main source grew against base/);
    assert.notEqual(f.run("--write", `--metric=${metric}`).status, 0);
  });
}

test("an explicit base classifies inherited regressions without waiving the reviewed baseline", async (t) => {
  const f = await fixture(t);
  const git = (...args) => spawnSync("git", args, { cwd: join(f.root, "../.."), encoding: "utf8" });
  assert.equal(f.run("--write").status, 0);
  await f.put(
    "renderer/src/App.tsx",
    'import { useState } from "react";\nuseState(1);\n// @ts-ignore\n',
  );
  assert.equal(git("init", "-q").status, 0);
  assert.equal(git("add", ".").status, 0);
  assert.equal(
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "-qm",
      "base over budget",
    ).status,
    0,
  );
  const inherited = f.run("--check", "--base=HEAD");
  assert.notEqual(inherited.status, 0);
  assert.match(inherited.stderr, /tsIgnores.*inherited/);
  const allowed = f.run("--check", "--base=HEAD", "--allow-regression=tsIgnores");
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.deepEqual(
    JSON.parse(allowed.stdout).inheritedRegressions.map((failure) => failure.metric),
    ["appLines", "tsIgnores"],
  );
  await f.put(
    "renderer/src/App.tsx",
    'import { useState } from "react";\nuseState(1);\n// @ts-ignore\n// @ts-ignore\n',
  );
  const grown = f.run("--check", "--base=HEAD");
  assert.notEqual(grown.status, 0);
  assert.match(grown.stderr, /tsIgnores/);
  assert.doesNotMatch(grown.stderr, /inherited/);
});

test("type suppression and experimental debt are counted by their existing owners", async (t) => {
  const f = await fixture(t);
  await f.put("app/src/Boundary.cjs", "// @ts-ignore\n// @ts-expect-error\nmodule.exports = {};\n");
  await f.put(
    "packages/ui/experimental-allowlist.json",
    JSON.stringify([
      {
        file: "renderer/src/Consumer.tsx",
        symbol: "Pending",
        owner: "renderer/src/Consumer.tsx",
        exitCondition: "Remove after admission",
      },
    ]),
  );
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.metrics.tsIgnores.value, 1);
  assert.equal(report.metrics.tsExpectErrors.value, 1);
  assert.equal(report.metrics.experimentalImports.value, 1);
});

test("package root and client implementations share production caps while build tools do not", async (t) => {
  const f = await fixture(t);
  assert.equal(f.run("--write").status, 0);
  await f.put("packages/provider-config/connections.cjs", "module.exports = {};\n".repeat(801));
  await f.put("packages/workbench/client/model.js", "export {};\n".repeat(801));
  await f.put("packages/gen-ui/build.mjs", "build();\n".repeat(1001));
  await f.put("packages/runtime-client/core.d.ts", "export {};\n".repeat(1001));
  const report = JSON.parse(f.run().stdout);
  assert.equal(report.sourceLines["packages/provider-config/connections.cjs"], 801);
  assert.equal(report.sourceLines["packages/workbench/client/model.js"], 801);
  assert.equal(report.sourceLines["packages/gen-ui/build.mjs"], undefined);
  assert.equal(report.sourceLines["packages/runtime-client/core.d.ts"], undefined);
  const result = f.run("--check");
  assert.equal(result.status, 0);
  assert.match(result.stderr, /connections\.cjs/);
  assert.match(result.stderr, /client\/model\.js/);
});

test("Main coverage detects a new unchecked file even when checked file count is unchanged", async (t) => {
  const f = await fixture(t);
  await f.put("app/src/main.cjs", "// @ts-check\nmodule.exports = {};\n");
  assert.equal(f.run("--write").status, 0);
  const before = JSON.parse(f.run().stdout);
  assert.equal(before.metrics.mainTypeCoverage.value, 1);
  await f.put("app/src/new.cjs", "module.exports = {};\n");
  const after = JSON.parse(f.run().stdout);
  assert.equal(after.metrics.mainCheckedFiles.value, before.metrics.mainCheckedFiles.value);
  assert.equal(after.metrics.mainTypeCoverage.value, 0.5);
  assert.notEqual(f.run("--check").status, 0);
});

test("moving checked backend source keeps coverage enforced outside Main", async (t) => {
  const f = await fixture(t);
  await f.put("app/src/main.cjs", "// @ts-check\nmodule.exports = {};\n");
  await f.put("app/src/backend.cjs", "// @ts-check\nmodule.exports = {};\n");
  assert.equal(f.run("--write").status, 0);
  await f.put("../../services/workbench/src/desktop/core/backend.cjs", "");
  await rename(
    join(f.root, "app/src/backend.cjs"),
    join(f.root, "../../services/workbench/src/desktop/core/backend.cjs"),
  );
  const moved = JSON.parse(f.run().stdout);
  assert.equal(moved.metrics.mainCheckedFiles.value, 2);
  assert.equal(moved.metrics.mainTypeCoverage.value, 1);
  assert.equal(moved.counts.mainSourceLines, 2);
  assert.equal(f.run("--check", "--metric=mainTypeCoverage").status, 0);
  await f.put("../../services/workbench/src/desktop/core/backend.cjs", "module.exports = {};\n");
  assert.notEqual(f.run("--check", "--metric=mainTypeCoverage").status, 0);
});

test("active design document growth is tracked while the user entry has a separate ceiling", async (t) => {
  const f = await fixture(t);
  assert.equal(f.run("--write").status, 0);
  const before = JSON.parse(f.run().stdout);
  assert.ok(before.metrics.activeDesignDocBytes.value > 0);
  assert.ok(before.counts.userEntryDocBytes > 0);
  await f.put("design-system/new-rule.md", "# New rule\n");
  const after = JSON.parse(f.run().stdout);
  assert.ok(after.metrics.activeDesignDocBytes.value > before.metrics.activeDesignDocBytes.value);
  assert.equal(after.counts.userEntryDocBytes, before.counts.userEntryDocBytes);
  assert.equal(f.run("--check").status, 0);
});

test("workbench convergence counts new and renamed files and retains unrelated JS", async (t) => {
  const f = await fixture(t);
  const library = "../../services/workbench/src/desktop/core/library.cjs";
  const retained = "../../services/workbench/src/pages.cjs";
  await f.put(library, "library();\n".repeat(3));
  await f.put(retained, "pages();\n");
  assert.equal(f.run("--write").status, 0);
  const baseline = await f.baseline();
  baseline.$workbenchRetainedSources = [retained];
  baseline.workbenchConvergeLines.value = 3;
  await f.put("health-baseline.json", JSON.stringify(baseline));
  await commitFixture(f);
  const check = () => f.run("--check", "--metric=workbenchConvergeLines", "--base=HEAD");
  await f.put(retained, "pages();\n".repeat(20));
  assert.equal(check().status, 0);
  const added = "../../services/workbench/src/renamed-library.ts";
  await f.put(added, "export {};\n");
  assert.match(check().stderr, /workbenchConvergeLines/);
  assert.equal(check().status, 0);
  await rm(join(f.root, added));
  await rename(join(f.root, library), join(f.root, added));
  assert.equal(check().status, 0);
  await f.put(added, "library();\n".repeat(4));
  assert.match(check().stderr, /workbenchConvergeLines/);
  baseline.$workbenchRetainedSources.push(added);
  await f.put("health-baseline.json", JSON.stringify(baseline));
  assert.match(check().stderr, /retained exemption added against base/);
});

test("workbench first baseline measures service sources at base and prevents restored debt", async (t) => {
  const f = await fixture(t);
  const library = "../../services/workbench/src/desktop/core/library.cjs";
  await f.put(library, "library();\n");
  assert.equal(f.run("--write").status, 0);
  const baseline = await f.baseline();
  const legacy = { ...baseline };
  delete legacy.workbenchConvergeLines;
  delete legacy.$workbenchRetainedSources;
  await f.put("health-baseline.json", JSON.stringify(legacy));
  await commitFixture(f);
  await f.put("health-baseline.json", JSON.stringify(baseline));
  const check = () => f.run("--check", "--metric=workbenchConvergeLines", "--base=HEAD");
  assert.equal(check().status, 0);
  await f.put(library, "");
  assert.equal(
    check().status,
    0,
    "initial migration may shrink below the measured pre-migration budget",
  );
  await f.put(library, "library();\n");
  baseline.workbenchConvergeLines.value++;
  await f.put("health-baseline.json", JSON.stringify(baseline));
  assert.match(check().stderr, /initial baseline must equal actual workbench lines/);
  await f.put(library, "library();\n\n");
  assert.match(check().stderr, /grew against actual base/);
  await f.put(library, "");
  baseline.workbenchConvergeLines.value = 0;
  await f.put("health-baseline.json", JSON.stringify(baseline));
  await commitFixture(f);
  await f.put(library, "library();\n");
  assert.match(check().stderr, /workbenchConvergeLines/);
});

test("Main compression cannot hide growth or change the measured base", async (t) => {
  const f = await fixture(t);
  await f.put("app/src/main.cjs", "first();\nsecond();\n");
  assert.equal(f.run("--write").status, 0);
  await commitFixture(f);
  await f.put("app/src/main.cjs", "first(); second();\n");
  const same = f.run("--check", "--metric=mainSourceLines", "--base=HEAD");
  assert.equal(same.status, 0, same.stderr);
  assert.equal(JSON.parse(same.stdout).metrics.mainSourceLines.value, 2);
  await f.put("app/src/main.cjs", "first(); second(); third();\n");
  const grown = f.run("--check", "--metric=mainSourceLines", "--base=HEAD");
  assert.equal(grown.status, 0);
  assert.match(grown.stderr, /Main source grew against base/);
});

test("physical-line baseline upgrades by measuring the same base, with visible growth signals", async (t) => {
  const f = await fixture(t);
  await f.put("app/src/main.cjs", "first(); second();\n");
  assert.equal(f.run("--write").status, 0);
  const normalized = await f.baseline();
  const physical = structuredClone(normalized);
  delete physical.$mainLineCounting;
  physical.mainSourceLines.value = physical.mainBusinessLines.value = 1;
  physical.$sourceCaps["app/src/main.cjs"] = 1;
  await f.put("health-baseline.json", JSON.stringify(physical));
  await commitFixture(f);
  await f.put("health-baseline.json", JSON.stringify(normalized));
  const check = () => f.run("--check", "--base=HEAD");
  assert.equal(check().status, 0, check().stderr);
  await f.put("app/src/main.cjs", "first(); second(); third();\n");
  assert.match(check().stderr, /Main source grew against base/);
});

test("scale signals retain measured base evidence and do not hide invalid metadata", async (t) => {
  const f = await fixture(t);
  assert.equal(f.run("--write").status, 0);
  await commitFixture(f);
  await f.put("app/src/main.cjs", "first(); second(); third();\n");
  const growth = f.run("--check", "--base=HEAD");
  assert.equal(growth.status, 0, growth.stderr);
  assert.ok(
    JSON.parse(growth.stdout).signals.some(
      (signal) =>
        signal.metric === "mainSourceLines" &&
        signal.baseline === 1 &&
        signal.current === 3 &&
        signal.reason === "Main source grew against base",
    ),
  );
  const baseline = await f.baseline();
  for (const change of [
    (value) => {
      value.mainSourceLines.owner = "other";
    },
    (value) => {
      value.mainSourceLines.direction = "up";
    },
    (value) => {
      value.mainSourceLines.value = null;
    },
    (value) => {
      delete value.mainSourceLines;
    },
    (value) => {
      delete value.$sourceCaps["app/src/main.cjs"];
    },
  ]) {
    const invalid = structuredClone(baseline);
    change(invalid);
    await f.put("health-baseline.json", JSON.stringify(invalid));
    assert.notEqual(f.run("--check", "--base=HEAD").status, 0);
    assert.notEqual(
      f.run("--check", "--base=HEAD", "--allow-regression=mainSourceLines").status,
      0,
    );
  }
});
