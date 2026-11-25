import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveAcceptanceBinary } from "./acceptance-binary.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "acceptance-binary-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "target/debug"), { recursive: true });
  await mkdir(join(root, ".local/dev-bin"), { recursive: true });
  await mkdir(join(root, "clients/gui"), { recursive: true });
  await writeFile(join(root, "clients/gui/package.json"), JSON.stringify({ version: "0.1.20" }));
  for (const [path, version] of [
    ["target/debug/areal", "0.1.20"],
    [".local/dev-bin/areal", "0.1.8"],
  ])
    await writeFile(join(root, path), `#!/bin/sh\necho 'areal ${version}'\n`, { mode: 0o755 });
  return root;
}

test("default selects the current source build in its service-discovery location", async (t) => {
  const root = await fixture(t);
  const binary = await resolveAcceptanceBinary(root);
  assert.equal(binary, await realpath(join(root, "target/debug/areal")));
});

test("an explicitly selected old build fails before starting a Host", async (t) => {
  const root = await fixture(t);
  await assert.rejects(
    resolveAcceptanceBinary(root, join(root, ".local/dev-bin/areal")),
    /0\.1\.8.*0\.1\.20.*make build/,
  );
});
