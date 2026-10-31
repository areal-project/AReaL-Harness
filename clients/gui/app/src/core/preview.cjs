// @ts-check
"use strict";
const { performance } = require("node:perf_hooks");
const { randomUUID } = require("node:crypto");
const { loadNavigationDocument } = require("./browser-navigation.cjs");
const { NativeDocuments } = require("./preview-native/documents.cjs");
const { pageKey, workspaceKey } = require("./preview-native/identity.cjs");
const { nativeWithin } = require("./preview-native/read-session.cjs");
const { PreviewWorkspace } = require("./preview-native/workspace.cjs");
const { PreviewPresentation } = require("./preview-native/presentation.cjs");
const { PageControl } = require("./preview-native/control.cjs");
const { HumanBrowserInput } = require("./preview-native/human-input.cjs");
const { PageAnnotations } = require("./preview-native/annotations.cjs");
const { HumanPageCapture } = require("./preview-native/human-capture.cjs");
const { PageStyleTrials } = require("./preview-native/style-trials.cjs");
const { PageDiagnostics } = require("./preview-native/page-diagnostics.cjs");
const { NativePageTargets } = require("./preview-native/native-targets.cjs");
const { ApprovedNavigation } = require("./preview-native/navigation.cjs");
const { ApprovedBatches } = require("./preview-native/batches.cjs");
const { BrowserDiscovery } = require("./preview-native/discovery.cjs");
const { BrowserReads } = require("./preview-native/reads.cjs");
const { BrowserCommands } = require("./preview-native/commands.cjs");
const { ApprovedActions } = require("./preview-native/actions.cjs");
const { NativePageLifecycle } = require("./preview-native/lifecycle.cjs");
const { HumanBrowserCommands } = require("./preview-native/ui-commands.cjs");
const { HumanDownloads } = require("./preview-native/downloads.cjs");
const { NativeCommandExecution } = require("./preview-native/native-command.cjs");
const { BrowserWaitConditions } = require("./preview-native/wait-conditions.cjs");

class CorePreview {
  /**
   * @param {import("electron").BrowserWindow} window
   * @param {typeof import("electron").WebContentsView} WebContentsView
   * @param {import("./preview-native/model.js").Ownership} owns
   * @param {()=>import("./preview-native/model.js").PreviewPreferences} preferences
   * @param {import("./preview-native/model.js").CoreIdentity} coreIdentity
   * @param {()=>string[]} controlEndpoints
   * @param {(prompt:import("./preview-native/model.js").DevelopmentPrompt)=>Promise<boolean>} confirmDevelopmentOrigin
   * @param {import("./preview-native/model.js").DocumentWorkspace} documentWorkspace
   * @param {import("./preview-native/model.js").Ownership} retainsOwner
   */
  constructor(
    window,
    WebContentsView,
    owns,
    preferences = () => ({}),
    coreIdentity = () => null,
    controlEndpoints = () => [],
    confirmDevelopmentOrigin = async () => false,
    retainsOwner = () => false,
    documentWorkspace = () => {
      throw new Error("document_workspace_unavailable");
    },
  ) {
    this.documents = new NativeDocuments();
    this.documentWorkspace = documentWorkspace;
    this.workspace = new PreviewWorkspace(owns, coreIdentity, retainsOwner, controlEndpoints, () =>
      this.quiesceBrowserPages(),
    );
    this.presentation = new PreviewPresentation(
      this.workspace,
      (page) => this.human_input.cancelHumanGesture(page),
      window,
    );
    this.page_diagnostics = new PageDiagnostics(this.workspace, (page) =>
      this.control.revoke(page),
    );
    this.control = new PageControl(
      this.page_diagnostics,
      this.presentation,
      this.workspace,
      () => this.human_input.humanMouseGesture,
      (page) => this.style_trials.clearStyleTrial(page),
      (identity) => this.onRevoke?.(identity),
    );
    this.human_input = new HumanBrowserInput(this.control, this.presentation, this.workspace);
    this.native_targets = new NativePageTargets();
    this.downloads = new HumanDownloads(this.presentation, this.workspace, (page, event, item) =>
      this.commands.acceptCommandDownload(page, event, item),
    );
    this.lifecycle = new NativePageLifecycle(
      this.control,
      this.downloads,
      this.human_input,
      this.native_targets,
      this.page_diagnostics,
      this.presentation,
      this.workspace,
      WebContentsView,
    );
    this.human_capture = new HumanPageCapture(this.control, this.presentation, this.workspace);
    this.annotations = new PageAnnotations(
      this.control,
      this.human_capture,
      this.presentation,
      this.workspace,
    );
    this.style_trials = new PageStyleTrials(
      this.annotations,
      this.human_capture,
      this.presentation,
      this.workspace,
    );
    this.wait_conditions = new BrowserWaitConditions(this.native_targets, this.workspace);
    this.actions = new ApprovedActions(
      this.control,
      this.human_input,
      this.native_targets,
      this.presentation,
      this.wait_conditions,
      this.workspace,
    );
    this.native_command = new NativeCommandExecution(
      this.control,
      this.human_input,
      this.presentation,
      this.workspace,
      (page) => this.commands.commandArtifactRoot(page),
      (entry) => this.commands.commandRecordingStatus(entry),
    );
    this.commands = new BrowserCommands(
      this.control,
      this.lifecycle,
      this.native_command,
      this.presentation,
      this.workspace,
    );
    this.reads = new BrowserReads(
      this.native_targets,
      this.presentation,
      this.workspace,
      (request) => this.page_diagnostics.diagnostics(request),
    );
    this.navigation = new ApprovedNavigation(this.control, this.lifecycle, this.workspace);
    this.batches = new ApprovedBatches(
      this.workspace,
      (request) => this.actions.execute(request),
      (request) => this.actions.prepare(request),
    );
    this.discovery = new BrowserDiscovery(this.control, this.lifecycle, this.workspace);
    this.ui_commands = new HumanBrowserCommands(
      this.annotations,
      this.control,
      this.human_capture,
      this.human_input,
      this.lifecycle,
      this.presentation,
      this.style_trials,
      this.workspace,
      preferences,
      controlEndpoints,
      confirmDevelopmentOrigin,
    );
  }
  /** @type {((identity:import("./preview-native/model.js").Revocation)=>void)|undefined} */
  onRevoke;
  get browserHostId() {
    return this.workspace.browserHostId;
  }
  get hostGeneration() {
    return this.workspace.hostGeneration;
  }
  get suppressedPresentation() {
    return this.presentation.suppressedPresentation;
  }
  /** @param {Parameters<CorePreview["workspace"]["page"]>[0]} projectId @param {Parameters<CorePreview["workspace"]["page"]>[1]} threadId @param {Parameters<CorePreview["workspace"]["page"]>[2]} pageId */
  page(projectId, threadId, pageId) {
    return this.workspace.page(projectId, threadId, pageId);
  }
  /** @param {Parameters<CorePreview["workspace"]["pageStillOwned"]>[0]} page */
  pageStillOwned(page) {
    return this.workspace.pageStillOwned(page);
  }
  /** @param {Parameters<CorePreview["workspace"]["subscribe"]>[0]} projectId @param {Parameters<CorePreview["workspace"]["subscribe"]>[1]} threadId @param {Parameters<CorePreview["workspace"]["subscribe"]>[2]} listener */
  subscribe(projectId, threadId, listener) {
    return this.workspace.subscribe(projectId, threadId, listener);
  }
  /** @param {Parameters<CorePreview["presentation"]["state"]>[0]} page */
  state(page) {
    return this.presentation.state(page);
  }
  /** @param {Parameters<CorePreview["presentation"]["setPresentationSuppressed"]>[0]} suppressed */
  setPresentationSuppressed(suppressed) {
    return this.presentation.setPresentationSuppressed(suppressed);
  }
  /** @param {Parameters<CorePreview["presentation"]["currentDevelopmentPrompt"]>[0]} page @param {Parameters<CorePreview["presentation"]["currentDevelopmentPrompt"]>[1]} fence */
  currentDevelopmentPrompt(page, fence) {
    return this.presentation.currentDevelopmentPrompt(page, fence);
  }
  /** @param {Parameters<CorePreview["discovery"]["prepareDiscovery"]>[0]} request */
  prepareDiscovery(request) {
    return this.discovery.prepareDiscovery(request);
  }
  /** @param {Parameters<CorePreview["discovery"]["consumeDiscovery"]>[0]} request */
  consumeDiscovery(request) {
    return this.discovery.consumeDiscovery(request);
  }
  /** @param {Parameters<CorePreview["discovery"]["ensureAgentPage"]>[0]} projectId @param {Parameters<CorePreview["discovery"]["ensureAgentPage"]>[1]} threadId */
  ensureAgentPage(projectId, threadId) {
    return this.discovery.ensureAgentPage(projectId, threadId);
  }
  /** @param {Parameters<CorePreview["control"]["controlPermit"]>[0]} projectId @param {Parameters<CorePreview["control"]["controlPermit"]>[1]} threadId @param {Parameters<CorePreview["control"]["controlPermit"]>[2]} pageId */
  controlPermit(projectId, threadId, pageId) {
    return this.control.controlPermit(projectId, threadId, pageId);
  }
  /** @param {Parameters<CorePreview["control"]["claim"]>[0]} projectId @param {Parameters<CorePreview["control"]["claim"]>[1]} threadId @param {Parameters<CorePreview["control"]["claim"]>[2]} pageId */
  claim(projectId, threadId, pageId) {
    return this.control.claim(projectId, threadId, pageId);
  }
  /** @param {Parameters<CorePreview["control"]["takeover"]>[0]} projectId @param {Parameters<CorePreview["control"]["takeover"]>[1]} threadId @param {Parameters<CorePreview["control"]["takeover"]>[2]} pageId */
  takeover(projectId, threadId, pageId) {
    return this.control.takeover(projectId, threadId, pageId);
  }
  revokeAll() {
    return this.control.revokeAll();
  }
  /** @param {Parameters<CorePreview["reads"]["cancelRead"]>[0]} request */
  cancelRead(request) {
    return this.reads.cancelRead(request);
  }
  releaseInvalidOwners() {
    return this.lifecycle.releaseInvalidOwners();
  }
  /** @param {Parameters<CorePreview["ui_commands"]["command"]>[0]} request */
  command(request) {
    return this.ui_commands.command(request);
  }
  /** @param {Parameters<CorePreview["workspace"]["profile"]["browserData"]>[0]} operation @param {Parameters<CorePreview["workspace"]["profile"]["browserData"]>[1]} options */
  browserData(operation, options) {
    return this.workspace.profile.browserData(operation, options);
  }
  /** @param {{projectId:string,threadId:string,path:string,workspacePath:string,valid:()=>boolean}} request */
  async openDocument(request) {
    this.workspace.profile.assertAvailable();
    const prepared = await this.documents.prepareFile(request);
    if (!request.valid() || !this.workspace.owns(request.projectId, request.threadId))
      throw new Error("document_owner_changed");
    const id = randomUUID();
    const core = this.workspace.coreIdentity(request.projectId, request.threadId);
    const key = pageKey(core, request.projectId, request.threadId, id);
    const page = this.lifecycle.create(key, request.projectId, request.threadId, {
      id,
      origin: "human",
    });
    let dispatched = false;
    /** @type {NodeJS.Timeout|undefined} */ let timer;
    /** @type {Promise<never>} */ const stopped = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("outcome_unknown")), 12000);
    });
    try {
      const grant = await this.documents.bindPage(page, prepared, this.workspace);
      if (!request.valid() || !this.workspace.pageStillOwned(page))
        throw new Error("document_owner_changed");
      page.approvedNavigation = grant.entryUrl;
      page.url = grant.entryUrl;
      dispatched = true;
      const navigation = await loadNavigationDocument(
        page.view.webContents,
        grant.entryUrl,
        stopped,
      );
      if (!request.valid() || !this.workspace.pageStillOwned(page))
        throw new Error("outcome_unknown");
      this.workspace.selected.set(workspaceKey(core, request.projectId, request.threadId), id);
      this.workspace.changed(page);
      return {
        pageId: id,
        url: navigation.url,
        dispatch: "confirmed",
        readiness: navigation.readiness,
      };
    } catch (error) {
      if (!dispatched) this.lifecycle.release(key);
      if (dispatched) throw new Error("outcome_unknown", { cause: error });
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  /** @param {import("./preview-native/model.js").HostRequest} request */
  prepare(request) {
    this.workspace.profile.assertAvailable();
    if (request.phase !== "prepare") throw new Error("not_sent");
    if (request.operation === "command") return this.commands.prepareCommand(request);
    if (request.operation === "openDocument")
      return this.documents.prepare(request, this.workspace, this.documentWorkspace);
    if (
      request.operation === "observe" ||
      request.operation === "capture" ||
      request.operation === "diagnostics"
    )
      return this.reads.prepareRead(request);
    if (request.operation === "runBatch") return this.batches.prepareBatch(request);
    if (request.operation === "navigate" || request.operation === "newPage")
      return this.navigation.prepareNavigation(request);
    if (request.operation !== "act" && request.operation !== "wait") throw new Error("not_sent");
    return this.actions.prepare(request);
  }
  /** @param {import("./preview-native/model.js").HostRequest} request */
  execute(request) {
    this.workspace.profile.assertAvailable();
    if (request.phase !== "execute") throw new Error("not_sent");
    if (request.operation === "command") return this.commands.executeCommand(request);
    if (request.operation === "openDocument")
      return this.documents.execute(request, this.workspace);
    if (
      request.operation === "observe" ||
      request.operation === "capture" ||
      request.operation === "diagnostics"
    )
      return this.reads.executeRead(request);
    if (request.operation === "runBatch") return this.batches.executeBatch(request);
    if (request.operation === "navigate" || request.operation === "newPage")
      return this.navigation.executeNavigation(request);
    if (request.operation !== "act" && request.operation !== "wait") throw new Error("not_sent");
    return this.actions.execute(request);
  }
  dispose() {
    const recordings = [...this.workspace.pages.values()]
      .map((page) => page.commandRecording?.promise)
      .filter((c) => c !== undefined && c !== null);
    const contents = [...this.workspace.pages.values()]
      .map((page) => page.view?.webContents)
      .filter((c) => c !== undefined && c !== null);
    this.discovery.discoveryPlans.clear();
    for (const key of Array.from(this.workspace.pages.keys())) this.lifecycle.release(key);
    this.presentation.view = null;
    this.presentation.owner = null;
    this.workspace.fileReceipts.clear();
    this.workspace.unregisterProfileHost?.();
    this.workspace.unregisterProfileHost = null;
    return nativeWithin(
      Promise.allSettled([
        this.documents.dispose(),
        ...recordings,
        ...contents
          .filter((c) => !c.isDestroyed())
          .map((c) => new Promise((resolve) => c.once("destroyed", () => resolve(undefined)))),
      ]),
      performance.now() + 10000,
    ).then(() => this.workspace.profile.flush());
  }
  async quiesceBrowserPages() {
    const pages = [...this.workspace.pages.values()];
    const recordings = pages
      .map((page) => page.commandRecording?.promise)
      .filter((c) => c !== undefined && c !== null);
    const native = pages
      .map((page) => page.view?.webContents)
      .filter((c) => c !== undefined && c !== null);
    this.discovery.discoveryPlans.clear();
    for (const page of pages) {
      this.human_input.cancelHumanGesture(page);
      page.activeRead?.cancel();
      page.activeSelection?.cancel();
      page.claiming?.cancel();
      this.control.revoke(page);
    }
    try {
      await nativeWithin(
        Promise.allSettled(pages.map((page) => this.control.convergeInput(page))),
        performance.now() + 5000,
      );
    } finally {
      for (const page of pages)
        this.lifecycle.release(
          pageKey(page.coreInstanceId, page.projectId, page.threadId, page.id),
        );
    }
    await nativeWithin(Promise.allSettled(recordings), performance.now() + 10000);
    await nativeWithin(
      Promise.all(
        native
          .filter((c) => !c.isDestroyed())
          .map((c) => new Promise((resolve) => c.once("destroyed", () => resolve(undefined)))),
      ),
      performance.now() + 5000,
    );
  }
}

module.exports = { CorePreview };
