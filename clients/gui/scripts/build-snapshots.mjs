import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(new URL("../packages/gen-ui/package.json", import.meta.url));
const { build } = require("esbuild");
const gui = fileURLToPath(new URL("..", import.meta.url));
await build({
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
});
await build({
  absWorkingDir: gui,
  entryPoints: ["app/src/ipc/host-ticket.ts"],
  outdir: "app/src/ipc/build",
  outExtension: { ".js": ".cjs" },
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron", "@areal/client/node"],
});
