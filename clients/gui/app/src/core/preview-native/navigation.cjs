// @ts-check
"use strict";
const { loadNavigationDocument } = require("../browser-navigation.cjs");
const { preparedActionId } = require("../preview/approval.cjs");
const { webUrl, observationUrl } = require("../preview/urls.cjs");
const { pageKey } = require("./identity.cjs");
const { randomUUID, createHash } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");

class ApprovedNavigation {
  /**
   * @param {InstanceType<typeof import('./control.cjs').PageControl>} control
   * @param {InstanceType<typeof import('./lifecycle.cjs').NativePageLifecycle>} lifecycle
   * @param {InstanceType<typeof import('./workspace.cjs').PreviewWorkspace>} workspace
   */
  constructor(control, lifecycle, workspace) {
    this.control = control;
    this.lifecycle = lifecycle;
    this.workspace = workspace;
  }
  /**
   * @param {import('./model.js').NavigationRequest} request
   */
  async prepareNavigation(request) {
    const { page, c } = this.workspace.actionPage(request);
    if (page.needsObservation && c.getURL() !== "about:blank") throw new Error("stale_ref");
    if (
      page.activeRead ||
      page.activePrepare ||
      page.activeAction ||
      this.workspace.workspaceOutstanding(page.projectId, page.threadId) >= 16
    )
      throw new Error("not_sent");
    const target = webUrl(request.parameters.url);
    if (!page.networkPolicy.canAuthorize(target)) throw new Error("not_sent");
    const source = c.getURL();
    if (!source) throw new Error("plan_stale");
    /** @type {import("./model.js").NavigationPlan} */
    const plan = {
      preparedActionId: randomUUID(),
      operation: request.operation,
      pageId: page.id,
      origin: new URL(source).origin,
      targetOrigin: new URL(target).origin,
      url: observationUrl(source),
      targetUrl: target,
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
    page.plans.set(plan.preparedActionId, { kind: "navigation", plan, pageUrl: source });
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
   * @param {import('./model.js').NavigationRequest} request
   */
  async executeNavigation(request) {
    const { page, c } = this.workspace.actionPage(request);
    const approval = request.browserApproval?.plan;
    const id = preparedActionId(approval);
    const candidate = id === undefined ? undefined : page.plans.get(id);
    const saved = candidate?.kind === "navigation" ? candidate : undefined;
    const approved = saved && isDeepStrictEqual(saved.plan, approval) ? saved.plan : undefined;
    const target = webUrl(request.parameters.url);
    if (
      !saved ||
      !approved ||
      !isDeepStrictEqual(saved.plan, approved) ||
      approved.operation !== request.operation ||
      approved.pageId !== page.id ||
      approved.threadId !== request.threadId ||
      approved.turnId !== request.turnId ||
      approved.callId !== request.callId ||
      approved.expiresAt < Date.now() ||
      approved.targetUrl !== target ||
      approved.origin !== new URL(c.getURL()).origin ||
      saved.pageUrl !== c.getURL() ||
      approved.pageGeneration !== page.pageGeneration ||
      approved.documentEpoch !== page.documentGeneration ||
      approved.controlEpoch !== page.controlEpoch
    )
      throw new Error("plan_stale");
    page.plans.delete(approved.preparedActionId);
    if (page.activeRead || page.activePrepare || page.activeAction) throw new Error("not_sent");
    if (!page.networkPolicy.allowApprovedNavigation(target)) throw new Error("not_sent");
    /** @type {()=>void} */
    let cancel = () => {};
    /** @type {Promise<never>} */
    const stopped = new Promise((_, reject) => {
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
    let child, navigation;
    const deadline = setTimeout(() => {
      action.timedOut = true;
      action.cancel();
    }, 12000);
    try {
      page.approvedActionNavigation = null;
      if (request.operation === "navigate") {
        page.approvedNavigation = target;
        page.url = target;
        page.error = "";
        action.dispatched = true;
        navigation = await loadNavigationDocument(c, target, stopped);
      } else {
        const id = randomUUID();
        child = this.lifecycle.create(
          pageKey(page.coreInstanceId, page.projectId, page.threadId, id),
          page.projectId,
          page.threadId,
          { id, openerId: page.id, origin: "agent" },
        );
        child.approvedNavigation = target;
        child.url = target;
        action.dispatched = true;
        navigation = await loadNavigationDocument(child.view.webContents, target, stopped);
      }
      if (
        action.cancelled ||
        !this.workspace.pageStillOwned(page) ||
        !this.workspace.owns(page.projectId, page.threadId) ||
        page.controlEpoch !== approved.controlEpoch ||
        (child && !this.workspace.pageStillOwned(child))
      )
        throw new Error("outcome_unknown");
      if (child) {
        const claimed = await Promise.race([
          this.control.claim(page.projectId, page.threadId, child.id),
          stopped,
        ]);
        if (
          action.cancelled ||
          !this.workspace.pageStillOwned(page) ||
          !this.workspace.owns(page.projectId, page.threadId) ||
          page.controlEpoch !== approved.controlEpoch ||
          !this.workspace.pageStillOwned(child) ||
          child.control !== "agent" ||
          child.controlEpoch !== claimed.controlEpoch
        )
          throw new Error("outcome_unknown");
      }
      this.workspace.changed(child ?? page);
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
        ...(child
          ? {
              createdPage: {
                pageId: child.id,
                pageGeneration: child.pageGeneration,
                controlEpoch: child.controlEpoch,
              },
            }
          : {}),
        url: observationUrl(navigation.url),
        readiness: navigation.readiness,
        dispatch: "confirmed",
      };
    } catch (error) {
      page.approvedNavigation = null;
      if (child) {
        child.approvedNavigation = null;
        child.claiming?.cancel();
        if (child.control === "agent") this.control.revoke(child);
      }
      if (action.dispatched)
        throw Object.assign(new Error("outcome_unknown", { cause: error }), {
          reason: action.timedOut ? "navigation_timeout" : "navigation_interrupted",
        });
      throw error;
    } finally {
      clearTimeout(deadline);
      if (page.activeAction === action) page.activeAction = null;
    }
  }
}

module.exports = { ApprovedNavigation };
