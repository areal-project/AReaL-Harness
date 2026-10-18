import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
const require = createRequire(new URL("../renderer/package.json", import.meta.url));
const ts = require("typescript");
const source = await readFile(new URL("../renderer/src/side-restore.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { createSideRestore } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`
);
test("deterministic failure waits for explicit retry despite rerenders", async () => {
  const restore = createSideRestore(),
    updates = [];
  let calls = 0;
  const request = async () => {
    calls++;
    throw new Error("not found");
  };
  const update = (...state) => updates.push(state);
  await restore.load(request, update);
  for (let i = 0; i < 20; i++) await restore.load(request, update);
  assert.equal(calls, 1);
  assert.deepEqual(updates, [["loading"], ["error", "not found"]]);
  assert.equal(restore.retry(), true);
  await restore.load(async () => {
    calls++;
  }, update);
  assert.equal(calls, 2);
  assert.equal(updates.at(-1)[0], "ready");
  assert.equal(restore.retry(), false);
});
test("old owner or connection result cannot update a new target", async () => {
  const previous = createSideRestore(),
    current = createSideRestore();
  let reject;
  const old = [],
    next = [];
  const pending = previous.load(
    () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
    (...args) => old.push(args),
  );
  previous.dispose();
  await current.load(
    async () => {},
    (...args) => next.push(args),
  );
  reject(new Error("late failure"));
  await pending;
  assert.deepEqual(old, [["loading"]]);
  assert.deepEqual(next, [["loading"], ["ready"]]);
});
