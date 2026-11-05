import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { startDirect } from "@areal/workbench-service/desktop/core/remote-direct.cjs";

test("built Direct serves only the complete Remote shell with exact MIME and hashes", async () => {
  const root = new URL("../renderer/dist/", import.meta.url);
  const descriptor = JSON.parse(await readFile(new URL("remote-assets.json", root), "utf8"));
  const direct = await startDirect({
    config: { directEnabled: true, identity: "fixture" },
    backend: {},
  });
  try {
    for (const asset of [...descriptor.assets, descriptor.worker]) {
      const response = await fetch(`${direct.origin}/${asset.path}`);
      assert.equal(response.status, 200, asset.path);
      assert.equal(response.headers.get("content-type"), asset.mime);
      assert.equal(
        createHash("sha256")
          .update(Buffer.from(await response.arrayBuffer()))
          .digest("hex"),
        asset.sha256,
      );
      if (asset.path === "remote-sw.js") {
        assert.equal(response.headers.get("cache-control"), "no-cache");
        assert.equal(response.headers.get("service-worker-allowed"), "/");
      }
    }
    assert.equal((await fetch(direct.origin)).status, 200);
    const desktop = await readFile(new URL("index.html", root), "utf8");
    const desktopScript = [...desktop.matchAll(/src="([^"]+)"/g)][0][1].replace(/^\.\//, "");
    for (const path of [
      "index.html",
      desktopScript,
      "remote-assets.json",
      "remote.html?invite=secret",
      "remote.webmanifest?x=1",
      "assets/missing.js",
      "%2e%2e/package.json",
    ])
      assert.equal((await fetch(`${direct.origin}/${path}`)).status, 404, path);
    assert.equal((await fetch(`${direct.origin}/remote.html`, { method: "POST" })).status, 404);
    assert.equal((await fetch(`${direct.origin}/health`)).headers.get("cache-control"), "no-store");
  } finally {
    await new Promise((resolve) => {
      direct.server.once("close", resolve);
      direct.close();
      direct.server.closeAllConnections();
    });
  }
});
