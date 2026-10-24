import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertApplicationStopped } from "./application-cleanup.mjs";

test(
  "cleanup inventory uses the native launcher without blocking the fixture server",
  { skip: process.platform === "win32", timeout: 5000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "areal-cleanup-test-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    let calls = 0;
    const server = createServer((_request, response) => {
      calls++;
      response.end(JSON.stringify([{ state: "stopped", hostPid: null, corePid: null }]));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const binary = join(root, "inventory");
    await writeFile(
      binary,
      `#!/usr/bin/python3
import os,sys,urllib.request
assert sys.argv[1:]==['service','list','--json']
with urllib.request.urlopen(os.environ['AREAL_CLEANUP_TEST_URL'],timeout=2) as response:
    print(response.read().decode())
`,
    );
    await chmod(binary, 0o700);
    await assertApplicationStopped(
      binary,
      {
        ...process.env,
        AREAL_CLEANUP_TEST_URL: `http://127.0.0.1:${server.address().port}/inventory`,
        NO_PROXY: [process.env.NO_PROXY, "127.0.0.1"].filter(Boolean).join(","),
        no_proxy: [process.env.no_proxy, "127.0.0.1"].filter(Boolean).join(","),
      },
      null,
    );
    assert.equal(calls, 1);
  },
);
