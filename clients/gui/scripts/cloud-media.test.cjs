"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createRequire } = require("node:module");
const { buildSync } = createRequire(require.resolve("../packages/gen-ui/package.json"))("esbuild");
const compiled = buildSync({
  entryPoints: [require.resolve("../renderer/src/ComposerUploads.ts")],
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  external: ["react"],
}).outputFiles[0].text;
const exportsObject = { exports: {} };
new Function("module", "exports", "require", compiled)(
  exportsObject,
  exportsObject.exports,
  createRequire(require.resolve("../renderer/package.json")),
);
test("Cloud desktop contract admits attachment-only input and rejects local paths", () => {
  const { validateCommand } = require("../packages/workbench/client/desktop-contract.cjs");
  const params = {
    operation: "send",
    projectId: "p",
    threadId: "t",
    text: "",
    attachments: [{ type: "image", url: "areal://blob/abc" }],
  };
  assert.doesNotThrow(() => validateCommand("cloudSession", params));
  assert.throws(() => validateCommand("cloudSession", { ...params, attachments: [] }));
  assert.throws(() =>
    validateCommand("cloudSession", {
      ...params,
      attachments: [{ type: "image", url: "file:///private/image.png" }],
    }),
  );
});
