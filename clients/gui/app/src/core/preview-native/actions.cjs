// @ts-check
"use strict";
const { preparedActionId } = require("../preview/approval.cjs");
const { observationUrl } = require("../preview/urls.cjs");
const { coordinateTarget } = require("../preview/geometry.cjs");
const { pageKey } = require("./identity.cjs");
const { randomUUID, createHash } = require("node:crypto");
const { performance } = require("node:perf_hooks");
const { isDeepStrictEqual } = require("node:util");
const { waitAction } = require("@areal/workbench-service/desktop/core/browser-tool.cjs");
const { batchWithin, viewportFacts, readViewport } = require("./read-session.cjs");
const { publicNativeControl } = require("./native-targets.cjs");
const {
  invalidateActionObservation,
  documentReadyWait,
  coordinateKinds,
} = require("../preview/observation-state.cjs");

class ApprovedActions {
  /**
   * @param {InstanceType<typeof import('./control.cjs').PageControl>} control
   * @param {InstanceType<typeof import('./human-input.cjs').HumanBrowserInput>} human_input
   * @param {InstanceType<typeof import('./native-targets.cjs').NativePageTargets>} native_targets
   * @param {InstanceType<typeof import('./presentation.cjs').PreviewPresentation>} presentation
   * @param {InstanceType<typeof import('./wait-conditions.cjs').BrowserWaitConditions>} wait_conditions
   * @param {InstanceType<typeof import('./workspace.cjs').PreviewWorkspace>} workspace
   */
  constructor(control, human_input, native_targets, presentation, wait_conditions, workspace) {
    this.control = control;
    this.human_input = human_input;
    this.native_targets = native_targets;
    this.presentation = presentation;
    this.wait_conditions = wait_conditions;
    this.workspace = workspace;
  }
  /**
   * @param {import('./model.js').ActionRequest} request
   */
  async prepare(request) {
    const { page, c } = this.workspace.actionPage(request);
    const initialDocument = page.documentGeneration;
    const readiness = documentReadyWait(request.operation, request.parameters);
    for (const [id, record] of page.plans)
      if (record.plan.expiresAt < Date.now()) page.plans.delete(id);
    if (
      page.activeRead ||
      page.activePrepare ||
      page.activeAction ||
      page.activeBatch ||
      this.workspace.workspaceOutstanding(page.projectId, page.threadId) >= 16
    )
      throw new Error("not_sent");
    const url = new URL(c.getURL());
    const local =
      ["http:", "https:"].includes(url.protocol) &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (!local && !["http:", "https:"].includes(url.protocol))
      throw new Error("human_takeover_required");
    const requestedAction = request.operation === "act" ? request.parameters.action : null;
    const condition = request.operation === "wait" ? request.parameters.condition : null;
    const needsRefs =
      requestedAction !== null || (condition != null && condition.kind !== "documentReady");
    if (
      (needsRefs && (page.needsObservation || page.lastObservationTurnId !== request.turnId)) ||
      (request.operation === "act" && request.parameters.snapshotId !== page.lastObservation)
    )
      throw new Error("stale_ref");
    const coordinate =
      requestedAction &&
      (requestedAction.kind === "clickAt" ||
        requestedAction.kind === "pressAt" ||
        requestedAction.kind === "drag")
        ? requestedAction
        : null;
    const capture = coordinate ? page.lastCapture : null;
    if (
      coordinate &&
      (!capture ||
        capture.observationId !== request.parameters.snapshotId ||
        capture.pageGeneration !== page.pageGeneration ||
        capture.documentEpoch !== page.documentGeneration ||
        capture.controlEpoch !== page.controlEpoch ||
        capture.viewportRevision !== page.viewportRevision)
    )
      throw new Error("stale_ref");
    const scroll = requestedAction?.kind === "scroll";
    /** @type {import("./model.js").NativeTarget|null} */
    let target = null;
    let points = null,
      native = null,
      waitNative = null;
    page.activePrepare = true;
    try {
      if (!c.debugger.isAttached()) c.debugger.attach("1.3");
      if ((coordinate || scroll) && !local) throw new Error("human_takeover_required");
      if (coordinate && capture) points = coordinateTarget(capture, coordinate);
      else if (request.operation === "act" && !scroll)
        target = await (request.batchDeadline
          ? batchWithin(
              this.native_targets.actionTarget(page, c, requestedAction?.ref),
              request.batchDeadline,
            )
          : this.native_targets.actionTarget(page, c, requestedAction?.ref));
      if (
        requestedAction?.kind === "fill" &&
        (!target || !/^(textField|textbox|searchbox|comboBox|spinbutton)$/i.test(target.role))
      )
        throw new Error("target_unavailable");
      if (requestedAction?.kind === "selectOption" || requestedAction?.kind === "setChecked") {
        native = await this.native_targets.nativeControl(page, c, requestedAction?.ref);
        const control = native.control,
          observed = page.nativeControls.get(native.identity);
        if (
          !control ||
          !control.enabled ||
          !observed ||
          observed.identity !== control.identity ||
          control.kind !== (requestedAction.kind === "selectOption" ? "select" : "checkbox")
        )
          throw new Error("target_unavailable");
        if (
          control.kind === "select" &&
          (!control.optionsComplete ||
            control.multiple ||
            !isDeepStrictEqual(control, observed) ||
            control.options.filter((option) => option.value === requestedAction.value).length !==
              1 ||
            control.options.find((option) => option.value === requestedAction.value)?.disabled)
        )
          throw new Error("target_unavailable");
      }
      if (condition?.kind === "checked" || condition?.kind === "enabled") {
        waitNative = await this.native_targets.nativeControl(page, c, condition.ref);
        const observed = page.nativeControls.get(waitNative.identity),
          control = waitNative.control;
        if (
          !control ||
          !observed ||
          observed.identity !== control.identity ||
          observed.kind !== control.kind ||
          control.kind === "redacted" ||
          (condition.kind === "checked" && control.kind !== "checkbox")
        )
          throw new Error("target_unavailable");
      }
      const semantics =
        target && requestedAction
          ? local
            ? await this.native_targets.linkNavigationSemantics(page, c, target, requestedAction)
            : await this.native_targets.publicActionSemantics(page, c, target, requestedAction)
          : null;
      const viewport = readiness
        ? null
        : await (request.batchDeadline
            ? batchWithin(readViewport(c), request.batchDeadline)
            : readViewport(c));
      const viewportKey = viewport
        ? viewportFacts(this.presentation.window, page, viewport).key
        : null;
      if (
        (request.batchDeadline && performance.now() >= request.batchDeadline) ||
        !this.workspace.pageStillOwned(page) ||
        page.control !== "agent" ||
        page.controlEpoch !== request.controlEpoch ||
        page.pageGeneration !== request.pageGeneration ||
        (!readiness && page.documentGeneration !== initialDocument) ||
        c.isDestroyed() ||
        (readiness ? new URL(c.getURL()).origin !== url.origin : c.getURL() !== url.href)
      )
        throw new Error("plan_stale");
      if (needsRefs && page.observedViewportKey !== viewportKey) throw new Error("plan_stale");
      if (!readiness && page.viewportKey !== viewportKey) {
        page.viewportKey = viewportKey;
        page.viewportRevision++;
      }
      if (capture && (capture.viewportKey !== viewportKey || capture.url !== url.href))
        throw new Error("plan_stale");
      /** @type {import("./model.js").ActionPlan} */
      const plan = {
        preparedActionId: randomUUID(),
        operation: request.operation,
        pageId: page.id,
        origin: url.origin,
        url: observationUrl(url.href),
        localDevelopment: local,
        snapshotId: request.operation === "act" ? request.parameters.snapshotId : null,
        target:
          points && capture
            ? {
                ...points,
                captureId: capture.observationId,
                bitmapWidth: capture.bitmapWidth,
                bitmapHeight: capture.bitmapHeight,
              }
            : target && requestedAction
              ? {
                  ref: requestedAction.ref,
                  role: target.role,
                  name: target.name,
                  x: target.x,
                  y: target.y,
                  ...(semantics ? { semantics } : {}),
                  ...(native ? { nativeControl: publicNativeControl(page, native.control) } : {}),
                }
              : scroll && viewport
                ? {
                    kind: "viewport",
                    x: Math.floor(viewport.width / 2),
                    y: Math.floor(viewport.height / 2),
                  }
                : null,
        action:
          request.operation === "act" ? request.parameters.action : waitAction(request.parameters),
        pageGeneration: page.pageGeneration,
        documentEpoch: page.documentGeneration,
        controlEpoch: page.controlEpoch,
        viewportRevision: page.viewportRevision,
        viewportKey,
        browserHostId: this.workspace.browserHostId,
        hostGeneration: this.workspace.hostGeneration,
        threadId: request.threadId,
        turnId: request.turnId,
        callId: request.callId,
        expiresAt: Date.now() + 300000,
      };
      plan.fingerprint = createHash("sha256")
        .update(
          JSON.stringify({
            plan,
            targetIdentity: target?.identity,
            native: native?.control,
            waitNative: waitNative?.control,
          }),
        )
        .digest("hex");
      page.plans.set(plan.preparedActionId, {
        kind: "action",
        plan,
        targetIdentity: target?.identity,
        native: native?.control,
        waitNative: waitNative?.control,
        pageUrl: url.href,
        waitIdentity:
          condition && condition.kind !== "documentReady"
            ? this.native_targets.refNode(page, condition.ref).identity
            : null,
      });
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
    } finally {
      page.activePrepare = false;
      // Takeover convergence owns this channel after the Agent epoch ends.
      if (
        page.control === "agent" &&
        page.controlEpoch === request.controlEpoch &&
        c.debugger.isAttached() &&
        !page.diagnosticsReady
      )
        c.debugger.detach();
    }
  }

  /**
   * @param {import('./model.js').ActionRequest} request
   */
  async execute(request) {
    const { page, c } = this.workspace.actionPage(request);
    const approval = request.browserApproval?.plan;
    const id = preparedActionId(approval);
    const candidate = id === undefined ? undefined : page.plans.get(id);
    const saved = candidate?.kind === "action" ? candidate : undefined;
    const approved = saved && isDeepStrictEqual(saved.plan, approval) ? saved.plan : undefined;
    const readiness = documentReadyWait(request.operation, request.parameters);
    const nowViewport = readiness
      ? null
      : await (request.batchDeadline
          ? batchWithin(readViewport(c), request.batchDeadline)
          : readViewport(c));
    const nowKey = nowViewport
      ? viewportFacts(this.presentation.window, page, nowViewport).key
      : null;
    if (request.batchGuard?.()) throw new Error("not_sent");
    if (
      !saved ||
      !approved ||
      !isDeepStrictEqual(approved, saved.plan) ||
      saved.plan.threadId !== request.threadId ||
      saved.plan.turnId !== request.turnId ||
      saved.plan.callId !== request.callId ||
      saved.plan.operation !== request.operation ||
      saved.plan.pageId !== request.pageId ||
      saved.plan.expiresAt < Date.now() ||
      saved.plan.origin !== new URL(c.getURL()).origin ||
      (!readiness && saved.pageUrl !== c.getURL()) ||
      saved.plan.pageGeneration !== page.pageGeneration ||
      (!readiness && saved.plan.documentEpoch !== page.documentGeneration) ||
      saved.plan.controlEpoch !== page.controlEpoch ||
      (!readiness && saved.plan.viewportRevision !== page.viewportRevision) ||
      (!readiness && saved.plan.viewportKey !== nowKey) ||
      (request.operation === "act" &&
        coordinateKinds.has(request.parameters.action.kind) &&
        page.lastCapture?.observationId !== saved.plan.target?.captureId) ||
      saved.plan.snapshotId !==
        (request.operation === "act" ? request.parameters.snapshotId : null) ||
      !isDeepStrictEqual(
        saved.plan.action,
        request.operation === "act" ? request.parameters.action : waitAction(request.parameters),
      )
    )
      throw new Error("plan_stale");
    page.plans.delete(approved.preparedActionId);
    if (
      page.activeRead ||
      page.activePrepare ||
      page.activeAction ||
      (page.activeBatch && !request.batchGuard)
    )
      throw new Error("not_sent");
    /** @type {(reason:Error)=>void} */
    let cancelled = () => {};
    /** @type {Promise<never>} */
    const stop = new Promise((_, reject) => {
      cancelled = reject;
    });
    /** @type {import("./model.js").ActionLease} */
    const action = {
      requestId: request.requestId,
      syntheticInput: request.operation === "act",
      dispatched: false,
      cancelled: false,
      cancel: () => {
        action.cancelled = true;
        cancelled(new Error(action.dispatched ? "outcome_unknown" : "not_sent"));
      },
    };
    page.activeAction = action;
    if (request.operation === "act") {
      // A hidden View can retain keyboard focus. Move focus only if this page
      // owns the foreground window's native focus; never raise a background app.
      if (this.presentation.window.isFocused() && c.isFocused()) {
        this.human_input.nativeInputOwner = page.id;
        this.presentation.window.webContents.focus();
      }
      page.view.setVisible(false);
    }
    const stepTimeout =
      request.operation === "wait"
        ? Math.min(30000, request.parameters.timeoutMs + 1000)
        : request.parameters.action.kind === "drag"
          ? 12000
          : 5000;
    let waitResult,
      noOp = false,
      actualControl,
      stateMatched;
    const invalidatesObservation =
      request.parameters.action?.kind === "scroll" || request.parameters.action?.kind === "hover";
    const deadline = setTimeout(
      () => action.cancel(),
      request.batchDeadline
        ? Math.max(1, Math.min(stepTimeout, request.batchDeadline - performance.now()))
        : stepTimeout,
    );
    try {
      if (request.operation === "wait") {
        waitResult = await this.wait_conditions.waitForAction(
          request,
          page,
          c,
          saved,
          action,
          stop,
          readiness,
        );
      } else {
        if (!c.debugger.isAttached()) c.debugger.attach("1.3");
        const coordinate = coordinateKinds.has(request.parameters.action.kind),
          scroll = request.parameters.action.kind === "scroll";
        const refTarget = !coordinate && !scroll;
        let nativeTarget = refTarget
          ? await Promise.race([
              this.native_targets.actionTarget(page, c, request.parameters.action.ref),
              stop,
            ])
          : null;
        const expectedTarget = saved.plan.target;
        if (!expectedTarget) throw new Error("plan_stale");
        if (
          nativeTarget &&
          (nativeTarget.identity !== saved.targetIdentity ||
            nativeTarget.x !== expectedTarget.x ||
            nativeTarget.y !== expectedTarget.y ||
            nativeTarget.role !== expectedTarget.role ||
            nativeTarget.name !== expectedTarget.name)
        )
          throw new Error("plan_stale");
        await Promise.race([new Promise((resolve) => setTimeout(resolve, 50)), stop]);
        if (refTarget)
          nativeTarget = await Promise.race([
            this.native_targets.actionTarget(page, c, request.parameters.action.ref),
            stop,
          ]);
        const currentViewport = await Promise.race([readViewport(c), stop]);
        if (
          (nativeTarget &&
            (nativeTarget.identity !== saved.targetIdentity ||
              nativeTarget.x !== expectedTarget.x ||
              nativeTarget.y !== expectedTarget.y ||
              nativeTarget.role !== expectedTarget.role ||
              nativeTarget.name !== expectedTarget.name)) ||
          viewportFacts(this.presentation.window, page, currentViewport).key !==
            saved.plan.viewportKey ||
          c.getURL() !== saved.pageUrl ||
          page.controlEpoch !== saved.plan.controlEpoch
        )
          throw new Error("plan_stale");
        const target = nativeTarget ?? expectedTarget;
        let native = null;
        if (saved.native) {
          native = (
            await Promise.race([
              this.native_targets.nativeControl(page, c, request.parameters.action.ref),
              stop,
            ])
          ).control;
          if (
            !native ||
            !native.enabled ||
            native.identity !== saved.native.identity ||
            native.kind !== saved.native.kind ||
            (native.kind === "select" && !isDeepStrictEqual(native, saved.native))
          )
            throw new Error("plan_stale");
          noOp = native.kind === "checkbox" && native.checked === request.parameters.action.checked;
          if (noOp) {
            actualControl = publicNativeControl(page, native);
            stateMatched = true;
          }
        }
        let navigationIntent = null;
        if (saved.plan.target?.semantics) {
          if (!nativeTarget) throw new Error("plan_stale");
          const semantics = await (saved.plan.localDevelopment
            ? this.native_targets.linkNavigationSemantics(
                page,
                c,
                nativeTarget,
                request.parameters.action,
              )
            : this.native_targets.publicActionSemantics(
                page,
                c,
                nativeTarget,
                request.parameters.action,
              ));
          if (!isDeepStrictEqual(semantics, saved.plan.target.semantics))
            throw new Error("plan_stale");
          if (semantics?.kind === "public_search" || semantics?.kind === "link_navigation")
            navigationIntent = semantics;
        }
        // If the native page still owns local keyboard focus, do not dispatch.
        // before-input-event cannot distinguish a physical key from CDP echo.
        if (this.presentation.window.isFocused() && c.isFocused()) throw new Error("not_sent");
        /** @param {number|null} releaseFrame */
        const live = (releaseFrame = null) => {
          // Ref press 仅接受主文档；已确认 keyDown 的单次释放可跨子 Frame 失效，不能继续旧 Ref 动作。
          const releaseCurrent =
            releaseFrame !== null &&
            (page.frameDocumentGeneration ?? 0) === releaseFrame &&
            page.view?.webContents === c &&
            page.pageGeneration === saved.plan.pageGeneration &&
            this.workspace.browserHostId === request.browserHostId &&
            this.workspace.hostGeneration === request.hostGeneration &&
            page.coreInstanceId === request.coreInstanceId;
          if (
            action.cancelled ||
            request.batchGuard?.() ||
            !this.workspace.pageStillOwned(page) ||
            page.control !== "agent" ||
            page.controlEpoch !== saved.plan.controlEpoch ||
            (page.documentGeneration !== saved.plan.documentEpoch &&
              page.documentGeneration !== action.navigationDocument &&
              !releaseCurrent) ||
            page.viewportRevision !== saved.plan.viewportRevision ||
            c.isDestroyed()
          )
            throw new Error(action.dispatched ? "outcome_unknown" : "plan_stale");
        };
        /** @param {Parameters<InstanceType<typeof import("./control.cjs").PageControl>["dispatchInput"]>[2]} params */
        const input = (params) => {
          live();
          action.dispatched = true;
          return this.control.dispatchInput(page, "Input.dispatchMouseEvent", params);
        };
        /** @param {Parameters<InstanceType<typeof import("./control.cjs").PageControl>["dispatchInput"]>[2]} params @param {number|null} releaseFrame */
        const keyboard = (params, releaseFrame = null) => {
          live(params.type === "keyUp" && page.heldKeys.has(params.key) ? releaseFrame : null);
          action.dispatched = true;
          return this.control.dispatchInput(page, "Input.dispatchKeyEvent", params);
        };
        /** @param {import("./model.js").ActionTarget|undefined} point */
        const click = async (point) => {
          if (!point || point.x === undefined || point.y === undefined)
            throw new Error("plan_stale");
          await input({
            type: "mousePressed",
            x: point.x,
            y: point.y,
            button: "left",
            clickCount: 1,
          });
          await input({
            type: "mouseReleased",
            x: point.x,
            y: point.y,
            button: "left",
            clickCount: 1,
          });
        };
        await Promise.race([
          (async () => {
            live();
            if (navigationIntent) page.document?.revoke();
            page.approvedActionNavigation = navigationIntent
              ? {
                  ...navigationIntent,
                  controlEpoch: page.controlEpoch,
                  pageGeneration: page.pageGeneration,
                  expiresAt: Date.now() + 30000,
                }
              : null;
            if (request.parameters.action.kind === "setChecked" && noOp) return;
            if (request.parameters.action.kind === "selectOption") {
              if (!nativeTarget || !saved.native) throw new Error("plan_stale");
              const result = await this.native_targets.selectNativeOption(
                page,
                c,
                nativeTarget,
                saved.native,
                request.parameters.action.value,
                (params) => {
                  live();
                  action.dispatched = true;
                  return this.control.dispatchInput(page, "Runtime.callFunctionOn", params);
                },
              );
              if (result.exceptionDetails || !result.result?.value)
                throw new Error("outcome_unknown");
              const receipt = result.result.value;
              if (receipt.accepted === false) {
                action.dispatched = false;
                throw new Error("plan_stale");
              }
              noOp = receipt.noOp;
              if (noOp) action.dispatched = false;
              stateMatched =
                receipt.control?.kind === "select" &&
                receipt.control.options[receipt.control.selectedIndex]?.value ===
                  request.parameters.action.value;
            } else if (scroll) {
              await input({
                type: "mouseWheel",
                x: target.x,
                y: target.y,
                deltaX: request.parameters.action.deltaX,
                deltaY: request.parameters.action.deltaY,
              });
            } else if (request.parameters.action.kind === "hover") {
              await input({ type: "mouseMoved", x: target.x, y: target.y, button: "none" });
            } else if (request.parameters.action.kind === "drag") {
              const { from, to, steps } = expectedTarget;
              if (!from || !to || steps === undefined) throw new Error("plan_stale");
              await input({ type: "mouseMoved", x: from.x, y: from.y, button: "none" });
              await input({
                type: "mousePressed",
                x: from.x,
                y: from.y,
                button: "left",
                clickCount: 1,
              });
              for (let step = 1; step <= steps; step++)
                await input({
                  type: "mouseMoved",
                  x: from.x + ((to.x - from.x) * step) / steps,
                  y: from.y + ((to.y - from.y) * step) / steps,
                  button: "left",
                  buttons: 1,
                });
              await input({
                type: "mouseReleased",
                x: to.x,
                y: to.y,
                button: "left",
                clickCount: 1,
              });
            } else if (request.parameters.action.kind === "press") {
              if (!nativeTarget) throw new Error("plan_stale");
              live();
              action.dispatched = true;
              await this.control.dispatchInput(page, "DOM.focus", {
                backendNodeId: nativeTarget.backendNodeId,
              });
            } else await click(coordinate ? expectedTarget.point : target);
            if (request.parameters.action.kind === "setChecked") {
              const after = (
                await this.native_targets.nativeControl(page, c, request.parameters.action.ref)
              ).control;
              actualControl = publicNativeControl(page, after);
              stateMatched =
                after?.kind === "checkbox" && after.checked === request.parameters.action.checked;
            }
            if (request.parameters.action.kind === "fill") {
              const modifier = process.platform === "darwin" ? 4 : 2;
              // macOS 的 CDP 输入还需显式编辑命令，单独的 Command+A 不会执行全选。
              await keyboard({
                type: "keyDown",
                key: "a",
                code: "KeyA",
                windowsVirtualKeyCode: 65,
                modifiers: modifier,
                ...(process.platform === "darwin" ? { commands: ["selectAll"] } : {}),
              });
              await keyboard({
                type: "keyUp",
                key: "a",
                code: "KeyA",
                windowsVirtualKeyCode: 65,
                modifiers: modifier,
              });
              live();
              action.dispatched = true;
              await this.control.dispatchInput(page, "Input.insertText", {
                text: request.parameters.action.value,
              });
            } else if (
              request.parameters.action.kind === "press" ||
              request.parameters.action.kind === "pressAt"
            ) {
              const key = request.parameters.action.key;
              const code = {
                Enter: 13,
                Tab: 9,
                Escape: 27,
                Backspace: 8,
                ArrowLeft: 37,
                ArrowUp: 38,
                ArrowRight: 39,
                ArrowDown: 40,
              }[key];
              const text = key === "Enter" ? "\r" : undefined;
              const releaseFrame =
                request.parameters.action.kind === "press"
                  ? (page.frameDocumentGeneration ?? 0)
                  : null;
              await keyboard({
                type: "keyDown",
                key,
                code: key,
                windowsVirtualKeyCode: code,
                ...(text ? { text, unmodifiedText: text } : {}),
              });
              // 仅成功 await 原生 keyDown ACK 后授予该 keyUp 释放资格；丢失 ACK 仍由撤权清理收敛。
              await keyboard(
                { type: "keyUp", key, code: key, windowsVirtualKeyCode: code },
                releaseFrame,
              );
            }
          })(),
          stop,
        ]);
      }
      if (
        !this.workspace.pageStillOwned(page) ||
        page.control !== "agent" ||
        page.controlEpoch !== saved.plan.controlEpoch
      )
        throw new Error(action.dispatched ? "outcome_unknown" : "not_sent");
      if (invalidatesObservation && !request.batchGuard) invalidateActionObservation(page);
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
        dispatch: action.dispatched || noOp ? "confirmed" : "not_sent",
        inputConfirmed: action.dispatched,
        ...(noOp ? { noOp: true } : {}),
        ...(actualControl ? { nativeControl: actualControl } : {}),
        ...(stateMatched !== undefined ? { stateMatched } : {}),
        ...(invalidatesObservation ? { observationInvalidated: true } : {}),
        verification: "not_checked",
        ...(waitResult ? { wait: waitResult } : {}),
        preparedActionId: saved.plan.preparedActionId,
      };
    } catch (error) {
      if (action.dispatched || action.cancelled) page.approvedActionNavigation = null;
      if (action.dispatched) throw new Error("outcome_unknown");
      throw error;
    } finally {
      clearTimeout(deadline);
      if (page.activeAction === action) page.activeAction = null;
      if (request.operation === "act") page.lastCapture = null;
      if (
        page.control === "agent" &&
        page.controlEpoch === saved.plan.controlEpoch &&
        page.inputPending.size === 0 &&
        page.heldButtons.size === 0 &&
        page.heldKeys.size === 0
      ) {
        if (!c.isDestroyed() && c.debugger.isAttached() && !page.diagnosticsReady)
          c.debugger.detach();
        page.view?.setVisible(
          !this.presentation.suppressedPresentation &&
            this.workspace.pageStillOwned(page) &&
            this.presentation.owner ===
              pageKey(page.coreInstanceId, page.projectId, page.threadId, page.id) &&
            page.requestedVisible === true,
        );
      } else if (page.control === "agent" && page.controlEpoch === saved.plan.controlEpoch) {
        // Even a failed action must release native input before local input resumes.
        page.control = "transferring";
        page.controlEpoch++;
        page.refs.clear();
        page.plans.clear();
        page.lastObservation = null;
        page.needsObservation = true;
        this.control.onRevoke?.({
          projectId: page.projectId,
          threadId: page.threadId,
          pageId: page.id,
        });
        void this.control.convergeInput(page);
      }
    }
  }
}

module.exports = { ApprovedActions };
