"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, mkdir, writeFile, realpath, symlink, truncate, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { request } = require("node:http");
const { EventEmitter } = require("node:events");
const {
  NativeDocuments,
  DOCUMENT_HEADER,
} = require("../app/src/core/preview-native/documents.cjs");
function get(grant, path = new URL(grant.entryUrl).pathname, overrides = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(grant.origin);
    const req = request(
      {
        host: "127.0.0.1",
        port: url.port,
        path,
        headers: { host: url.host, [DOCUMENT_HEADER]: grant.privateHeader.toString("hex") },
        ...overrides,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            body: Buffer.concat(chunks).toString(),
            headers: res.headers,
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}
async function fixture(t) {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), "areal-documents-")));
  const root = join(scratch, "workspace");
  await mkdir(root);
  const documents = new NativeDocuments();
  t.after(async () => {
    await documents.dispose();
    await rm(scratch, { recursive: true, force: true });
  });
  let owner = true;
  const c = Object.assign(new EventEmitter(), {
    id: 5,
    isDestroyed: () => false,
    mainFrame: { origin: "null", isDestroyed: () => false },
  });
  const prepare = (path) =>
    documents.prepareFile({ path, workspacePath: root, valid: () => owner });
  const bind = async (path) => documents.bind(await prepare(path), c, () => owner);
  return {
    root,
    scratch,
    documents,
    c,
    prepare,
    bind,
    revokeOwner: () => {
      owner = false;
    },
  };
}
test("directory grant serves versioned HTML and only bounded canonical static assets", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "report.html"), "<h1>approved</h1>");
  await writeFile(join(f.root, "style.css"), "body{}");
  await writeFile(join(f.root, "sibling.js"), "export const value=1;");
  await writeFile(join(f.root, "other.html"), "denied");
  await writeFile(join(f.root, "data.json"), "denied");
  await writeFile(join(f.root, ".hidden.js"), "denied");
  await writeFile(join(f.scratch, "outside.js"), "denied");
  await symlink(join(f.scratch, "outside.js"), join(f.root, "escape.js"));
  await symlink(join(f.root, ".hidden.js"), join(f.root, "alias.js"));
  const grant = await f.bind("report.html");
  assert.equal(grant.prepared.scope.kind, "workspaceDirectory");
  const prefix = `/${grant.pathToken}/`;
  const entry = await get(grant);
  assert.equal(entry.status, 200);
  assert.equal(entry.body, "<h1>approved</h1>");
  assert.equal(entry.headers["cache-control"], "no-store");
  assert.match(
    entry.headers["content-security-policy"],
    /script-src 'self' 'unsafe-inline' 'unsafe-eval'/,
  );
  assert.match(entry.headers["content-security-policy"], /worker-src 'none'/);
  for (const path of ["style.css", "sibling.js"])
    assert.equal((await get(grant, prefix + path)).status, 200, path);
  for (const path of [
    "other.html",
    "data.json",
    ".hidden.js",
    "escape.js",
    "alias.js",
    "../outside.js",
    "%2e%2e/outside.js",
    "%2foutside.js",
    "%5coutside.js",
  ])
    assert.equal((await get(grant, prefix + path)).status, 403, path);
  await writeFile(join(f.root, "report.html"), "changed");
  assert.equal((await get(grant)).body, "<h1>approved</h1>");
  assert.equal((await f.prepare("report.html")).entryBytes.toString(), "changed");
  await writeFile(join(f.root, "large.js"), "");
  await truncate(join(f.root, "large.js"), 20 * 1024 * 1024 + 1);
  assert.equal((await get(grant, prefix + "large.js")).status, 403);
});
test("server rejects copied capabilities, wrong hosts, methods and token routes independently", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "report.html"), "approved");
  const grant = await f.bind("report.html");
  const host = new URL(grant.origin).host;
  assert.equal((await get(grant, undefined, { headers: { host } })).status, 403);
  assert.equal(
    (await get(grant, undefined, { headers: { host, [DOCUMENT_HEADER]: "0".repeat(64) } })).status,
    403,
  );
  assert.equal(
    (
      await get(grant, undefined, {
        headers: { host: "localhost", [DOCUMENT_HEADER]: grant.privateHeader.toString("hex") },
      })
    ).status,
    403,
  );
  assert.equal((await get(grant, undefined, { method: "POST" })).status, 403);
  assert.equal((await get(grant, "/wrong/report.html")).status, 403);
  assert.equal((await get(grant, grant.entryUrl)).status, 403);
  f.revokeOwner();
  assert.ok(
    await get(grant).then(
      (r) => r.status === 403,
      () => true,
    ),
  );
});
test("external HTML receives exact-file scope and rejects sibling assets", async (t) => {
  const f = await fixture(t);
  const path = join(f.scratch, "outside.html");
  await writeFile(path, "approved");
  await writeFile(join(f.scratch, "sibling.css"), "denied");
  const grant = await f.bind(path);
  assert.equal(grant.prepared.scope.kind, "exactHtml");
  assert.equal((await get(grant)).status, 200);
  assert.equal((await get(grant, `/${grant.pathToken}/sibling.css`)).status, 403);
  await assert.rejects(f.prepare("//server/doc.html"), /document_path_invalid/);
  await assert.rejects(f.prepare("missing.html"));
});
test("request identity allows only owned entry navigation and own main-frame resources", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "report.html"), "approved");
  const g = await f.bind("report.html");
  const request = (details) =>
    f.documents.request(f.c.id, {
      url: g.entryUrl,
      resourceType: "mainFrame",
      webContentsId: f.c.id,
      ...details,
    });
  assert.equal(request({}).allow, true);
  assert.equal(request({ url: g.entryUrl + "?mode=quiz#answer" }).allow, true);
  f.documents.committed(f.c.id, g.entryUrl + "?mode=quiz#answer");
  assert.equal(f.documents.grants.size, 1, "same-document hash/query retain the document grant");
  assert.equal(request({ webContentsId: 9 }).allow, false);
  assert.equal(request({ url: g.origin + `/${g.pathToken}/sibling.js` }).allow, false);
  f.c.mainFrame.origin = g.origin;
  assert.equal(request({}).allow, false, "active reload without frame identity is denied");
  assert.equal(request({ frame: f.c.mainFrame }).allow, true);
  assert.equal(request({ frame: { origin: g.origin, isDestroyed: () => false } }).allow, false);
  assert.equal(request({ resourceType: "script", frame: f.c.mainFrame }).allow, true);
  assert.equal(request({ resourceType: "script" }).allow, false);
  assert.equal(request({ resourceType: "subFrame", frame: f.c.mainFrame }).allow, false);
  assert.equal(
    request({ resourceType: "script", frame: { origin: g.origin, isDestroyed: () => false } })
      .allow,
    false,
  );
  assert.equal(
    request({ resourceType: "xhr", frame: f.c.mainFrame, url: "https://example.com" }).allow,
    false,
  );
  f.revokeOwner();
  assert.equal(request({}).allow, false);
  assert.equal(f.documents.grants.size, 0);
});

test("document prepare reserves the existing page slot while reading entry bytes", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "report.html"), "approved");
  f.c.getURL = () => "about:blank";
  const page = {
    id: "page",
    projectId: "project",
    threadId: "thread",
    needsObservation: false,
    controlEpoch: 1,
    documentGeneration: 1,
    pageGeneration: 1,
    plans: new Map(),
  };
  const workspace = {
    actionPage: () => ({ page, c: f.c }),
    workspaceOutstanding: () => 0,
    pageStillOwned: () => true,
    browserHostId: "host",
    hostGeneration: 1,
  };
  const request = {
    operation: "openDocument",
    parameters: { pageId: "page", path: "report.html" },
    workspacePath: f.root,
    projectId: "project",
    threadId: "thread",
    turnId: "turn",
    callId: "first",
    coreInstanceId: "core",
    coreGeneration: "generation",
  };
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const prepareFile = f.documents.prepareFile.bind(f.documents);
  f.documents.prepareFile = async (input) => {
    await gate;
    return prepareFile(input);
  };
  const first = f.documents.prepare(request, workspace, () => ({ root: f.root }));
  const second = f.documents.prepare({ ...request, callId: "second" }, workspace, () => ({
    root: f.root,
  }));
  const secondResult = second.then(
    () => null,
    (error) => error.message,
  );
  release();
  await first;
  assert.equal(await secondResult, "not_sent");
  assert.equal(page.activePrepare, false);
  assert.equal(page.plans.size, 1);
});

test("entry names that cannot pass the content route fail before a grant is created", async (t) => {
  const f = await fixture(t);
  for (const name of [".hidden.html", "report\\name.html"]) {
    await writeFile(join(f.root, name), "content");
    await assert.rejects(f.prepare(name), /document_path_invalid/);
  }
  assert.equal(f.documents.grants.size, 0);
  assert.equal(f.documents.server, null);
});
