// 检测本机具备的测试能力，名字与 test-manifest.json 的 requires 一致。
// 测试选择据此把缺能力的项报成“跳过及原因”，而不是失败。
//   node clients/gui/scripts/agent-capabilities.mjs [--write <路径>]
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const gui = fileURLToPath(new URL("../", import.meta.url));
const runs = (command, args) => spawnSync(command, args, { stdio: "ignore" }).status === 0;

function nativeRuntime() {
  if (process.platform === "darwin")
    return runs("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"]);
  return (
    process.platform === "linux" &&
    runs("/usr/bin/bwrap", [
      "--unshare-all",
      "--die-with-parent",
      "--ro-bind",
      "/",
      "/",
      "--",
      "/usr/bin/true",
    ])
  );
}

function resolveFromApp(name) {
  try {
    return createRequire(resolve(gui, "app/package.json"))(name);
  } catch {
    return undefined;
  }
}

export function detectCapabilities({ env = process.env } = {}) {
  const core = env.AREAL_CORE_BIN;
  const electron = resolveFromApp("electron");
  // 下载不到与 playwright-core 匹配的浏览器时，可用 AREAL_CHROMIUM 指向已装好的 Chromium。
  const chromium =
    env.AREAL_CHROMIUM || resolveFromApp("playwright-core")?.chromium?.executablePath?.();
  // Linux 上 Electron 需要显示服务；没有 DISPLAY 时要能用 xvfb-run 包一层。
  const display = process.platform !== "linux" || !!env.DISPLAY || runs("xvfb-run", ["--help"]);
  return [
    ...(existsSync(resolve(gui, "renderer/dist/index.html")) ? ["gui-build"] : []),
    ...(core && runs(core, ["build-info"]) ? ["core-binary"] : []),
    ...(nativeRuntime() ? ["native-runtime"] : []),
    ...(typeof electron === "string" && existsSync(electron) && display ? ["electron"] : []),
    ...(chromium && existsSync(chromium) ? ["browser"] : []),
    `node-${process.versions.node}`,
    ...["git", "python3", "openssl"].filter((command) =>
      runs(command, [command === "openssl" ? "version" : "--version"]),
    ),
  ];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf("--write");
  const report = {
    platform: process.platform,
    root: process.getuid?.() === 0,
    available: detectCapabilities(),
  };
  if (index > 0) {
    const path = resolve(process.argv[index + 1]);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(report, null, 2) + "\n");
  } else console.log(JSON.stringify(report, null, 2));
}
