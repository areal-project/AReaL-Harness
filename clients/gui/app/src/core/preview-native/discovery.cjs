// @ts-check
"use strict";
const { preparedActionId } = require("../preview/approval.cjs");
const { hasNativePage } = require("./workspace.cjs");
const { observationUrl } = require("../preview/urls.cjs");
const { workspaceKey, pageKey } = require("./identity.cjs");
const { randomUUID, createHash } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");

class BrowserDiscovery {
  /**
   * @param {InstanceType<typeof import('./control.cjs').PageControl>} control
   * @param {InstanceType<typeof import('./lifecycle.cjs').NativePageLifecycle>} lifecycle
   * @param {InstanceType<typeof import('./workspace.cjs').PreviewWorkspace>} workspace
   */
  constructor(control, lifecycle, workspace) {
    this.control = control;
    this.lifecycle = lifecycle;
    this.workspace = workspace;
    /** @type {Map<string,{plan:import("./model.js").DiscoveryPlan;page:import("./model.js").Page|null|undefined;view:import("electron").WebContentsView|null|undefined;source:string;sequence:number}>} */
    this.discoveryPlans = new Map();
  }
  /**
   * @param {import('./model.js').DiscoveryRequest} request
   */
  prepareDiscovery(request) {
    this.workspace.profile.assertAvailable();
    if (
      !this.workspace.owns(request.projectId, request.threadId) ||
      this.workspace.coreIdentity(request.projectId, request.threadId) !== request.coreInstanceId
    )
      throw new Error("plan_stale");
    for (const [id, record] of this.discoveryPlans)
      if (record.plan.expiresAt <= Date.now()) this.discoveryPlans.delete(id);
    if (this.discoveryPlans.size >= 128) throw new Error("not_sent");
    const page = this.workspace.page(request.projectId, request.threadId);
    const c = page?.view?.webContents;
    if (
      page &&
      (!this.workspace.pageStillOwned(page) ||
        !c ||
        !hasNativePage(page) ||
        page.crashed ||
        c.isDestroyed() ||
        c.isDevToolsOpened() ||
        !["human", "agent"].includes(page.control))
    )
      throw new Error("plan_stale");
    const source = page ? c?.getURL() || page.url || "about:blank" : "about:blank";
    const workspace = workspaceKey(request.coreInstanceId, request.projectId, request.threadId);
    /** @type {import("./model.js").DiscoveryPlan} */
    const plan = {
      preparedActionId: randomUUID(),
      operation: "describe",
      pageId: page?.id ?? null,
      origin: page ? new URL(source).origin : "about:blank",
      url: observationUrl(source),
      alreadyControlled: page?.control === "agent",
      control: page?.control ?? null,
      humanRevision: page?.humanRevision ?? 0,
      documentEpoch: page?.documentGeneration ?? 0,
      pageGeneration: page?.pageGeneration ?? 0,
      controlEpoch: page?.controlEpoch ?? 0,
      browserHostId: this.workspace.browserHostId,
      hostGeneration: this.workspace.hostGeneration,
      coreInstanceId: request.coreInstanceId,
      coreGeneration: request.coreGeneration,
      projectId: request.projectId,
      threadId: request.threadId,
      turnId: request.turnId,
      callId: request.callId,
      expiresAt: Date.now() + 300000,
    };
    plan.fingerprint = createHash("sha256").update(JSON.stringify(plan)).digest("hex");
    this.discoveryPlans.set(plan.preparedActionId, {
      plan,
      page,
      view: page?.view,
      source,
      sequence: this.workspace.eventSequences.get(workspace) ?? 0,
    });
    return {
      coreInstanceId: request.coreInstanceId,
      coreGeneration: request.coreGeneration,
      projectId: request.projectId,
      threadId: request.threadId,
      turnId: request.turnId,
      callId: request.callId,
      pageId: plan.pageId,
      browserHostId: this.workspace.browserHostId,
      hostGeneration: this.workspace.hostGeneration,
      pageGeneration: plan.pageGeneration,
      controlEpoch: plan.controlEpoch,
      plan,
    };
  }

  /**
   * @param {import('./model.js').DiscoveryRequest} request
   */
  consumeDiscovery(request) {
    this.workspace.profile.assertAvailable();
    const approval = request.browserApproval?.plan;
    const id = preparedActionId(approval);
    const saved = id === undefined ? undefined : this.discoveryPlans.get(id);
    if (saved) this.discoveryPlans.delete(saved.plan.preparedActionId);
    const approved = saved && isDeepStrictEqual(saved.plan, approval) ? saved.plan : undefined;
    const page = this.workspace.page(request.projectId, request.threadId);
    const workspace = workspaceKey(request.coreInstanceId, request.projectId, request.threadId);
    if (
      !saved ||
      !approved ||
      !isDeepStrictEqual(saved.plan, approved) ||
      approved.expiresAt <= Date.now() ||
      approved.operation !== "describe" ||
      approved.coreInstanceId !== request.coreInstanceId ||
      approved.coreGeneration !== request.coreGeneration ||
      approved.projectId !== request.projectId ||
      approved.threadId !== request.threadId ||
      approved.turnId !== request.turnId ||
      approved.callId !== request.callId ||
      approved.browserHostId !== this.workspace.browserHostId ||
      approved.hostGeneration !== this.workspace.hostGeneration ||
      this.workspace.coreIdentity(request.projectId, request.threadId) !== request.coreInstanceId ||
      !this.workspace.owns(request.projectId, request.threadId) ||
      page !== saved.page ||
      (this.workspace.eventSequences.get(workspace) ?? 0) !== saved.sequence
    )
      throw new Error("plan_stale");
    if (page) {
      const c = page.view?.webContents;
      if (
        !this.workspace.pageStillOwned(page) ||
        page.view !== saved.view ||
        !c ||
        !hasNativePage(page) ||
        c.isDestroyed() ||
        page.crashed ||
        c.isDevToolsOpened() ||
        (c.getURL() || page.url || "about:blank") !== saved.source ||
        page.control !== approved.control ||
        (page.humanRevision ?? 0) !== approved.humanRevision ||
        page.documentGeneration !== approved.documentEpoch ||
        page.pageGeneration !== approved.pageGeneration ||
        page.controlEpoch !== approved.controlEpoch
      )
        throw new Error("plan_stale");
    }
    return saved;
  }

  /**
   * @param {string} projectId
   * @param {string} threadId
   */
  async ensureAgentPage(projectId, threadId) {
    this.workspace.profile.assertAvailable();
    // 仅供已通过 Core 权限的工具回调调用；展示页面不会隐式认领。
    if (
      !this.workspace.owns(projectId, threadId) ||
      !this.workspace.coreIdentity(projectId, threadId)
    )
      throw new Error("Browser thread unavailable");
    let page = this.workspace.page(projectId, threadId);
    if (!page) {
      const id = randomUUID();
      page = this.lifecycle.create(
        pageKey(this.workspace.coreIdentity(projectId, threadId), projectId, threadId, id),
        projectId,
        threadId,
        { id },
      );
    }
    if (!page.view || page.crashed || page.view.webContents.isDestroyed())
      throw new Error("Browser page unavailable");
    const c = page.view.webContents;
    const humanRevision = page.humanRevision ?? 0;
    if (!c.getURL()) await c.loadURL("about:blank");
    if (!this.workspace.pageStillOwned(page)) throw new Error("Browser page unavailable");
    if (page.control === "transferring") await this.control.convergeInput(page);
    this.workspace.profile.assertAvailable();
    if ((page.humanRevision ?? 0) !== humanRevision)
      throw new Error("Browser authorization was revoked");
    if (page.control === "agent")
      return {
        protocol: "areal.browser.host.v1",
        operations: [
          "describe",
          "observe",
          "capture",
          "act",
          "wait",
          "navigate",
          "openDocument",
          "newPage",
          "diagnostics",
          "runBatch",
          "command",
        ],
        available: true,
        coreInstanceId: page.coreInstanceId,
        projectId,
        threadId,
        pageId: page.id,
        browserHostId: this.workspace.browserHostId,
        hostGeneration: this.workspace.hostGeneration,
        pageGeneration: page.pageGeneration,
        controlEpoch: page.controlEpoch,
      };
    return this.control.claim(projectId, threadId, page.id);
  }
}

module.exports = { BrowserDiscovery };
