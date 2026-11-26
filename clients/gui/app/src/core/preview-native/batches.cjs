// @ts-check
"use strict";
const { preparedActionId } = require("../preview/approval.cjs");
const { observationUrl } = require("../preview/urls.cjs");
const { randomUUID, createHash } = require("node:crypto");
const { performance } = require("node:perf_hooks");
const { isDeepStrictEqual } = require("node:util");
const { invalidateActionObservation } = require("../preview/observation-state.cjs");

class ApprovedBatches {
  /**
   * @param {InstanceType<typeof import('./workspace.cjs').PreviewWorkspace>} workspace
   * @param {(request:import("./model.js").ActionRequest) => Promise<import("./model.js").ActionReceipt>} executeStep
   * @param {(request:import("./model.js").ActionRequest) => Promise<import("./model.js").PreparedAction>} prepareStep
   */
  constructor(workspace, executeStep, prepareStep) {
    this.workspace = workspace;
    this.executeStep = executeStep;
    this.prepareStep = prepareStep;
    // Retain call identities for the host lifetime, including UNKNOWN results.
    /** @type {Map<string,import("./model.js").BatchCall>} */
    this.batchCalls = new Map();
  }
  /**
   * @param {import('./model.js').BatchRequest} request
   */
  batchIdentity(request) {
    return JSON.stringify([
      this.workspace.hostGeneration,
      request.coreInstanceId,
      request.projectId,
      request.threadId,
      request.turnId,
      request.callId,
    ]);
  }

  /**
   * @param {import('./model.js').BatchRequest} request
   * @param {import('@areal/browser-automation/host-tool-types').BatchStep} step
   * @returns {import('./model.js').ActionRequest}
   */
  batchStep(request, step) {
    // 子步骤复用已准入的账本项，避免在每份子计划中复制供应商标识。
    const identity = { ...request, callId: request.itemId ?? request.callId };
    return step.operation === "act"
      ? {
          ...identity,
          operation: "act",
          parameters: { pageId: request.pageId, snapshotId: step.snapshotId, action: step.action },
        }
      : {
          ...identity,
          operation: "wait",
          parameters: {
            pageId: request.pageId,
            timeoutMs: step.timeoutMs,
            ...(step.condition === undefined ? {} : { condition: step.condition }),
          },
        };
  }

  /**
   * @param {import('./model.js').BatchRequest} request
   */
  async prepareBatch(request) {
    const key = this.batchIdentity(request);
    const parameters = JSON.stringify(request.parameters);
    const existing = this.batchCalls.get(key);
    if (existing) {
      if (existing.parameters !== parameters) throw new Error("not_sent");
      return existing.preparePromise;
    }
    const { page, c } = this.workspace.actionPage(request);
    if (this.batchCalls.size >= 256) throw new Error("not_sent");
    /** @type {import("./model.js").BatchCall} */
    const record = {
      parameters,
      page,
      plan: null,
      result: null,
      executePromise: null,
      cancelled: false,
    };
    this.batchCalls.set(key, record);
    record.preparePromise = (async () => {
      /** @type {import("./model.js").ActionPlan[]} */
      const stepPlans = [];
      const deadline = performance.now() + 9000; // Adapter preparation expires at 10s.
      try {
        if (page.needsObservation || page.lastObservation !== request.parameters.snapshotId)
          throw new Error("stale_ref");
        for (const step of request.parameters.steps) {
          if (performance.now() >= deadline) throw new Error("not_sent");
          const prepared = await this.prepareStep({
            ...this.batchStep(request, step),
            batchDeadline: deadline,
          });
          stepPlans.push(prepared.plan);
          if (
            performance.now() >= deadline ||
            page.view?.webContents !== c ||
            page.controlEpoch !== request.controlEpoch
          )
            throw new Error("plan_stale");
        }
        // 批量外层计划也占用同一工作区预算；失败时沿现有路径清除子计划。
        if (this.workspace.workspaceOutstanding(page.projectId, page.threadId) >= 16)
          throw new Error("not_sent");
        /** @type {import("./model.js").BatchPlan} */
        const plan = {
          preparedActionId: randomUUID(),
          operation: "runBatch",
          pageId: page.id,
          origin: new URL(c.getURL()).origin,
          url: observationUrl(c.getURL()),
          localDevelopment: stepPlans.every((plan) => plan.localDevelopment === true),
          snapshotId: request.parameters.snapshotId,
          steps: stepPlans,
          pageGeneration: page.pageGeneration,
          documentEpoch: page.documentGeneration,
          controlEpoch: page.controlEpoch,
          viewportRevision: page.viewportRevision,
          browserHostId: this.workspace.browserHostId,
          hostGeneration: this.workspace.hostGeneration,
          threadId: request.threadId,
          turnId: request.turnId,
          callId: request.callId,
          expiresAt: Date.now() + 300000,
        };
        plan.fingerprint = createHash("sha256").update(JSON.stringify(plan)).digest("hex");
        record.plan = plan;
        page.plans.set(plan.preparedActionId, { kind: "batch", plan, pageUrl: c.getURL() });
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
      } catch (error) {
        for (const plan of stepPlans) page.plans.delete(plan.preparedActionId);
        throw error;
      }
    })();
    return record.preparePromise;
  }

  /**
   * @param {import('./model.js').BatchRequest} request
   */
  async executeBatch(request) {
    const record = this.batchCalls.get(this.batchIdentity(request));
    if (!record || record.parameters !== JSON.stringify(request.parameters))
      throw new Error("plan_stale");
    if (record.executePromise) return record.executePromise;
    const approval = request.browserApproval?.plan;
    const id = preparedActionId(approval);
    const candidate = id === undefined ? undefined : record.page.plans.get(id);
    const saved = candidate?.kind === "batch" ? candidate : undefined;
    const approved = saved && isDeepStrictEqual(saved.plan, approval) ? saved.plan : undefined;
    const { page, c } = this.workspace.actionPage(request);
    if (
      record.page !== page ||
      !record.plan ||
      !saved ||
      !approved ||
      !isDeepStrictEqual(approved, record.plan) ||
      !isDeepStrictEqual(saved.plan, record.plan) ||
      approved.expiresAt < Date.now() ||
      saved.pageUrl !== c.getURL() ||
      page.controlEpoch !== approved.controlEpoch ||
      page.documentGeneration !== approved.documentEpoch
    )
      throw new Error("plan_stale");
    // Register before the first asynchronous step so concurrent equal callIds
    // share one execution; a different argument body is rejected above.
    record.executePromise = (async () => {
      page.plans.delete(approved.preparedActionId);
      /** @type {import("./model.js").BatchReceipt[]} */
      const receipts = [];
      page.batchProgress = {
        callId: request.callId,
        completed: 0,
        total: request.parameters.steps.length,
        status: "running",
      };
      this.workspace.changed(page, "operationChanged");
      const deadline = performance.now() + 29000;
      let expired = false;
      const batch = {
        requestId: request.requestId,
        cancel: () => {
          record.cancelled = true;
          if (page.activeAction?.requestId === request.requestId) page.activeAction.cancel();
        },
      };
      page.activeBatch = batch;
      const timer = setTimeout(() => {
        expired = true;
        batch.cancel();
      }, 29000);
      const base = {
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
        controlEpoch: approved.controlEpoch,
        preparedActionId: approved.preparedActionId,
      };
      try {
        for (const [index, step] of request.parameters.steps.entries()) {
          const remaining = deadline - performance.now();
          if (
            record.cancelled ||
            expired ||
            remaining <= 1000 ||
            (step.operation === "wait" && step.timeoutMs + 1000 > remaining)
          ) {
            const result = {
              ...base,
              error: "budget_exceeded",
              dispatch: "not_sent",
              receipts,
              failedStep: index,
              remaining: "not_sent",
              remainingSteps: request.parameters.steps.length - index,
            };
            page.batchProgress = {
              callId: request.callId,
              completed: receipts.length,
              total: request.parameters.steps.length,
              status: "rejected",
            };
            this.workspace.changed(page, "operationChanged");
            record.result = result;
            return result;
          }
          try {
            this.workspace.actionPage(request); // Page, host generation and local control fence.
            if (
              page.controlEpoch !== approved.controlEpoch ||
              page.documentGeneration !== approved.documentEpoch
            )
              throw new Error("plan_stale");
            const result = await this.executeStep({
              ...this.batchStep(request, step),
              batchDeadline: deadline,
              browserApproval: { plan: approved.steps[index] },
              batchGuard: () => record.cancelled || performance.now() >= deadline,
            });
            receipts.push({
              stepIndex: index,
              operation: step.operation,
              status: "confirmed",
              dispatch: result.dispatch,
              verification: result.verification ?? "not_checked",
              preparedActionId: result.preparedActionId,
              inputConfirmed: result.inputConfirmed,
              ...(result.noOp ? { noOp: true } : {}),
              ...(result.nativeControl ? { nativeControl: result.nativeControl } : {}),
              ...(result.stateMatched !== undefined ? { stateMatched: result.stateMatched } : {}),
            });
            if (result.observationInvalidated) invalidateActionObservation(page);
            page.batchProgress = {
              callId: request.callId,
              completed: receipts.length,
              total: request.parameters.steps.length,
              status: "running",
            };
            this.workspace.changed(page, "operationChanged");
          } catch (error) {
            const message = error instanceof Error ? error.message : undefined;
            const unknown = message === "outcome_unknown";
            const result = {
              ...base,
              error: unknown ? "outcome_unknown" : message,
              dispatch: unknown ? "unknown" : "not_sent",
              receipts,
              failedStep: index,
              remaining: "not_sent",
              remainingSteps: request.parameters.steps.length - index - 1,
            };
            page.batchProgress = {
              callId: request.callId,
              completed: receipts.length,
              total: request.parameters.steps.length,
              status: unknown ? "unknown" : "rejected",
            };
            this.workspace.changed(page, "operationChanged");
            record.result = result;
            return result;
          }
        }
        const result = { ...base, dispatch: "confirmed", receipts, verification: "not_checked" };
        page.batchProgress = {
          callId: request.callId,
          completed: receipts.length,
          total: receipts.length,
          status: "confirmed",
        };
        this.workspace.changed(page, "operationChanged");
        record.result = result;
        return result;
      } finally {
        clearTimeout(timer);
        for (const plan of approved.steps) page.plans.delete(plan.preparedActionId);
        if (page.activeBatch === batch) page.activeBatch = null;
      }
    })();
    return record.executePromise;
  }
}

module.exports = { ApprovedBatches };
