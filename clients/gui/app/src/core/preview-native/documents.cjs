// @ts-check
"use strict";
const { createServer } = require("node:http");
const { realpath, stat, open } = require("node:fs/promises");
const { constants } = require("node:fs");
const { resolve, dirname, basename, extname, relative, sep } = require("node:path");
const { randomBytes, randomUUID, createHash, timingSafeEqual } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const { loadNavigationDocument } = require("../browser-navigation.cjs");
const { preparedActionId } = require("../preview/approval.cjs");
const { observationUrl } = require("../preview/urls.cjs");
const DOCUMENT_HEADER = "x-areal-local-document";
const MAX_BYTES = 20 * 1024 * 1024;
const TYPES = new Map(
  Object.entries({
    ".css": "text/css",
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".avif": "image/avif",
    ".ico": "image/x-icon",
    ".svg": "image/svg+xml",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
  }),
);
const CSP =
  "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
/** @typedef {{kind:'exactHtml',canonicalFile:string}|{kind:'workspaceDirectory',canonicalFile:string,canonicalRoot:string}} DocumentScope */
/** @typedef {{scope:DocumentScope,entryBytes:Buffer,entryDigest:string,valid:()=>boolean}} PreparedDocument */
/** @typedef {{origin:string,pathToken:string,entryUrl:string,prepared:PreparedDocument,contents:import('electron').WebContents,valid:()=>boolean,privateHeader:Buffer,state:'loading'|'active'|'revoked',onDestroyed:()=>void}} DocumentGrant */
/** @typedef {{allow:boolean,header?:string}} DocumentRequestDecision */
/** @param {string} root @param {string} file */
function within(root, file) {
  const path = relative(root, file);
  return (
    path === "" ||
    (!path.startsWith(`..${sep}`) && path !== ".." && !require("node:path").isAbsolute(path))
  );
}
/** @param {string} path @param {()=>Promise<boolean>} valid */
async function readFileVersion(path, valid) {
  const before = await stat(path);
  if (!before.isFile() || before.size > MAX_BYTES)
    throw new Error("document_file_invalid_or_too_large");
  const source = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await source.stat();
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size > MAX_BYTES
    )
      throw new Error("document_file_changed");
    const bytes = Buffer.alloc(opened.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await source.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await source.stat();
    if (
      length !== opened.size ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs ||
      !(await valid())
    )
      throw new Error("document_file_changed");
    return bytes.subarray(0, length);
  } finally {
    await source.close();
  }
}

class NativeDocuments {
  constructor() {
    /** @type {Map<number,DocumentGrant>} */
    this.grants = new Map();
    /** @type {import('node:http').Server|null} */
    this.server = null;
    /** @type {Promise<number>|null} */
    this.starting = null;
    /** @type {Promise<void>} */
    this.closing = Promise.resolve();
    this.disposed = false;
  }
  /** @param {{path:string,workspacePath:string,valid:()=>boolean}} input @returns {Promise<PreparedDocument>} */
  async prepareFile({ path, workspacePath, valid }) {
    if (
      this.disposed ||
      !valid() ||
      !path ||
      path.length > 4096 ||
      path.includes("\0") ||
      /^[\\/]{2}/.test(path) ||
      !/\.html?$/i.test(path)
    )
      throw new Error("document_path_invalid");
    const root = await realpath(workspacePath);
    const requested = resolve(
      root,
      process.platform === "win32" ? path.replace(/^\/(?=[a-z]:[\\/])/i, "") : path,
    );
    const canonicalFile = await realpath(requested);
    if (
      !/\.html?$/i.test(canonicalFile) ||
      basename(canonicalFile).startsWith(".") ||
      basename(canonicalFile).includes("\\")
    )
      throw new Error("document_path_invalid");
    /** @type {DocumentScope} */
    const scope = within(root, canonicalFile)
      ? { kind: "workspaceDirectory", canonicalFile, canonicalRoot: dirname(canonicalFile) }
      : { kind: "exactHtml", canonicalFile };
    const entryBytes = await readFileVersion(
      canonicalFile,
      async () =>
        valid() &&
        (await realpath(requested)) === canonicalFile &&
        (await realpath(workspacePath)) === root,
    );
    if (!valid() || this.disposed) throw new Error("document_owner_changed");
    return {
      scope,
      entryBytes,
      entryDigest: createHash("sha256").update(entryBytes).digest("hex"),
      valid,
    };
  }
  /** @param {import('./model.js').Page} page @param {PreparedDocument} prepared @param {InstanceType<typeof import('./workspace.cjs').PreviewWorkspace>} workspace */
  async bindPage(page, prepared, workspace) {
    const c = page.view?.webContents;
    if (!c) throw new Error("plan_stale");
    page.document?.revoke();
    const grant = await this.bind(
      prepared,
      c,
      () => workspace.pageStillOwned(page) && page.view?.webContents === c,
    );
    page.document = {
      entryUrl: grant.entryUrl,
      matchesEntry: (url) => this.matchesEntry(grant, url),
      openExternal: async () => {
        const path = prepared.scope.canonicalFile;
        if ((await realpath(path)) !== path || !(await stat(path)).isFile() || !this.current(grant))
          throw new Error("document_owner_changed");
        const error = await require("electron").shell.openPath(path);
        if (error) throw new Error(error);
      },
      revoke: () => {
        this.revoke(c.id);
        if (page.document?.entryUrl === grant.entryUrl) page.document = null;
      },
      request: (details) => this.request(c.id, details),
      committed: (url) => this.committed(c.id, url),
    };
    return grant;
  }
  /** @param {import('./model.js').DocumentRequest} request @param {InstanceType<typeof import('./workspace.cjs').PreviewWorkspace>} workspace @param {import('./model.js').DocumentWorkspace} resolveWorkspace */
  async prepare(request, workspace, resolveWorkspace) {
    const { page, c } = workspace.actionPage(request);
    if (page.needsObservation && c.getURL() !== "about:blank") throw new Error("stale_ref");
    if (
      page.activeRead ||
      page.activePrepare ||
      page.activeAction ||
      workspace.workspaceOutstanding(page.projectId, page.threadId) >= 16
    )
      throw new Error("not_sent");
    const source = c.getURL();
    const identity = resolveWorkspace(request.projectId, request.threadId);
    if (!request.workspacePath || request.workspacePath !== identity.root)
      throw new Error("document_owner_changed");
    const epoch = page.controlEpoch,
      generation = page.documentGeneration;
    const valid = () => {
      const current = resolveWorkspace(request.projectId, request.threadId);
      return (
        workspace.pageStillOwned(page) &&
        current.root === identity.root &&
        current.executionProjectId === identity.executionProjectId
      );
    };
    page.activePrepare = true;
    try {
      const prepared = await this.prepareFile({
        path: request.parameters.path,
        workspacePath: identity.root,
        valid,
      });
      if (
        !valid() ||
        c.getURL() !== source ||
        page.controlEpoch !== epoch ||
        page.documentGeneration !== generation
      )
        throw new Error("plan_stale");
      /** @type {import('./model.js').DocumentPlan} */
      const plan = {
        preparedActionId: randomUUID(),
        operation: "openDocument",
        pageId: page.id,
        origin: new URL(source).origin,
        url: observationUrl(source),
        parameters: request.parameters,
        document: { scope: prepared.scope, entryDigest: prepared.entryDigest },
        pageGeneration: page.pageGeneration,
        documentEpoch: page.documentGeneration,
        controlEpoch: page.controlEpoch,
        browserHostId: workspace.browserHostId,
        hostGeneration: workspace.hostGeneration,
        threadId: request.threadId,
        turnId: request.turnId,
        callId: request.callId,
        expiresAt: Date.now() + 300000,
      };
      plan.fingerprint = createHash("sha256").update(JSON.stringify(plan)).digest("hex");
      page.plans.set(plan.preparedActionId, { kind: "document", plan, pageUrl: source, prepared });
      const expiry = setTimeout(() => page.plans.delete(plan.preparedActionId), 300000);
      expiry.unref();
      return { ...this.identity(request, page, workspace), plan };
    } finally {
      page.activePrepare = false;
    }
  }
  /** @param {import('./model.js').DocumentRequest} request @param {import('./model.js').Page} page @param {InstanceType<typeof import('./workspace.cjs').PreviewWorkspace>} workspace */
  identity(request, page, workspace) {
    return {
      coreInstanceId: request.coreInstanceId,
      coreGeneration: request.coreGeneration,
      projectId: request.projectId,
      threadId: request.threadId,
      turnId: request.turnId,
      callId: request.callId,
      pageId: page.id,
      browserHostId: workspace.browserHostId,
      hostGeneration: workspace.hostGeneration,
      pageGeneration: page.pageGeneration,
      controlEpoch: page.controlEpoch,
    };
  }
  /** @param {import('./model.js').DocumentRequest} request @param {InstanceType<typeof import('./workspace.cjs').PreviewWorkspace>} workspace */
  async execute(request, workspace) {
    const { page, c } = workspace.actionPage(request);
    const approval = request.browserApproval?.plan;
    const id = preparedActionId(approval);
    const candidate = id === undefined ? undefined : page.plans.get(id);
    const saved = candidate?.kind === "document" ? candidate : null;
    if (
      !saved ||
      !isDeepStrictEqual(saved.plan, approval) ||
      !isDeepStrictEqual(saved.plan.parameters, request.parameters) ||
      saved.plan.threadId !== request.threadId ||
      saved.plan.turnId !== request.turnId ||
      saved.plan.callId !== request.callId ||
      saved.plan.expiresAt < Date.now() ||
      saved.pageUrl !== c.getURL() ||
      saved.plan.pageGeneration !== page.pageGeneration ||
      saved.plan.documentEpoch !== page.documentGeneration ||
      saved.plan.controlEpoch !== page.controlEpoch ||
      !saved.prepared.valid()
    )
      throw new Error("plan_stale");
    page.plans.delete(saved.plan.preparedActionId);
    if (page.activeRead || page.activePrepare || page.activeAction) throw new Error("not_sent");
    /** @type {()=>void} */ let cancel = () => {};
    /** @type {Promise<never>} */ const stopped = new Promise((_, reject) => {
      cancel = () => reject(new Error("outcome_unknown"));
    });
    const action = {
      requestId: request.requestId,
      dispatched: false,
      cancelled: false,
      timedOut: false,
      cancel() {
        this.cancelled = true;
        cancel();
      },
    };
    page.activeAction = action;
    const timer = setTimeout(() => {
      action.timedOut = true;
      action.cancel();
    }, 12000);
    try {
      const grant = await this.bindPage(page, saved.prepared, workspace);
      if (
        action.cancelled ||
        !workspace.pageStillOwned(page) ||
        page.controlEpoch !== saved.plan.controlEpoch
      ) {
        page.document?.revoke();
        throw new Error("not_sent");
      }
      page.approvedActionNavigation = null;
      page.approvedNavigation = grant.entryUrl;
      page.url = grant.entryUrl;
      page.error = "";
      action.dispatched = true;
      const navigation = await loadNavigationDocument(c, grant.entryUrl, stopped);
      if (
        action.cancelled ||
        !workspace.pageStillOwned(page) ||
        page.controlEpoch !== saved.plan.controlEpoch
      )
        throw new Error("outcome_unknown");
      workspace.changed(page);
      return {
        ...this.identity(request, page, workspace),
        url: observationUrl(navigation.url),
        readiness: navigation.readiness,
        dispatch: "confirmed",
      };
    } catch (error) {
      page.approvedNavigation = null;
      if (action.dispatched)
        throw Object.assign(new Error("outcome_unknown", { cause: error }), {
          reason: action.timedOut ? "navigation_timeout" : "navigation_interrupted",
        });
      throw error;
    } finally {
      clearTimeout(timer);
      if (page.activeAction === action) page.activeAction = null;
    }
  }
  async listen() {
    if (this.disposed) throw new Error("document_owner_changed");
    if (this.starting) return this.starting;
    this.starting = (async () => {
      await this.closing;
      if (this.disposed) throw new Error("document_owner_changed");
      const server = createServer((request, response) => void this.serve(request, response));
      server.on("upgrade", (_request, socket) => socket.destroy());
      server.on("clientError", (_error, socket) => socket.destroy());
      server.requestTimeout = 10000;
      server.headersTimeout = 10000;
      this.server = server;
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.removeListener("error", reject);
          resolve(undefined);
        });
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("document_listener_failed");
      return address.port;
    })();
    return this.starting;
  }
  /** @param {PreparedDocument} prepared @param {import('electron').WebContents} contents @param {()=>boolean} valid */
  async bind(prepared, contents, valid) {
    this.revoke(contents.id);
    const port = await this.listen();
    if (this.disposed || !prepared.valid() || !valid() || contents.isDestroyed()) {
      this.closeIdle();
      throw new Error("document_owner_changed");
    }
    const origin = `http://${randomBytes(16).toString("hex")}.localhost:${port}`;
    const pathToken = randomBytes(16).toString("hex");
    /** @type {DocumentGrant} */
    const grant = {
      origin,
      pathToken,
      entryUrl: `${origin}/${pathToken}/${encodeURIComponent(basename(prepared.scope.canonicalFile))}`,
      prepared,
      contents,
      valid,
      privateHeader: randomBytes(32),
      state: "loading",
      onDestroyed: () => this.revoke(contents.id),
    };
    this.grants.set(contents.id, grant);
    contents.once("destroyed", grant.onDestroyed);
    return grant;
  }
  /** @param {DocumentGrant} grant */
  current(grant) {
    if (grant.state === "revoked" || this.grants.get(grant.contents.id) !== grant) return false;
    try {
      if (
        !this.disposed &&
        !grant.contents.isDestroyed() &&
        grant.valid() &&
        grant.prepared.valid()
      )
        return true;
    } catch {
      // 云端或工作树绑定变化会由可信 owner 解析器拒绝，并释放旧 grant。
    }
    this.revoke(grant.contents.id);
    return false;
  }
  /** @param {DocumentGrant} grant @param {string} value */
  matchesEntry(grant, value) {
    try {
      const url = new URL(value),
        entry = new URL(grant.entryUrl);
      return (
        url.origin === entry.origin &&
        url.pathname === entry.pathname &&
        !url.username &&
        !url.password
      );
    } catch {
      return false;
    }
  }
  /** @param {number} contentsId @param {import('../browser-network.cjs').NetworkRequest} details @returns {DocumentRequestDecision|null} */
  request(contentsId, details) {
    const grant = this.grants.get(contentsId);
    if (!grant) return null;
    try {
      if (!this.current(grant) || details.webContentsId !== contentsId) return { allow: false };
      const url = new URL(details.url);
      if (url.origin !== grant.origin || !url.pathname.startsWith(`/${grant.pathToken}/`))
        return { allow: false };
      const frame = details.frame;
      const allow =
        details.resourceType === "mainFrame"
          ? this.matchesEntry(grant, url.href) &&
            (grant.state === "loading" ||
              (!!frame &&
                !frame.isDestroyed() &&
                frame === grant.contents.mainFrame &&
                frame.origin === grant.origin))
          : !!frame &&
            !frame.isDestroyed() &&
            frame === grant.contents.mainFrame &&
            frame.origin === grant.origin &&
            !["subFrame", "webSocket"].includes(details.resourceType);
      return allow
        ? { allow: true, header: grant.privateHeader.toString("hex") }
        : { allow: false };
    } catch {
      return { allow: false };
    }
  }
  /** @param {number} contentsId @param {string} url */
  committed(contentsId, url) {
    const grant = this.grants.get(contentsId);
    if (!grant) return;
    if (this.matchesEntry(grant, url) && this.current(grant)) grant.state = "active";
    else this.revoke(contentsId);
  }
  /** @param {number} contentsId */
  revoke(contentsId) {
    const grant = this.grants.get(contentsId);
    if (!grant) return;
    this.grants.delete(contentsId);
    grant.contents.removeListener("destroyed", grant.onDestroyed);
    grant.state = "revoked";
    this.closeIdle();
  }
  closeIdle() {
    if (this.grants.size || !this.server) return;
    const server = this.server;
    this.server = null;
    this.starting = null;
    this.closing = new Promise((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
  }
  async dispose() {
    this.disposed = true;
    for (const id of this.grants.keys()) this.revoke(id);
    await this.starting?.catch(() => {});
    this.closeIdle();
    await this.closing;
  }
  /** @param {import('node:http').IncomingMessage} request @param {import('node:http').ServerResponse} response */
  async serve(request, response) {
    const reject = () => {
      if (!response.destroyed) {
        response.writeHead(403, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
        response.end("Document unavailable");
      }
    };
    try {
      const raw = request.url ?? "";
      const header = request.headers[DOCUMENT_HEADER];
      if (
        request.method !== "GET" ||
        !raw.startsWith("/") ||
        raw.startsWith("//") ||
        typeof header !== "string" ||
        !/^[0-9a-f]{64}$/.test(header) ||
        /%2f|%5c|%00|\\/i.test(raw)
      )
        return reject();
      const grant = [...this.grants.values()].find(
        (value) =>
          request.headers.host === new URL(value.origin).host &&
          raw.startsWith(`/${value.pathToken}/`),
      );
      if (
        !grant ||
        !this.current(grant) ||
        !timingSafeEqual(Buffer.from(header, "hex"), grant.privateHeader)
      )
        return reject();
      const pathname = decodeURIComponent(raw.split("?")[0]);
      const parts = pathname.slice(grant.pathToken.length + 2).split("/");
      if (
        !parts.length ||
        parts.some(
          (part) => !part || part.startsWith(".") || part.includes("\0") || part.includes("\\"),
        )
      )
        return reject();
      const scope = grant.prepared.scope;
      const isEntry = parts.length === 1 && parts[0] === basename(scope.canonicalFile);
      const mime = isEntry
        ? "text/html; charset=utf-8"
        : TYPES.get(extname(parts.at(-1) ?? "").toLowerCase());
      if (!mime || (!isEntry && scope.kind !== "workspaceDirectory")) return reject();
      let bytes;
      if (isEntry) bytes = grant.prepared.entryBytes;
      else {
        if (scope.kind !== "workspaceDirectory") return reject();
        const requested = resolve(scope.canonicalRoot, ...parts);
        const canonical = await realpath(requested);
        if (
          !within(scope.canonicalRoot, canonical) ||
          relative(scope.canonicalRoot, canonical)
            .split(sep)
            .some((part) => part.startsWith(".")) ||
          !TYPES.has(extname(canonical).toLowerCase())
        )
          return reject();
        bytes = await readFileVersion(
          canonical,
          async () =>
            this.current(grant) &&
            (await realpath(requested)) === canonical &&
            within(scope.canonicalRoot, canonical),
        );
      }
      if (!this.current(grant)) return reject();
      response.writeHead(200, {
        "Content-Type": mime,
        "Content-Length": bytes.length,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Cross-Origin-Resource-Policy": "same-origin",
        "Content-Security-Policy": CSP,
      });
      response.end(bytes);
    } catch {
      reject();
    }
  }
}
module.exports = { NativeDocuments, DOCUMENT_HEADER };
