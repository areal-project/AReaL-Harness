"use strict";
const assert = require("node:assert/strict");
const { mkdtemp, mkdir, writeFile, symlink } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { request, createServer } = require("node:http");
const { app, BrowserWindow, WebContentsView } = require("electron");
const {
  NativeDocuments,
  DOCUMENT_HEADER,
} = require("../app/src/core/preview-native/documents.cjs");
const { sharedBrowserProfile: profile } = require("../app/src/core/shared-browser-profile.cjs");
const evidence = { requests: [], server: [], assertions: [] };
const check = (name, value) => {
  assert.ok(value, name);
  evidence.assertions.push(name);
};
const raw = (url, options = {}) =>
  new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = request(
      {
        host: "127.0.0.1",
        port: target.port,
        path: target.pathname,
        headers: { host: target.host },
        ...options,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
(async () => {
  const scratch = await mkdtemp(join(tmpdir(), "areal-html-protocol-"));
  app.setPath("userData", join(scratch, "user"));
  app.commandLine.appendSwitch("no-proxy-server");
  await app.whenReady();
  const documents = new NativeDocuments();
  evidence.scratch = scratch;
  const serve = documents.serve.bind(documents);
  documents.serve = (request, response) => {
    const grant = [...documents.grants.values()].find(
      (value) => new URL(value.origin).host === request.headers.host,
    );
    response.on("finish", () =>
      evidence.server.push({
        status: response.statusCode,
        headerMatches:
          !!grant && request.headers[DOCUMENT_HEADER] === grant.privateHeader.toString("hex"),
      }),
    );
    return serve(request, response);
  };
  const window = new BrowserWindow({ show: false });
  const workspace = join(scratch, "workspace");
  await mkdir(workspace);
  await writeFile(
    join(workspace, "report.html"),
    `<!doctype html><link rel="stylesheet" href="style.css"><img id="image" src="image.svg"><a href="#answer" id="toc">Answer section</a><button id="quiz">Answer</button><output id="result"></output><script type="module" src="main.mjs"></script>`,
  );
  await writeFile(join(workspace, "style.css"), "body { background-color: rgb(1, 2, 3) }");
  await writeFile(
    join(workspace, "main.mjs"),
    "import {answer} from './answer.js'; document.querySelector('#quiz').onclick=()=>document.querySelector('#result').textContent=answer; window.moduleReady=true;",
  );
  await writeFile(join(workspace, "answer.js"), "export const answer='correct';");
  await writeFile(
    join(workspace, "image.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>',
  );
  await writeFile(join(scratch, "outside.js"), "secret");
  await symlink(join(scratch, "outside.js"), join(workspace, "escape.js"));
  await writeFile(join(workspace, ".hidden.js"), "secret");
  await writeFile(join(workspace, "second.html"), "secret");
  let owner = true;
  const pages = [0, 1].map(() => {
    const view = new WebContentsView({
      webPreferences: {
        session: profile.session,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    window.contentView.addChildView(view);
    const c = view.webContents;
    profile.registerPage({
      contents: c,
      current: () => !c.isDestroyed(),
      download: (event) => event.preventDefault(),
      documentRequest: (details) => {
        const decision = documents.request(c.id, details);
        evidence.requests.push({
          webContentsId: details.webContentsId,
          frameOrigin: details.frame?.origin ?? null,
          frameURL: details.frame?.url ?? null,
          resourceType: details.resourceType,
          mainFrame: details.frame === c.mainFrame,
          allow: decision?.allow ?? null,
          injected: !!decision?.header,
        });
        return decision;
      },
    });
    c.setWindowOpenHandler(() => ({ action: "deny" }));
    c.on("did-navigate", (_event, url) => documents.committed(c.id, url));
    return c;
  });
  const [a, b] = pages;
  const prepared = await documents.prepareFile({
    path: "report.html",
    workspacePath: workspace,
    valid: () => owner,
  });
  const grant = await documents.bind(prepared, a, () => owner);
  try {
    await a.loadURL(grant.entryUrl);
    const state = await a.executeJavaScript(
      `new Promise(resolve => { const check=()=>window.moduleReady && document.querySelector('#image').complete ? resolve({origin:location.origin,background:getComputedStyle(document.body).backgroundColor,image:document.querySelector('#image').naturalWidth,node:typeof require,bridge:typeof desktop}) : setTimeout(check, 10); check(); setTimeout(()=>resolve({timeout:true}),3000) })`,
    );
    check("origin agrees with Node", state.origin === new URL(grant.entryUrl).origin);
    check(
      "relative CSS, module import and SVG image",
      state.background === "rgb(1, 2, 3)" && state.image === 10,
    );
    check("no Node or product bridge", state.node === "undefined" && state.bridge === "undefined");
    await a.executeJavaScript("document.querySelector('#quiz').click()");
    check(
      "quiz click executes JavaScript",
      (await a.executeJavaScript("document.querySelector('#result').textContent")) === "correct",
    );
    await a.executeJavaScript(
      "document.querySelector('#toc').click();history.replaceState({},'', '?view=quiz#answer')",
    );
    documents.committed(a.id, a.getURL());
    check(
      "same-document hash/query retain asset access",
      (await a.executeJavaScript("fetch('style.css').then(r=>r.status)")) === 200,
    );
    await a.loadURL(a.getURL());
    check(
      "same-document hash/query reload retains entry",
      (await a.executeJavaScript("document.body.innerHTML")).includes('id="quiz"'),
    );
    for (const path of [
      ".hidden.js",
      "escape.js",
      "second.html",
      "data.json",
      "%2e%2e/outside.js",
      "%2foutside.js",
    ]) {
      const status = await a.executeJavaScript(
        `fetch(${JSON.stringify(new URL(path, grant.entryUrl).href)}).then(r=>r.status).catch(()=>403)`,
      );
      check(`denies resource ${path}`, status === 403);
    }
    check("copied URL without identity denied", (await raw(grant.entryUrl)).status === 403);
    check(
      "forged header denied",
      (
        await raw(grant.entryUrl, {
          headers: { host: new URL(grant.entryUrl).host, [DOCUMENT_HEADER]: "0".repeat(64) },
        })
      ).status === 403,
    );
    check(
      "wrong host denied",
      (
        await raw(grant.entryUrl, {
          headers: { host: "localhost", [DOCUMENT_HEADER]: grant.privateHeader.toString("hex") },
        })
      ).status === 403,
    );
    await b.loadURL("about:blank");
    check(
      "other page fetch cannot borrow",
      await b.executeJavaScript(
        `fetch(${JSON.stringify(grant.entryUrl)}).then(r=>r.text()).then(t=>!t.includes('id="quiz"')).catch(()=>true)`,
      ),
    );
    check(
      "other page iframe cannot read",
      await b.executeJavaScript(
        `new Promise(resolve=>{const f=document.createElement('iframe');f.onload=()=>{try{resolve(!f.contentDocument?.body.innerHTML.includes('id="quiz"'))}catch{resolve(true)}};f.src=${JSON.stringify(grant.entryUrl)};document.body.append(f);setTimeout(()=>resolve(true),1500)})`,
      ),
    );
    await b.loadURL(grant.entryUrl).catch(() => {});
    check(
      "other page navigation denied",
      !(await b.executeJavaScript("document.body.innerHTML")).includes('id="quiz"'),
    );
    const snapshot = prepared.entryBytes.toString();
    await writeFile(join(workspace, "report.html"), "changed");
    await a.loadURL(grant.entryUrl);
    check(
      "reload preserves prepared entry",
      (await a.executeJavaScript("document.body.innerHTML")).includes('id="quiz"') &&
        snapshot.includes('id="quiz"'),
    );
    let leaked = false;
    const external = createServer((req, res) => {
      leaked ||= DOCUMENT_HEADER in req.headers;
      res.end("outside");
    });
    await new Promise((resolve) => external.listen(0, "127.0.0.1", resolve));
    const away = `http://127.0.0.1:${external.address().port}/`;
    check(
      "document external fetch denied",
      await a.executeJavaScript(`fetch(${JSON.stringify(away)}).then(()=>false).catch(()=>true)`),
    );
    documents.revoke(a.id);
    check(
      "revoked old page cannot fetch entry",
      await a.executeJavaScript(
        `fetch(${JSON.stringify(grant.entryUrl)}).then(r=>r.status===403).catch(()=>true)`,
      ),
    );
    await a.loadURL(away);
    check("navigation away never leaks header", !leaked);
    check(
      "revoked URL unreadable",
      await raw(grant.entryUrl).then(
        (r) => r.status === 403,
        () => true,
      ),
    );
    await new Promise((resolve) => external.close(resolve));
    const closeGrant = await documents.bind(prepared, b, () => owner);
    await b.loadURL(closeGrant.entryUrl);
    b.close();
    check(
      "closed native page releases grant",
      await raw(closeGrant.entryUrl).then(
        (r) => r.status === 403,
        () => true,
      ),
    );
    owner = false;
    await assert.rejects(
      documents.prepareFile({ path: "report.html", workspacePath: workspace, valid: () => owner }),
    );
    check("invalid owner cannot prepare", true);
    console.log(JSON.stringify(evidence, null, 2));
  } finally {
    await documents.dispose();
    for (const c of pages) if (!c.isDestroyed()) c.close();
    window.destroy();
    app.quit();
  }
})().catch((error) => {
  console.error(error);
  app.exit(1);
});
