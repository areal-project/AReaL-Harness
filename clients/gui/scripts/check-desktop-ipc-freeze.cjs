#!/usr/bin/env node
"use strict";

const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "../../..");
const contract = "clients/gui/packages/workbench/client/desktop-contract.cjs";
const modules = "clients/gui/packages/workbench/client";

function registry(file) {
  const definitions = require(file).commandDefinitions;
  return new Map(
    Object.entries(definitions).map(([name, definition]) => {
      const semantics = definition[2];
      return [
        name,
        typeof semantics.effect === "string" ? new Set() : new Set(Object.keys(semantics)),
      ];
    }),
  );
}

function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--base" || !/^[0-9a-f]{40}$/.test(args[1])) {
    throw new Error(
      "Usage: node clients/gui/scripts/check-desktop-ipc-freeze.cjs --base <40-character commit SHA>",
    );
  }
  const base = execFileSync("git", ["rev-parse", "--verify", `${args[1]}^{commit}`], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  if (base !== args[1]) throw new Error("Base must be an immutable commit SHA");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "areal-ipc-base-"));
  try {
    const archive = execFileSync("git", ["archive", base, contract, modules], {
      cwd: root,
      maxBuffer: 32 * 1024 * 1024,
    });
    const extract = spawnSync("tar", ["-xf", "-", "-C", temp], { input: archive });
    if (extract.status !== 0) throw new Error(`Cannot extract base contract: ${extract.stderr}`);
    const previous = registry(path.join(temp, contract));
    const current = registry(path.join(root, contract));
    let added = [];
    for (const [name, operations] of current) {
      if (!previous.has(name)) {
        added.push(`command ${name}`);
        continue;
      }
      for (const operation of operations) {
        if (!previous.get(name).has(operation)) added.push(`operation ${name}.${operation}`);
      }
    }
    // 与 gui-health 共用同一条一次性换基线记录：只对登记的基点放行逐条列出的名字。
    const baseline = path.join(root, "clients/gui/health-baseline.json");
    const rebaseline = fs.existsSync(baseline)
      ? JSON.parse(fs.readFileSync(baseline, "utf8")).$rebaseline
      : null;
    if (rebaseline?.base === base)
      added = added.filter((entry) => !(rebaseline.ipcAdded ?? []).includes(entry));
    if (added.length) {
      console.error(`Desktop IPC freeze violation against ${base}:\n${added.sort().join("\n")}`);
      process.exitCode = 1;
    } else {
      console.log(`Desktop IPC freeze passed against ${base}`);
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
