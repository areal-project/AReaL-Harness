// 拦新增的“结果未知”来源：只有没收到答复才算未知，明确失败要带错误码返回。
// 界面里读 submissionUnknown 的地方也只减不增，新代码走 useRecoveryNotices 的统一出口，
// 由它自动核对。确实需要新增时运行 `node scripts/unknown-outcome-sources.test.mjs --write`
// 更新基线，并在 PR 里说明为什么这次失败无法判定。
import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const baselinePath = fileURLToPath(new URL("./unknown-outcome-baseline.json", import.meta.url));
const scopes = [
  ["clients/gui/renderer/src", /\.(ts|tsx)$/],
  ["clients/gui/packages/runtime-client", /\.(js|ts)$/],
  ["clients/gui/packages/client/src", /\.ts$/],
  ["services/workbench/src", /\.(cjs|ts)$/],
  ["core/host/src", /\.rs$/],
  ["core/app-server/src", /\.rs$/],
];
const skipped = /(\.test\.|_tests?\.rs$|\/tests?\/|\/generated\/|\/node_modules\/|\.d\.ts$)/;
const pattern = /submissionUnknown|SUBMISSION_UNKNOWN|"unconfirmed"/g;

function files(directory, match) {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return files(path, match);
    return match.test(entry.name) && !skipped.test(path) ? [path] : [];
  });
}

export function measure() {
  const counts = {};
  for (const [directory, match] of scopes)
    for (const file of files(directory, match)) {
      const found = readFileSync(join(root, file), "utf8").match(pattern)?.length ?? 0;
      if (found) counts[relative(root, join(root, file))] = found;
    }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

export function regressions(current, baseline) {
  return Object.entries(current)
    .filter(([file, count]) => count > (baseline[file] ?? 0))
    .map(([file, count]) => `${file}: ${baseline[file] ?? 0} -> ${count}`);
}

if (process.argv.includes("--write")) {
  writeFileSync(baselinePath, `${JSON.stringify(measure(), null, 2)}\n`);
} else {
  test("a file with no unknown-outcome handling may not start adding it", () => {
    assert.deepEqual(regressions({ "a.ts": 1, "b.ts": 2 }, { "b.ts": 2 }), ["a.ts: 0 -> 1"]);
    assert.deepEqual(regressions({ "b.ts": 1 }, { "b.ts": 2 }), []);
  });
  test("no new source of unknown outcomes", () => {
    const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
    assert.deepEqual(
      regressions(measure(), baseline),
      [],
      "新增了“结果未知”的来源或处理。明确失败请带错误码返回；界面请走 useRecoveryNotices 的统一出口。",
    );
  });
}
