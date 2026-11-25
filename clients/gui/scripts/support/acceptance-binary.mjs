import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

export async function resolveAcceptanceBinary(root, explicitBinary) {
  // 源码 Host 依赖 target/debug 的相对位置发现工作台服务，不能搬动可执行文件。
  const source = resolve(explicitBinary || join(root, "target/debug/areal"));
  let binary;
  try {
    binary = await realpath(source);
  } catch (error) {
    throw new Error(`Cannot find Core at ${source}; run make build first`, { cause: error });
  }
  const expected = JSON.parse(
    await readFile(join(root, "clients/gui/package.json"), "utf8"),
  ).version;
  const version = execFileSync(binary, ["--version"], { encoding: "utf8", timeout: 10000 })
    .trim()
    .replace(/^areal /, "");
  assert.equal(
    version,
    expected,
    `Core ${version} does not match GUI ${expected}; run make build and remove stale AREAL_CORE_BIN overrides`,
  );
  return binary;
}
