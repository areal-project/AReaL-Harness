import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const retired = "@areal/workbench-service";
const gui = new URL("../", import.meta.url);
assert.equal(
  existsSync(new URL("../../services/workbench", gui)),
  false,
  "The retired Node workbench directory must be absent",
);
for (const file of ["package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml"]) {
  const source = readFileSync(new URL(file, gui), "utf8");
  assert.ok(
    !source.includes(retired) && !source.includes("services/workbench"),
    `The retired Node workbench must not enter ${file}`,
  );
}
