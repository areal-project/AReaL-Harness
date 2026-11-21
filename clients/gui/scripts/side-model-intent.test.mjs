import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
const require = createRequire(new URL("../renderer/package.json", import.meta.url));
const ts = require("typescript");
const source = await readFile(
  new URL("../renderer/src/side-model-intent.ts", import.meta.url),
  "utf8",
);
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { sideStartConfiguration } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`
);
test("side start distinguishes historical inheritance, project default and explicit model", () => {
  const model = { providerId: "p", modelId: "C" };
  assert.deepEqual(sideStartConfiguration(null), {});
  assert.deepEqual(sideStartConfiguration({ model: null }), { resetModel: true });
  assert.deepEqual(sideStartConfiguration({ model }), { model });
  assert.deepEqual(sideStartConfiguration({ parameters: { temperature: 0.2 } }), {
    parameters: { temperature: 0.2 },
  });
});
