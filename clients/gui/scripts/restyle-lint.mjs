// R-CHECK-022：页面不改 @areal/ui 组件的外观。存量写进基线，只减不增。
//   node scripts/restyle-lint.mjs           检查：出现基线外的新改写就失败
//   node scripts/restyle-lint.mjs --write   重写基线（只允许删掉已修好的条目）
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const baselinePath = resolve(root, "design-system/restyle-baseline.json");
const SLOT_SELECTOR = /\[data-slot=/;

function fingerprint(seen, file, kind, snippet) {
  const identity = `${file}\0${kind}\0${snippet}`;
  const occurrence = (seen.get(identity) ?? 0) + 1;
  seen.set(identity, occurrence);
  return createHash("sha256").update(identity).update(String(occurrence)).digest("hex");
}

async function cssFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "design-system" && entry.name !== "node_modules")
        out.push(...(await cssFiles(path)));
    } else if (entry.name.endsWith(".css")) out.push(path);
  }
  return out;
}

export async function runRestyleLint(dirs = ["renderer/src"]) {
  const scratch = await mkdtemp(join(tmpdir(), "areal-restyle-"));
  const seen = new Map();
  try {
    const config = join(scratch, "oxlintrc.json");
    await writeFile(
      config,
      JSON.stringify({
        jsPlugins: [{ name: "areal", specifier: resolve(root, "oxlint-plugin-areal/index.ts") }],
        categories: { correctness: "off" },
        rules: { "areal/no-restyle": "error" },
      }),
    );
    const result = spawnSync(
      process.execPath,
      [
        resolve(root, "node_modules/vite-plus/bin/vp"),
        "lint",
        "-c",
        config,
        "--format=json",
        "--ignore-pattern=**/design-system/**",
        "--ignore-pattern=**/*.test.*",
        ...dirs,
      ],
      { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    );
    if (result.error) throw result.error;
    assert.ok([0, 1].includes(result.status), result.stderr || "restyle lint failed to execute");
    const report = JSON.parse(result.stdout);
    assert.ok(report.number_of_files > 0, "restyle lint must examine source files");
    const findings = [];
    for (const finding of report.diagnostics) {
      assert.equal(finding.code, "areal(no-restyle)", `unexpected lint rule: ${finding.code}`);
      const source = await readFile(resolve(root, finding.filename));
      const span = finding.labels[0].span;
      const snippet = source
        .subarray(span.offset, span.offset + span.length)
        .toString("utf8")
        .replace(/\s+/g, " ");
      const file = relative(root, resolve(root, finding.filename));
      findings.push({
        file,
        kind: "jsx",
        snippet,
        fingerprint: fingerprint(seen, file, "jsx", snippet),
      });
    }
    // 组件内部结构用 data-slot 标记；页面 CSS 选中它就是绕过 variant 改外观。
    for (const dir of dirs)
      for (const path of await cssFiles(resolve(root, dir))) {
        const file = relative(root, path);
        for (const line of (await readFile(path, "utf8")).split("\n")) {
          if (!SLOT_SELECTOR.test(line) || !line.includes("{")) continue;
          const snippet = line.trim();
          findings.push({
            file,
            kind: "css",
            snippet,
            fingerprint: fingerprint(seen, file, "css", snippet),
          });
        }
      }
    return findings;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export function compareRestyle(findings, baseline) {
  const admitted = new Set(baseline.map((entry) => entry.fingerprint));
  return findings.filter((finding) => !admitted.has(finding.fingerprint));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const findings = await runRestyleLint();
  const previous = await readFile(baselinePath, "utf8").then(JSON.parse, (error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (process.argv.includes("--write")) {
    if (previous) {
      const added = compareRestyle(findings, previous);
      assert.deepEqual(added, [], "--write only removes fixed entries; fix new restyles instead");
    }
    await writeFile(baselinePath, `${JSON.stringify(findings, null, 2)}\n`);
    console.log(JSON.stringify({ written: findings.length }));
  } else {
    assert.ok(previous, "missing design-system/restyle-baseline.json");
    const added = compareRestyle(findings, previous);
    assert.deepEqual(added, [], "new restyles of @areal/ui components (R-CHECK-022)");
    console.log(
      JSON.stringify({ findings: findings.length, resolved: previous.length - findings.length }),
    );
  }
}
