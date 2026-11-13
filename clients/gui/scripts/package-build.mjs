import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  lstat,
  readFile,
  readdir,
  readlink,
  mkdir,
  writeFile,
  rm,
  mkdtemp,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

export function createTimings() {
  const stages = [];
  return {
    stages,
    async measure(name, action) {
      const start = performance.now();
      const stage = { name, status: "failed", durationMs: 0 };
      stages.push(stage);
      try {
        const value = await action();
        stage.status = "ok";
        if (typeof value?.reused === "boolean") stage.reused = value.reused;
        return value;
      } finally {
        stage.durationMs = Math.round(performance.now() - start);
        console.log(
          `[package] ${name}: ${stage.status}, ${stage.durationMs} ms${stage.reused ? " (reused)" : ""}`,
        );
      }
    },
  };
}

export async function withStaging(action, onCleaned = () => {}) {
  const directory = await mkdtemp(join(tmpdir(), "areal-stage-"));
  try {
    return await action(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
    onCleaned();
  }
}

// 校验完整输出树，缺失、新增和字节变化都会使缓存失效；不以时间戳判定一致。
export async function treeHash(paths) {
  const hash = createHash("sha256");
  async function visit(path) {
    const info = await lstat(path);
    hash.update(`${path}\0${info.mode}\0`);
    if (info.isSymbolicLink()) hash.update(`link:${await readlink(path)}`);
    else if (info.isDirectory()) {
      for (const name of (await readdir(path)).sort()) await visit(join(path, name));
    } else hash.update(await readFile(path));
    hash.update("\0");
  }
  for (const path of [...paths].sort()) await visit(path);
  return hash.digest("hex");
}

export async function cachedBuild({ receipt, input, outputs, build }) {
  const before = await input();
  try {
    const saved = JSON.parse(await readFile(receipt, "utf8"));
    if (saved.inputHash === before && saved.outputHash === (await treeHash(outputs)))
      return { ...saved, reused: true };
  } catch (error) {
    if (!(error instanceof SyntaxError) && error.code !== "ENOENT") throw error;
  }
  await rm(receipt, { force: true });
  await build();
  if ((await input()) !== before)
    throw Error("Build inputs changed during GUI build; retry after edits settle");
  const saved = { inputHash: before, outputHash: await treeHash(outputs) };
  await mkdir(dirname(receipt), { recursive: true });
  await writeFile(receipt, JSON.stringify(saved) + "\n");
  return { ...saved, reused: false };
}

export async function guiBuildInput(root) {
  const files = execFileSync(
    "git",
    [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
      "clients/gui",
      "services/workbench",
      "services/remote-relay",
      "core/sdk-typescript",
      "runtime/sdk-typescript",
      "schemas",
      "Makefile",
    ],
    { cwd: root },
  )
    .toString()
    .split("\0");
  const hash = createHash("sha256");
  hash.update(
    JSON.stringify({
      node: process.version,
      executable: process.execPath,
      platform: process.platform,
      arch: process.arch,
      swift: execFileSync("xcrun", ["swiftc", "--version"]).toString(),
      sdk: execFileSync("xcrun", ["--show-sdk-path"]).toString(),
      env: Object.fromEntries(
        Object.entries(process.env)
          .filter(([key]) =>
            /^(VITE_|NODE_ENV$|MACOSX_DEPLOYMENT_TARGET$|SDKROOT$|DEVELOPER_DIR$)/.test(key),
          )
          .sort(),
      ),
    }),
  );
  for (const path of [...new Set(files)].filter(Boolean).sort()) {
    if (path.endsWith(".md")) continue;
    hash.update(path + "\0");
    try {
      hash.update(await readFile(join(root, path)));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      hash.update("deleted");
    }
    hash.update("\0");
  }
  return hash.digest("hex");
}
