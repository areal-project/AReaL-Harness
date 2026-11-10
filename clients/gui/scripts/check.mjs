import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const inCI =
  process.env.GITHUB_ACTIONS === "true" || ![undefined, "", "0", "false"].includes(process.env.CI);
const base = process.env.AREAL_CHECK_BASE || process.env.AREAL_DESIGN_BASE;
assert.ok(!inCI || base, "CI requires AREAL_CHECK_BASE or AREAL_DESIGN_BASE");

const git = (args) =>
  execFileSync("git", ["--no-optional-locks", ...args], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
const revision = git([
  "rev-parse",
  "--verify",
  "--end-of-options",
  `${base || "HEAD"}^{commit}`,
]).trim();
const files = [
  ...new Set(
    [
      git([
        "diff",
        "--relative",
        "--name-only",
        "-z",
        "--no-renames",
        "--diff-filter=ACMT",
        revision,
        "--",
        ".",
      ]),
      git(["ls-files", "--others", "--exclude-standard", "-z", "--", "."]),
    ]
      .join("\0")
      .split("\0")
      .filter(Boolean),
  ),
]
  .filter((file) => lstatSync(join(root, file), { throwIfNoEntry: false })?.isFile())
  .sort()
  .map((file) => `./${file}`);

const vp = fileURLToPath(new URL("../node_modules/vite-plus/bin/vp", import.meta.url));
// 工作台服务同属本工作区，格式按它自己的 vite.config.mts；整目录检查只需一两秒。
const workbench = spawnSync(process.execPath, [vp, "fmt", "--check", "src", "test"], {
  cwd: join(root, "../../services/workbench"),
  stdio: "inherit",
});
if (workbench.status !== 0) {
  console.error("services/workbench 格式不对：pnpm --dir clients/gui run fmt:workbench");
  process.exit(workbench.status ?? 1);
}

if (files.length === 0) {
  console.log("No changed GUI files to check.");
  process.exit(0);
}

const result = spawnSync(
  process.execPath,
  [
    vp,
    "check",
    "--deny-warnings",
    "--no-error-on-unmatched-pattern",
    ...process.argv.slice(2),
    ...files,
  ],
  { cwd: root, stdio: "inherit" },
);
if (result.error) throw result.error;
if (result.signal) console.error(`vp check terminated by ${result.signal}`);
process.exit(result.status ?? 1);
