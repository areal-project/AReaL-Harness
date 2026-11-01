// @ts-check
"use strict";
const { captureBitmapScale } = require("../preview/geometry.cjs");
const { hasNativePage } = require("./workspace.cjs");
const { preparedActionId } = require("../preview/approval.cjs");
const { observationUrl } = require("../preview/urls.cjs");
const { sensitive, safeText } = require("../preview/diagnostics.cjs");
const {
  sensitiveCaptureScript,
  captureGuardStartScript,
  captureGuardStopScript,
} = require("../preview/capture-guard.cjs");
const { pageKey } = require("./identity.cjs");
const { randomUUID, createHash } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const { readIsolated, viewportFacts, readViewport } = require("./read-session.cjs");
const { publicNativeControl } = require("./native-targets.cjs");

const MAX_REFS = 1000;
const interactiveRoles = new Set([
  "button",
  "link",
  "textbox",
  "textfield",
  "searchbox",
  "combobox",
  "checkbox",
  "radiobutton",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "switch",
  "slider",
  "spinbutton",
  "option",
  "listbox",
]);

class BrowserReads {
  /**
   * @param {InstanceType<typeof import('./native-targets.cjs').NativePageTargets>} native_targets
   * @param {InstanceType<typeof import('./presentation.cjs').PreviewPresentation>} presentation
   * @param {InstanceType<typeof import('./workspace.cjs').PreviewWorkspace>} workspace
   * @param {(request:import("./model.js").DiagnosticsRequest) => Promise<unknown>} diagnostics
   */
  constructor(native_targets, presentation, workspace, diagnostics) {
    this.native_targets = native_targets;
    this.presentation = presentation;
    this.workspace = workspace;
    this.diagnostics = diagnostics;
  }
  /**
   * @param {import('./model.js').ReadRequest} request
   */
  prepareRead(request) {
    const { page, c } = this.workspace.actionPage(request);
    for (const [id, record] of page.plans)
      if (record.plan.expiresAt < Date.now()) page.plans.delete(id);
    if (
      page.activeRead ||
      page.activePrepare ||
      page.activeAction ||
      this.workspace.workspaceOutstanding(page.projectId, page.threadId) >= 16
    )
      throw new Error("not_sent");
    /** @type {import("./model.js").ReadPlan} */
    const plan = {
      preparedActionId: randomUUID(),
      operation: request.operation,
      pageId: page.id,
      origin: new URL(c.getURL()).origin,
      url: observationUrl(c.getURL()),
      parameters: request.parameters,
      pageGeneration: page.pageGeneration,
      documentEpoch: page.documentGeneration,
      controlEpoch: page.controlEpoch,
      browserHostId: this.workspace.browserHostId,
      hostGeneration: this.workspace.hostGeneration,
      threadId: request.threadId,
      turnId: request.turnId,
      callId: request.callId,
      expiresAt: Date.now() + 300000,
    };
    plan.fingerprint = createHash("sha256").update(JSON.stringify(plan)).digest("hex");
    page.plans.set(plan.preparedActionId, { kind: "read", plan, pageUrl: c.getURL() });
    return {
      coreInstanceId: request.coreInstanceId,
      coreGeneration: request.coreGeneration,
      projectId: request.projectId,
      threadId: request.threadId,
      turnId: request.turnId,
      callId: request.callId,
      pageId: page.id,
      browserHostId: this.workspace.browserHostId,
      hostGeneration: this.workspace.hostGeneration,
      pageGeneration: page.pageGeneration,
      controlEpoch: page.controlEpoch,
      plan,
    };
  }

  /**
   * @param {import('./model.js').ReadRequest} request
   */
  async executeRead(request) {
    const { page, c } = this.workspace.actionPage(request);
    const approval = request.browserApproval?.plan;
    const id = preparedActionId(approval);
    const candidate = id === undefined ? undefined : page.plans.get(id);
    const saved = candidate?.kind === "read" ? candidate : undefined;
    const approved = saved && isDeepStrictEqual(saved.plan, approval) ? saved.plan : undefined;
    if (
      !saved ||
      !approved ||
      !isDeepStrictEqual(saved.plan, approved) ||
      saved.pageUrl !== c.getURL() ||
      approved.operation !== request.operation ||
      approved.threadId !== request.threadId ||
      approved.turnId !== request.turnId ||
      approved.callId !== request.callId ||
      approved.expiresAt < Date.now() ||
      approved.pageGeneration !== page.pageGeneration ||
      approved.documentEpoch !== page.documentGeneration ||
      approved.controlEpoch !== page.controlEpoch ||
      !isDeepStrictEqual(approved.parameters, request.parameters)
    )
      throw new Error("plan_stale");
    page.plans.delete(approved.preparedActionId);
    return request.operation === "diagnostics" ? this.diagnostics(request) : this.observe(request);
  }

  /**
   * @param {import('./model.js').ReadRequest} request
   */
  async observe(request) {
    const {
      projectId,
      threadId,
      pageId,
      browserHostId,
      hostGeneration,
      pageGeneration,
      controlEpoch,
      coreInstanceId,
      coreGeneration,
      turnId,
      callId,
    } = request ?? {};
    const page = this.workspace.page(projectId, threadId, pageId);
    if (
      browserHostId !== this.workspace.browserHostId ||
      hostGeneration !== this.workspace.hostGeneration ||
      !page ||
      coreInstanceId !== page.coreInstanceId ||
      page.id !== pageId ||
      page.pageGeneration !== pageGeneration ||
      !this.workspace.owns(projectId, threadId)
    )
      throw new Error("Browser page identity is stale");
    if (page.control !== "agent" || page.controlEpoch !== controlEpoch)
      throw new Error("Human controls this page");
    const c = page.view?.webContents;
    if (!c || !hasNativePage(page)) throw new Error("Browser page is unavailable");
    if (page.crashed || c.isDestroyed() || c.isDevToolsOpened())
      throw new Error("Browser page is unavailable");
    if (page.activeRead || page.activePrepare || page.activeAction)
      throw new Error("Browser page is busy");
    const epoch = page.controlEpoch,
      documentGeneration = page.documentGeneration;
    /** @type {(reason?:string)=>void} */
    let cancel = () => {};
    const invalidation = () =>
      page.control !== "agent" || page.controlEpoch !== epoch ? "human_control" : "plan_stale";
    /** @type {Promise<never>} */
    const cancelled = new Promise((_, reject) => {
      cancel = (reason) => reject(new Error(reason ?? invalidation()));
    });
    const read = { requestId: request.requestId, cancel };
    page.activeRead = read;
    const timer = setTimeout(() => cancel("condition_timeout"), 10000);
    try {
      if (!c.debugger.isAttached()) c.debugger.attach("1.3");
      const operation = request.operation;
      if (operation !== "observe" && operation !== "capture")
        throw new Error("Unsupported browser operation");
      if (operation === "capture") {
        const bounds = page.view.getBounds();
        if (
          !this.presentation.window.isVisible() ||
          this.presentation.window.isMinimized() ||
          !page.view.getVisible() ||
          !page.requestedVisible ||
          this.presentation.owner !== pageKey(page.coreInstanceId, projectId, threadId, pageId) ||
          bounds.width <= 0 ||
          bounds.height <= 0
        )
          throw new Error("Browser viewport unavailable");
      }
      const parameters = request.parameters ?? {};
      /** @type {import("./model.js").CdpResult<"Accessibility.getFullAXTree">|null} */
      const tree =
        operation === "observe"
          ? await Promise.race([c.debugger.sendCommand("Accessibility.getFullAXTree"), cancelled])
          : null;
      /** @type {import("./model.js").CdpResult<"Page.getFrameTree">|null} */
      const frames =
        operation === "observe"
          ? await Promise.race([c.debugger.sendCommand("Page.getFrameTree"), cancelled])
          : null;
      const viewport = await Promise.race([readViewport(c), cancelled]);
      if (
        ![
          viewport.width,
          viewport.height,
          viewport.scrollX,
          viewport.scrollY,
          viewport.deviceScaleFactor,
        ].every(Number.isFinite) ||
        viewport.width <= 0 ||
        viewport.height <= 0 ||
        viewport.deviceScaleFactor <= 0
      )
        throw new Error("Browser viewport unavailable");
      const facts = viewportFacts(this.presentation.window, page, viewport);
      const viewportKey = facts.key;
      if (page.viewportKey !== viewportKey) {
        page.viewportKey = viewportKey;
        page.viewportRevision++;
      }
      if (
        !this.workspace.pageStillOwned(page) ||
        page.control !== "agent" ||
        page.controlEpoch !== epoch ||
        page.documentGeneration !== documentGeneration ||
        c.isDestroyed()
      )
        throw new Error(invalidation());
      const base = {
        observationId: randomUUID(),
        coreInstanceId,
        coreGeneration,
        projectId,
        threadId,
        turnId,
        callId,
        pageId,
        browserHostId,
        hostGeneration,
        pageGeneration,
        nativeWebContentsId: c.id,
        url: observationUrl(c.getURL()),
        title: safeText(c.getTitle(), 256),
        documentEpoch: documentGeneration,
        controlEpoch: epoch,
        capturedAt: new Date().toISOString(),
        scope: operation === "capture" ? "viewport" : (parameters.scope ?? "document"),
        viewport: {
          ...viewport,
          pageZoom: facts.pageZoom,
          guiZoom: facts.guiZoom,
          nativeBounds: facts.nativeBounds,
          viewportRevision: page.viewportRevision,
        },
      };
      if (operation === "capture") {
        // A known sensitive form or a DOM change during capture cannot be safely represented unmasked.
        const guardToken = randomUUID();
        const guardSequence = (page.nextGuardSequence = (page.nextGuardSequence ?? 0) + 1);
        let image, postSensitive;
        /** @type {unknown} */
        let changed = true;
        try {
          const watching = await Promise.race([
            readIsolated(c, captureGuardStartScript(guardToken, guardSequence)),
            cancelled,
          ]);
          if (watching !== true) throw new Error("Browser capture guard unavailable");
          const hasSensitive = await Promise.race([
            readIsolated(c, sensitiveCaptureScript()),
            cancelled,
          ]);
          if (typeof hasSensitive !== "boolean")
            throw new Error("Browser sensitive-field check unavailable");
          if (hasSensitive) throw new Error("Sensitive field prevents automatic screenshot");
          image = await Promise.race([c.capturePage(), cancelled]);
          if (
            !this.workspace.pageStillOwned(page) ||
            page.control !== "agent" ||
            page.controlEpoch !== epoch ||
            page.documentGeneration !== documentGeneration
          )
            throw new Error(invalidation());
          postSensitive = await Promise.race([
            readIsolated(c, sensitiveCaptureScript()),
            cancelled,
          ]);
        } finally {
          if (page.control === "agent" && page.controlEpoch === epoch)
            changed = await Promise.race([
              readIsolated(c, captureGuardStopScript(guardToken, guardSequence)).catch(() => true),
              new Promise((resolve) => setTimeout(() => resolve(true), 1000)),
            ]);
        }
        if (postSensitive !== false || changed !== false)
          throw new Error("Browser content changed during capture");
        const currentViewport = await Promise.race([readViewport(c), cancelled]);
        if (
          viewportFacts(this.presentation.window, page, currentViewport).key !== viewportKey ||
          !this.presentation.window.isVisible() ||
          this.presentation.window.isMinimized() ||
          !page.view.getVisible() ||
          !page.requestedVisible ||
          this.presentation.owner !== pageKey(page.coreInstanceId, projectId, threadId, pageId)
        )
          throw new Error("Browser viewport changed during capture");
        const size = image.getSize();
        const bitmapScale = captureBitmapScale(facts, size);
        if (
          size.width <= 0 ||
          size.height <= 0 ||
          size.width * size.height > 8_000_000 ||
          size.width > 4096 ||
          size.height > 4096
        )
          throw new Error("Screenshot pixel budget exceeded");
        const png = image.toPNG();
        if (png.length > 2 * 1024 * 1024) throw new Error("Screenshot byte budget exceeded");
        if (
          !this.workspace.pageStillOwned(page) ||
          page.control !== "agent" ||
          page.controlEpoch !== epoch
        )
          throw new Error(invalidation());
        page.observedViewportKey = viewportKey;
        page.lastObservation = base.observationId;
        page.lastObservationTurnId = turnId;
        page.lastCapture = {
          observationId: base.observationId,
          pageGeneration: page.pageGeneration,
          documentEpoch: documentGeneration,
          controlEpoch: epoch,
          viewportRevision: page.viewportRevision,
          viewportKey,
          url: c.getURL(),
          width: viewport.width,
          height: viewport.height,
          bitmapWidth: size.width,
          bitmapHeight: size.height,
          bitmapScale,
        };
        page.needsObservation = false;
        return {
          ...base,
          capturedAt: new Date().toISOString(),
          viewport: {
            ...base.viewport,
            bitmapWidth: size.width,
            bitmapHeight: size.height,
            bitmapScale,
          },
          mimeType: "image/png",
          imageBase64: png.toString("base64"),
          byteLength: png.length,
        };
      }
      if (!tree || !frames) throw new Error("Browser accessibility snapshot unavailable");
      /** @type {string[]} */
      const lines = [];
      /** @type {import("./model.js").ObservationEntry[]} */
      const entries = [];
      /** @type {import("./model.js").AxNode[]} */
      const nodes = [];
      const rawNodes = tree.nodes ?? [];
      const nodesById = new Map(rawNodes.map((node) => [node.nodeId, node])),
        visitedNodes = new Set();
      // 原生数组可按增量分配次序返回；预算按 AX 父子阅读顺序裁剪，避免顶部控件被尾部索引遗漏。
      /** @param {import("./model.js").AxNode} root */
      const appendTree = (root) => {
        const pending = [root];
        while (pending.length) {
          const node = pending.pop();
          if (!node || visitedNodes.has(node.nodeId)) continue;
          visitedNodes.add(node.nodeId);
          nodes.push(node);
          for (const id of [...(node.childIds ?? [])].reverse()) {
            const child = nodesById.get(id);
            if (child) pending.push(child);
          }
        }
      };
      for (const node of rawNodes)
        if (!node.parentId || !nodesById.has(node.parentId)) appendTree(node);
      for (const node of rawNodes) appendTree(node);
      const liveIdentities = new Set(
        nodes
          .filter((node) => node.backendDOMNodeId)
          .map((node) =>
            JSON.stringify([
              page.pageGeneration,
              documentGeneration,
              epoch,
              node.frameId ?? "main",
              node.backendDOMNodeId,
            ]),
          ),
      );
      const requestedIdentity =
        parameters.rootRef && [...page.refs].find(([, ref]) => ref === parameters.rootRef)?.[0];
      if (parameters.rootRef && !requestedIdentity) throw new Error("stale_ref");
      const requestedBackend = requestedIdentity && JSON.parse(requestedIdentity)[4];
      const rootNode =
        requestedBackend && nodes.find((node) => node.backendDOMNodeId === requestedBackend);
      if (parameters.rootRef && !rootNode) throw new Error("stale_ref");
      const parent = new Map(nodes.map((node) => [node.nodeId, node.parentId]));
      /** @param {import("./model.js").AxNode} node */
      const descendant = (node) => {
        /** @type {string|undefined} */
        let id = node.nodeId;
        for (; id; id = parent.get(id)) if (id === rootNode?.nodeId) return true;
        return false;
      };
      const sensitiveNodes = new Set(
        nodes
          .filter(
            (node) =>
              /passwordField/i.test(String(node.role?.value ?? "")) ||
              sensitive.test(String(node.name?.value ?? "")) ||
              (/textField|textbox|searchbox|comboBox/i.test(String(node.role?.value ?? "")) &&
                (node.properties ?? []).some(
                  (property) =>
                    sensitive.test(String(property.name)) ||
                    sensitive.test(String(property.value?.value)),
                )),
          )
          .map((node) => node.nodeId),
      );
      const fieldNodes = new Set(
        nodes
          .filter((node) =>
            /^(textField|passwordField|textbox|searchbox|comboBox)$/i.test(
              String(node.role?.value ?? ""),
            ),
          )
          .map((node) => node.nodeId),
      );
      /** @param {import("./model.js").AxNode} node */
      const sensitiveChild = (node) => {
        for (let id = node.parentId; id; id = parent.get(id))
          if (sensitiveNodes.has(id)) return true;
        return false;
      };
      /** @param {import("./model.js").AxNode} node */
      const fieldChild = (node) => {
        for (let id = node.parentId; id; id = parent.get(id)) if (fieldNodes.has(id)) return true;
        return false;
      };
      const searchIntent = page.approvedActionNavigation,
        publicSearchFields = new Set();
      // 只豁免已批准且实际到达当前结果页的搜索字段；字段值及其子树仍不向模型投影。
      // 重用隔离世界的 GET/敏感表单判据，未知字段或同值私密字段继续污染回显集合。
      if (
        searchIntent?.kind === "public_search" &&
        searchIntent.controlEpoch === epoch &&
        searchIntent.pageGeneration === page.pageGeneration &&
        (searchIntent.expiresAt ?? -Infinity) >= Date.now()
      ) {
        const destination = new URL(c.getURL());
        const queries = new URLSearchParams(searchIntent.submittedFields).getAll(
          searchIntent.queryName,
        );
        if (
          destination.origin === searchIntent.targetOrigin &&
          destination.pathname === searchIntent.targetPath &&
          queries.length &&
          isDeepStrictEqual(destination.searchParams.getAll(searchIntent.queryName), queries)
        ) {
          for (const node of nodes) {
            if (
              !fieldNodes.has(node.nodeId) ||
              sensitiveNodes.has(node.nodeId) ||
              sensitiveChild(node) ||
              !node.backendDOMNodeId ||
              String(node.value?.value ?? "") !== searchIntent.query
            )
              continue;
            const semantics = await Promise.race([
              this.native_targets
                .publicActionSemantics(
                  page,
                  c,
                  { backendNodeId: node.backendDOMNodeId },
                  { kind: "press", key: "Enter" },
                  true,
                )
                .catch(() => null),
              cancelled,
            ]);
            if (
              semantics?.kind === "public_search" &&
              semantics.method === "GET" &&
              semantics.query === searchIntent.query &&
              semantics.queryName === searchIntent.queryName &&
              semantics.targetOrigin === searchIntent.targetOrigin &&
              semantics.targetPath === searchIntent.targetPath &&
              isDeepStrictEqual(
                new URLSearchParams(semantics.submittedFields).getAll(semantics.queryName),
                queries,
              )
            )
              publicSearchFields.add(node.nodeId);
          }
        }
        if (
          page.approvedActionNavigation !== searchIntent ||
          (searchIntent.expiresAt ?? Infinity) < Date.now()
        )
          publicSearchFields.clear();
      }
      if (
        !this.workspace.pageStillOwned(page) ||
        page.control !== "agent" ||
        page.controlEpoch !== epoch ||
        page.documentGeneration !== documentGeneration ||
        c.isDestroyed()
      )
        throw new Error(invalidation());
      const fieldValues = [
        ...new Set(
          nodes
            .filter((node) => fieldNodes.has(node.nodeId) && !publicSearchFields.has(node.nodeId))
            .map((node) => String(node.value?.value ?? ""))
            .filter(Boolean),
        ),
      ];
      /** @param {string} text */
      const fieldEcho = (text) =>
        fieldValues.some((value) => text === value || (value.length >= 3 && text.includes(value)));
      const limitNodes = parameters.budget?.nodes ?? 200;
      const limitBytes = parameters.budget?.textBytes ?? 32 * 1024;
      /** @type {Map<string,string>} */
      const nextRefs = new Map();
      /** @type {Map<string,import("./model.js").NativeControl>} */
      const nextNativeControls = new Map();
      page.optionIds.clear();
      /** @type {Map<string,string>} */
      const entryByNodeId = new Map();
      let textBytes = 0,
        truncated = false;
      for (const node of nodes) {
        if (node.ignored) continue;
        const role = String(node.role?.value ?? "").slice(0, 80);
        const rawName = String(node.name?.value ?? "");
        const propertySensitive = (node.properties ?? []).some(
          (property) =>
            sensitive.test(String(property.name)) || sensitive.test(String(property.value?.value)),
        );
        const sensitiveNode =
          sensitiveNodes.has(node.nodeId) || sensitiveChild(node) || propertySensitive;
        const concealed = sensitiveNode || fieldChild(node) || fieldEcho(rawName);
        // 隐私集合已覆盖完整 AX 树；只在最终投影省略无信息结构和逐字重复的行内文本。
        // 带名称、状态、值、描述或 Frame 身份的节点保留，父关联仍指向最近已输出祖先。
        const metadata =
          node.frameId ||
          String(node.value?.value ?? "") ||
          String(node.description?.value ?? "") ||
          (node.properties ?? []).length;
        const nativeParent = node.parentId ? nodesById.get(node.parentId) : undefined;
        if (
          !concealed &&
          !metadata &&
          ((role === "generic" && !rawName) ||
            (role === "InlineTextBox" &&
              String(nativeParent?.role?.value ?? "") === "StaticText" &&
              rawName === String(nativeParent?.name?.value ?? "") &&
              node.frameId === nativeParent?.frameId))
        )
          continue;
        const name = concealed ? "[redacted]" : safeText(rawName);
        const value =
          concealed ||
          /textField|passwordField|textbox|searchbox|comboBox/i.test(role) ||
          sensitive.test(rawName) ||
          propertySensitive ||
          fieldEcho(String(node.value?.value ?? ""))
            ? ""
            : safeText(node.value?.value);
        const identity =
          node.backendDOMNodeId &&
          JSON.stringify([
            page.pageGeneration,
            documentGeneration,
            epoch,
            node.frameId ?? "main",
            node.backendDOMNodeId,
          ]);
        const interactive =
          interactiveRoles.has(role.toLowerCase()) &&
          !concealed &&
          (!fieldNodes.has(node.nodeId) || name.trim().length > 0);
        let ref;
        if (identity && interactive) {
          ref = page.refs.get(identity) ?? `r${++page.nextRef}`;
        }
        if (rootNode && !descendant(node)) continue;
        const line = [ref, role, name, value].filter(Boolean).join(": ");
        if (!line) continue;
        let ancestor = node.parentId;
        while (ancestor && !entryByNodeId.has(ancestor)) ancestor = parent.get(ancestor);
        let native;
        if (
          ref &&
          identity &&
          node.backendDOMNodeId &&
          /^(checkbox|combobox|listbox|button|textbox|textfield|searchbox|spinbutton)$/i.test(
            role,
          ) &&
          (!node.frameId || node.frameId === frames.frameTree.frame.id)
        ) {
          const result = await Promise.race([
            this.native_targets.nativeControl(page, c, {
              identity,
              backendNodeId: node.backendDOMNodeId,
            }),
            cancelled,
          ]);
          native = result.control;
          /** @param {string} text */
          const privateEcho = (text) =>
            nodes.some(
              (other) =>
                other.nodeId !== node.nodeId &&
                fieldNodes.has(other.nodeId) &&
                !publicSearchFields.has(other.nodeId) &&
                String(other.value?.value ?? "") &&
                (text === String(other.value?.value) ||
                  (String(other.value?.value).length >= 3 &&
                    text.includes(String(other.value?.value)))),
            );
          if (
            native?.kind === "select" &&
            native.options.some((option) => privateEcho(option.value) || privateEcho(option.label))
          )
            native = { ...native, optionsComplete: false, options: [] };
        }
        /** @type {import("./model.js").ObservationEntry} */
        const entry = {
          id: `n${entries.length + 1}`,
          role,
          name,
          ...(ancestor ? { parent: entryByNodeId.get(ancestor) } : {}),
          ...(node.frameId ? { frameId: node.frameId } : {}),
          ...(ref ? { ref } : {}),
          ...(native ? { nativeControl: publicNativeControl(page, native) } : {}),
          ...(value ? { value } : {}),
          ...(node.description?.value
            ? { description: concealed ? "[redacted]" : safeText(node.description.value) }
            : {}),
          state: Object.fromEntries(
            (node.properties ?? [])
              .filter((property) =>
                ["checked", "selected", "disabled", "expanded", "required", "invalid"].includes(
                  property.name,
                ),
              )
              .map((property) => [property.name, safeText(property.value?.value, 80)]),
          ),
        };
        const bytes =
          Buffer.byteLength(line, "utf8") + Buffer.byteLength(JSON.stringify(entry), "utf8");
        if (lines.length >= limitNodes || textBytes + bytes > limitBytes) {
          truncated = true;
          break;
        }
        lines.push(line);
        if (ref && identity) nextRefs.set(identity, ref);
        if (native && identity) nextNativeControls.set(identity, native);
        entries.push(entry);
        entryByNodeId.set(node.nodeId, entry.id);
        textBytes += bytes;
      }
      const retainedRefs = new Map(
        [...page.refs].filter(([identity]) => liveIdentities.has(identity)),
      );
      for (const [identity, ref] of nextRefs) {
        retainedRefs.delete(identity);
        retainedRefs.set(identity, ref);
      }
      let refsEvicted = 0;
      while (retainedRefs.size > MAX_REFS) {
        const oldest = retainedRefs.keys().next().value;
        if (oldest === undefined) break;
        retainedRefs.delete(oldest);
        refsEvicted++;
      }
      page.refs = retainedRefs;
      page.nativeControls = nextNativeControls;
      const seenFrames = new Set(nodes.map((node) => node.frameId).filter(Boolean));
      /** @type {{frameId:string,url:string,coverage:string}[]} */
      const childFrames = [];
      /** @param {import("./model.js").CdpFrameTree} branch */
      const walkFrames = (branch, root = false) => {
        if (!root)
          childFrames.push({
            frameId: branch.frame.id,
            url: branch.frame.url ? observationUrl(branch.frame.url) : "",
            coverage: seenFrames.has(branch.frame.id) ? "covered" : "unavailable",
          });
        for (const child of branch.childFrames ?? []) walkFrames(child);
      };
      walkFrames(frames.frameTree, true);
      if (
        !this.workspace.pageStillOwned(page) ||
        page.control !== "agent" ||
        page.controlEpoch !== epoch
      )
        throw new Error(invalidation());
      page.observedViewportKey = viewportKey;
      page.lastObservation = base.observationId;
      page.lastObservationTurnId = turnId;
      page.needsObservation = false;
      return {
        ...base,
        frameCoverage: { main: "covered", childFrames },
        shadowCoverage: "not-distinguished-by-accessibility-tree",
        dynamicCoverage: "snapshot-at-capturedAt",
        truncated,
        truncationReason: truncated ? "budget" : null,
        refCache: { capacity: MAX_REFS, evicted: refsEvicted },
        budget: { nodes: limitNodes, textBytes: limitBytes },
        nodes: entries,
        text: lines.join("\n"),
      };
    } finally {
      clearTimeout(timer);
      if (page.activeRead === read) {
        page.activeRead = null;
        try {
          if (
            page.control === "agent" &&
            page.controlEpoch === epoch &&
            !c.isDestroyed() &&
            c.debugger.isAttached() &&
            !page.diagnosticsReady
          )
            c.debugger.detach();
        } catch {
          /* A detached/crashed target already revoked this read. */
        }
      }
    }
  }

  /** @param {Pick<import("./model.js").HostIdentity,"projectId"|"threadId"|"requestId"|"hostGeneration">} request */
  cancelRead({ projectId, threadId, requestId, hostGeneration }) {
    if (hostGeneration !== this.workspace.hostGeneration) return;
    for (const page of this.workspace.workspacePages(projectId, threadId)) {
      for (const active of [page.activeBatch, page.activeRead, page.activeAction])
        if (active && active.requestId === requestId) active.cancel();
    }
  }
}

module.exports = { BrowserReads };
