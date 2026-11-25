import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../../../", import.meta.url));
const root = resolve(process.argv[3] ?? repository);
const gui = "clients/gui";
const require = createRequire(new URL("../renderer/package.json", import.meta.url));
const ts: typeof import("../renderer/node_modules/typescript/lib/typescript.js") = require("typescript");

const moduleSuffix = /\.[mc]js$/;
const testSuffix = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const sourceSuffix = /\.[cm]?[jt]sx?$/;
// 门禁引入前已进入分支、尚未进入上游的历史文件。
const existingBranchModules = new Set([
  "clients/gui/packages/browser-automation/src/host-tool-types.cjs",
  "clients/gui/packages/browser-automation/src/host-tool.cjs",
  "clients/gui/packages/client/node/desktop-upgrade.cjs",
  "clients/gui/packages/client/node/gui-source.cjs",
  "clients/gui/packages/workbench/node/application-owner.cjs",
  "clients/gui/packages/workbench/node/bundle.cjs",
  "clients/gui/packages/workbench/node/desktop-network.cjs",
  "clients/gui/packages/workbench/node/diagnostics.cjs",
  "clients/gui/packages/workbench/node/library-startup.cjs",
  "clients/gui/packages/workbench/node/model-diagnostics.cjs",
  "clients/gui/packages/workbench/node/monitoring-envelope.cjs",
  "clients/gui/packages/workbench/node/native-i18n.cjs",
  "clients/gui/packages/workbench/node/native-notifications.cjs",
  "clients/gui/packages/workbench/node/startup-timing.cjs",
  "clients/gui/packages/workbench/node/system-proxy.cjs",
  "clients/gui/scripts/design-health-report.mjs",
  "clients/gui/scripts/macos-icon.mjs",
  "clients/gui/scripts/prepare-recording.mjs",
  "clients/gui/scripts/relay-resources.cjs",
  "clients/gui/scripts/ui-guardrails-lint.mjs",
]);

function gitPaths(...args: string[]) {
  return execFileSync("git", [...args, "--", gui], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
}

function testTools() {
  const directory = resolve(root, gui);
  const scripts: Record<string, string> = JSON.parse(
    readFileSync(resolve(directory, "package.json"), "utf8"),
  ).scripts;
  const manifest: { script: string; testFiles?: string[] }[] = JSON.parse(
    readFileSync(resolve(directory, "scripts/test-manifest.json"), "utf8"),
  );
  const paths = new Set<string>();
  for (const entry of manifest) {
    if (!entry.script.startsWith("test:") || !scripts[entry.script]) continue;
    const commands = scripts[entry.script].matchAll(
      /(?:^|[\s"'])(?:\.\/)?(?:clients\/gui\/)?(scripts\/[\w./-]+\.[mc]js)(?=$|[\s"';|&])/g,
    );
    for (const [, path] of commands) {
      if (posix.normalize(path) === path) paths.add(posix.join(gui, path));
    }
    for (const path of entry.testFiles ?? []) {
      if (!/^scripts\/[\w./-]+\.[mc]js$/.test(path) || posix.normalize(path) !== path)
        throw new Error(`${entry.script}: testFiles 只能登记 scripts/ 下的具体 .mjs 或 .cjs 路径`);
      if (!existsSync(resolve(directory, path)))
        throw new Error(`${entry.script}: 找不到测试文件 ${path}`);
      paths.add(posix.join(gui, path));
    }
  }
  return paths;
}

function check(base: string) {
  const testPaths = testTools();
  const isTest = (path: string) =>
    testPaths.has(path) || testSuffix.test(path) || /\/(?:test-fixtures|__tests__)\//.test(path);
  const baseFiles = new Set(gitPaths("ls-tree", "-r", "--name-only", "-z", base));
  const hasGate = baseFiles.has(`${gui}/scripts/check-test-module-boundary.mts`);
  const files = new Set(
    gitPaths("ls-files", "--cached", "--others", "--exclude-standard", "-z").filter((path) =>
      existsSync(resolve(root, path)),
    ),
  );
  const failures = [...files]
    .filter((path) => moduleSuffix.test(path))
    .filter(
      (path) =>
        !baseFiles.has(path) &&
        !testSuffix.test(path) &&
        !testPaths.has(path) &&
        (hasGate || !existingBranchModules.has(path)),
    )
    .map(
      (path) => `${path}: 新增 .mjs/.cjs 仅限测试。请改用 TypeScript，或登记测试入口和辅助文件。`,
    );

  const options: import("../renderer/node_modules/typescript/lib/typescript.js").CompilerOptions = {
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    paths: { "@/*": [resolve(root, gui, "renderer/src/*")] },
  };
  const cache = ts.createModuleResolutionCache(root, (path) => path, options);
  for (const path of files) {
    if (isTest(path) || !sourceSuffix.test(path)) continue;
    const filename = resolve(root, path);
    const source = readFileSync(filename, "utf8");
    for (const { fileName: specifier } of ts.preProcessFile(source, true, true).importedFiles) {
      const target = specifier.startsWith(".")
        ? posix.join(posix.dirname(path), specifier)
        : ts
            .resolveModuleName(specifier, filename, options, ts.sys, cache)
            .resolvedModule?.resolvedFileName.slice(root.length + 1);
      if (target && files.has(target) && isTest(target))
        failures.push(`${path}: 非测试代码不能加载测试模块 ${target}`);
    }
  }
  return failures;
}

const base = process.argv[2];
if (!base)
  throw new Error(
    "用法：node clients/gui/scripts/check-test-module-boundary.mts <base> [repo-root]",
  );
const failures = check(base);
if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
}
