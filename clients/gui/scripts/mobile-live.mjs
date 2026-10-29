import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const { values } = parseArgs({ options: { target: { type: "string" } } });
if (!values.target)
  throw new Error("Pass --target <simulator-udid> from mobile:tools simulator list");
const origin = "http://127.0.0.1:5174";
const html = await (await fetch(origin)).text();
if (!html.includes(fileURLToPath(new URL("../renderer/src/mobile.ts", import.meta.url))))
  throw new Error("Run mobile:dev in this worktree before mobile:ios:live");
const run = (args) =>
  new Promise((resolve, reject) => {
    const child = spawn("pnpm", ["--dir", "clients/gui", ...args], { cwd: root, stdio: "inherit" });
    const interrupt = () => child.kill("SIGINT");
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", interrupt);
    const detach = () => {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", interrupt);
    };
    child.once("error", (error) => {
      detach();
      reject(error);
    });
    child.once("exit", (code) => {
      detach();
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Mobile command exited ${code}`));
    });
  });
// native-run 依赖旧 Simulator.app 路径；复用支持当前 Xcode 的模拟器工具部署。
await run(["mobile:sync"]);
const path = new URL("../../../clients/mobile/ios/App/App/capacitor.config.json", import.meta.url);
const original = await readFile(path, "utf8");
try {
  const config = JSON.parse(original);
  config.server.url = origin;
  await writeFile(path, JSON.stringify(config, null, 2));
  await run([
    "mobile:tools",
    "simulator",
    "build-and-run",
    "--simulator-id",
    values.target,
    "--derived-data-path",
    ".scratch/ios-development/live/derived",
    "--extra-args",
    "CODE_SIGNING_ALLOWED=YES",
    "CODE_SIGN_IDENTITY=-",
  ]);
} finally {
  // 只让本次 Debug App 含开发 URL，同步目录立即恢复成本地打包配置。
  await writeFile(path, original);
}
