import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { assertCurrentStateVersion } from "./persisted-state-fixture.mjs";

test("current writes follow the tested Core rather than a pinned fixture version", async () => {
  for (const stateVersion of [16, 17, 42])
    await assertCurrentStateVersion({ version: stateVersion }, async () => ({ stateVersion }));
  await assert.rejects(
    assertCurrentStateVersion({ version: 15 }, async () => ({ stateVersion: 16 })),
  );
  for (const stateVersion of [undefined, null, 0, -1, 16.5, "16"])
    await assert.rejects(
      assertCurrentStateVersion({ version: stateVersion }, async () => ({ stateVersion })),
    );
  await assert.rejects(assertCurrentStateVersion({}, async () => ({ stateVersion: 16 })));
});

test("both native current-write fixtures use the portable version contract", async () => {
  for (const name of ["plugin-smoke.mjs", "harness-smoke.mjs"]) {
    const source = await readFile(new URL(name, import.meta.url), "utf8");
    assert.match(source, /await assertCurrentStateVersion\(stored,/);
    assert.doesNotMatch(source, /assert\.equal\(stored\.version,\s*\d/);
  }
});
