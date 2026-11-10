"use strict";
// 桌面壳能力清单与 preload、命令表保持一致；业务走 IPC 的入口只减不增。
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const gui = join(__dirname, "..");
const capabilities = require(
  join(gui, "packages/workbench/client/desktop-contract/shell-capabilities.cjs"),
);
const { commandDefinitions } = require(
  join(gui, "packages/workbench/client/desktop-contract/transport.cjs"),
);

const count = (record) =>
  Object.values(record).filter((item) => item.kind === "transitional").length;

test("preload 暴露的每个成员都已归类", () => {
  const source = readFileSync(join(gui, "app/src/core/preload.cjs"), "utf8");
  const body = source.slice(
    source.indexOf("const desktopBridge = {"),
    source.indexOf("contextBridge.exposeInMainWorld"),
  );
  const members = [...body.matchAll(/^ {2}(\w+):/gm)].map((match) => match[1]).sort();
  assert.deepEqual(members, Object.keys(capabilities.bridge).sort());
});

test("主进程自己处理的每条命令都已归类", () => {
  const main = Object.entries(commandDefinitions)
    .filter(([, definition]) => definition[0] === "main")
    .map(([name]) => name)
    .sort();
  assert.deepEqual(main, Object.keys(capabilities.mainCommands).sort());
});

test("业务走 IPC 的入口只减不增", () => {
  assert.ok(count(capabilities.bridge) <= capabilities.transitionalLimit.bridge);
  assert.ok(count(capabilities.mainCommands) <= capabilities.transitionalLimit.mainCommands);
  assert.equal(
    count(capabilities.bridge),
    capabilities.transitionalLimit.bridge,
    "迁走后把上限一起调低",
  );
  assert.equal(
    count(capabilities.mainCommands),
    capabilities.transitionalLimit.mainCommands,
    "迁走后把上限一起调低",
  );
});

test("只能在桌面窗口执行的后台操作与 desktopKeepsCommand 一致", () => {
  const source = readFileSync(join(gui, "renderer/src/host-workbench.ts"), "utf8");
  const body = source.slice(
    source.indexOf("export function desktopKeepsCommand"),
    source.indexOf("\n}\n", source.indexOf("export function desktopKeepsCommand")),
  );
  const named = new Set(
    [...body.matchAll(/"([A-Za-z]+)"/g)]
      .map((match) => match[1])
      .filter(
        (name) =>
          !["manage", "library", "settings"].includes(name) && !(name in capabilities.mainCommands),
      ),
  );
  const registered = new Set(
    Object.keys(capabilities.desktopOperations).map((key) =>
      key.split(/[.:]/).at(-1).replace("*", ""),
    ),
  );
  assert.deepEqual([...named].sort(), [...registered].sort());
  for (const item of Object.values(capabilities.desktopOperations))
    assert.equal(item.kind, "shell");
});
