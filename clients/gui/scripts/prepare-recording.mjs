import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(new URL("../app/package.json", import.meta.url));

export function prepareRecording() {
  // 只在 Playwright 连续录屏前检查并准备编码器，不作为应用构建或启动前置。
  const manifest = require.resolve("playwright-core/package.json");
  const cli = resolve(dirname(manifest), require(manifest).bin["playwright-core"]);
  execFileSync(process.execPath, [cli, "install", "ffmpeg"], {
    stdio: "inherit",
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  prepareRecording();
