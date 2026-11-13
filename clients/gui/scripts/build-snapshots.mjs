import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(new URL("../packages/gen-ui/package.json", import.meta.url));
const { build, transformSync } = require("esbuild");
const gui = fileURLToPath(new URL("..", import.meta.url));
// Main 的 TypeScript 都从这里构建成 CommonJS，产物进 src 内已忽略的 build/ 或 generated/，
// 原 .cjs 照常 require 产物。新 TS 文件必须从下面某个入口可达，否则构建失败。
const results = [];
results.push(
  await build({
    metafile: true,
    absWorkingDir: gui,
    entryPoints: [
      "app/src/core/snapshots/DesktopSnapShots.ts",
      "app/src/core/snapshots/SnapShotAccessibilityWorker.ts",
    ],
    outdir: "app/src/core/snapshots/build",
    outExtension: { ".js": ".cjs" },
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["electron", "@crowecawcaw/xa11y"],
  }),
);
results.push(
  await build({
    metafile: true,
    absWorkingDir: gui,
    entryPoints: ["app/src/ipc/host-ticket.ts", "app/src/ipc/window-close.ts"],
    outdir: "app/src/ipc/generated",
    outExtension: { ".js": ".cjs" },
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["electron", "@areal/client/node"],
  }),
);
results.push(
  await build({
    metafile: true,
    absWorkingDir: gui,
    entryPoints: [
      "../../services/workbench/src/host-library-store.ts",
      "../../services/workbench/src/host-core-client.ts",
      "../../services/workbench/src/native-host-transport.ts",
    ],
    outdir: "../../services/workbench/src/generated",
    outExtension: { ".js": ".cjs" },
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["@areal/client/node"],
  }),
);
const built = new Set(results.flatMap((result) => Object.keys(result.metafile.inputs)));
const { readdirSync, readFileSync } = await import("node:fs");
const orphans = readdirSync(`${gui}/app/src`, { recursive: true })
  .map((path) => `app/src/${path}`)
  .filter((path) => path.endsWith(".ts") && !path.endsWith(".d.ts") && !built.has(path))
  // 只有类型的文件（供 JSDoc import() 引用）没有运行时产物，不需要入口。
  .filter(
    (path) =>
      transformSync(readFileSync(`${gui}/${path}`, "utf8"), { loader: "ts" }).code.trim() !== "",
  );
if (orphans.length)
  throw new Error(`Main TypeScript not reachable from a build entry: ${orphans.join(", ")}`);
