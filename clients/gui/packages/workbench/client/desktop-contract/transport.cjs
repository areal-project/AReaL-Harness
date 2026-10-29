// @ts-check
"use strict";
/** @typedef {import('../desktop-contract.cjs').Requests} Requests */
/** @typedef {import('../desktop-contract.cjs').DesktopError} DesktopError */
/** @typedef {keyof typeof commandDefinitions} CommandName */

/** @typedef {{effect:'read'|'subscription'|'mutation',requestId?:'requestId'|'draftId'}} CommandEffect */
/** @type {CommandEffect} */
const read = Object.freeze({ effect: "read" });
/** @type {CommandEffect} */
const subscription = Object.freeze({ effect: "subscription" });
/** @type {CommandEffect} */
const mutation = Object.freeze({ effect: "mutation" });
/** @type {CommandEffect} */
const recoverable = Object.freeze({ effect: "mutation", requestId: "requestId" });
/** @param {CommandEffect} semantics @param {string} names */
const operations = (semantics, names) =>
  Object.fromEntries(names.split(" ").map((name) => [name, semantics]));
/** @satisfies {Record<keyof Requests,readonly ['main'|'service','app'|'project'|'thread',CommandEffect|Record<string,CommandEffect>]>} */
const commandDefinitions = Object.freeze({
  cloud: ["service", "app", { status: read, save: mutation }],
  cloudSession: [
    "service",
    "project",
    { ...operations(subscription, "open"), ...operations(mutation, "create reconnect send stop") },
  ],
  connect: ["service", "project", subscription],
  list: ["service", "project", read],
  open: ["service", "thread", subscription],
  history: ["service", "thread", operations(read, "acquire loadOlder loadItem release")],
  create: ["service", "project", recoverable],
  prepareCreator: ["service", "project", mutation],
  fork: ["service", "project", recoverable],
  side: [
    "service",
    "project",
    {
      ...operations(read, "recover context list"),
      ...operations(recoverable, "start send create close"),
    },
  ],
  prediction: ["service", "thread", mutation],
  send: ["service", "thread", recoverable],
  editMessage: ["service", "thread", recoverable],
  continue: ["service", "thread", recoverable],
  stop: ["service", "thread", recoverable],
  attachBrowser: ["service", "thread", recoverable],
  respond: ["service", "thread", mutation],
  reconcile: ["service", "project", read],
  configure: ["service", "thread", recoverable],
  queue: ["service", "thread", read],
  queueEdit: ["service", "thread", recoverable],
  library: [
    "service",
    "app",
    operations(
      mutation,
      "dropSidebar renameProject renameThread pinThread pinProject createSection renameSection removeSection orderSection moveThread moveProject readThread markAllRead orderSidebarThread hideProject orderProject orderThread settings",
    ),
  ],
  manage: [
    "service",
    "project",
    {
      ...operations(
        read,
        "pluginHooks pluginMcp mcpApps genUiSource mcpForms mcpToolResult plugins plugin providers mcp profile skills skill inspect context inheritedHistory plan processes process processWait goal permissions interactions processOutput executions execution executionArtifact executionWait agents agentWait workflows server workflow workgroupPolicy workgroups workgroup workgroupWait workgroupArtifact workgroupArtifactStatus workgroupCapabilities workgroupSubmission pluginCapabilities pluginReadiness pluginSubmission processSubmission agentSubmission mcpFormResourceSubmission tasks task taskInbox taskChannel taskDraftHistory taskDraftRead taskSchedulePreview taskScheduleContext taskHistoryCapabilities taskRuns taskRun",
      ),
      ...operations(subscription, "taskWatch taskUnwatch"),
      ...operations(
        recoverable,
        "pluginArchiveImport mcpFormResourceStage pluginHooksConfigure hookAcknowledge marketplaceAdd marketplaceAddGit marketplaceRemove marketplaceUpdate pluginResolve pluginAuthConfigure pluginConnection connectorConfigure connectorCredential pluginInstall pluginConfigure pluginComponentConfigure pluginUninstall pluginSetup providerSave providerRemove mcpSave mcpConnect mcpDisconnect archive unarchive processCloseStdin processStart processWrite processResize processTerminate goalCreate goalUpdate goalPause goalResume goalClear workgroupStart workflowStart workgroupRevise agentSpawn taskCreate taskUpdate taskRunNow taskPause taskResume taskStopRun taskResumeRun taskCancel taskDelete taskReply taskDraftSend",
      ),
      ...operations(
        mutation,
        "pluginArchivePick pluginAuth pluginAuthCredential mcpAppOpen mcpAppOpenFromResult mcpAppRequest mcpAppClose mcpExtensionCall mcpFormRespond mcpFormPreview mcpFormResourcePrepare mcpFormResourceRelease executionCancel executionApply serverDrain serverGc workgroupApplyArtifact workgroupCancel closeResources planUpdate toolAcknowledge contextCompact permissionsForget providerProbe taskDraftConfirm",
      ),
      taskDraftStart: { effect: "mutation", requestId: "draftId" },
    },
  ],
  workspace: [
    "service",
    "project",
    {
      ...operations(
        read,
        "worktreeList worktreeOptions worktreeRead list search read review reviewCommits reviewBranches turnReview status info gitState",
      ),
      ...operations(recoverable, "worktreeCreate worktreeAction worktreeDelete"),
      ...operations(
        mutation,
        "worktreeSettings worktreeEnvironmentSave worktreeEnvironmentDelete worktreeCancel worktreeOpen save gitStage gitUnstage gitCommit gitPush",
      ),
    },
  ],
  media: [
    "service",
    "thread",
    { ...operations(read, "list read"), upload: mutation, release: recoverable },
  ],
  steer: ["service", "thread", recoverable],
  dismissRecovery: ["service", "project", mutation],
  providers: [
    "service",
    "app",
    {
      ...operations(read, "list revealKey discover"),
      ...operations(
        mutation,
        "probe apply save saveAndApply removeAndApply defaultAndApply remove default",
      ),
    },
  ],
  chatgpt: [
    "service",
    "app",
    operations(mutation, "status login forget logout selectAccount cancel probe"),
  ],
  analytics: ["service", "app", { ...operations(read, "read sync") }],
  resources: [
    "service",
    "app",
    {
      ...operations(read, "hooks builtinSkill skills mcp skillRead"),
      ...operations(mutation, "hooksSave skillToggle skillSave mcpSave mcpConnect mcpDisconnect"),
    },
  ],
  projectless: ["service", "app", { catalog: read, directory: mutation, prepare: recoverable }],
  tasks: ["service", "app", operations(read, "list inbox preview observe")],
  trajectory: ["service", "app", { status: read, ...operations(mutation, "retry setEnabled") }],
  feedback: [
    "service",
    "app",
    {
      ...operations(read, "status read"),
      ...operations(mutation, "preference prepare draft refine submit close"),
    },
  ],
  serviceLifecycle: [
    "main",
    "app",
    { check: read, ...operations(mutation, "update stop recover quitInterface stopAndQuit") },
  ],
  serviceStatus: ["main", "app", read],
  stopService: ["main", "app", mutation],
  recoverResources: ["main", "app", mutation],
  browserData: [
    "main",
    "app",
    { status: read, ...operations(mutation, "importChrome clearCache clearAll") },
  ],
  computerControl: [
    "main",
    "app",
    { status: read, ...operations(mutation, "requestAccess openSettings restart stop") },
  ],
  exportDiagnostics: ["main", "app", read],
  connectService: ["main", "app", subscription],
  export: ["main", "thread", read],
  remoteControl: ["main", "app", mutation],
});
/** @param {string} name @param {Record<string,unknown>} request @returns {CommandEffect} */
function commandSemantics(name, request) {
  const definition = commandDefinitions[/** @type {CommandName} */ (name)];
  if (!definition) invalid();
  const declared = /** @type {CommandEffect|Record<string,CommandEffect>} */ (definition[2]);
  const selected =
    typeof declared.effect === "string"
      ? /** @type {CommandEffect} */ (declared)
      : /** @type {Record<string,CommandEffect>} */ (declared)[String(request.operation)];
  if (!selected || !["read", "subscription", "mutation"].includes(selected.effect)) invalid();
  return selected;
}
/** @param {unknown} value @returns {value is Record<string,unknown>} */
function record(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
/** @param {unknown} value @returns {value is string} */
function identifier(value) {
  return typeof value === "string" && !!value.trim() && value.length <= 256;
}
/** @returns {never} */
function invalid() {
  throw Object.assign(new Error("无效桌面操作或参数"), { code: "INVALID_DESKTOP_REQUEST" });
}
/** @param {unknown} error @returns {DesktopError} */
function desktopError(error) {
  const value = record(error) || error instanceof Error ? error : {};
  const code = "code" in value ? value.code : undefined;
  const requestId = "requestId" in value ? value.requestId : undefined;
  const reason =
    "data" in value && record(value.data) && typeof value.data.reason === "string"
      ? value.data.reason
      : "reason" in value && typeof value.reason === "string"
        ? value.reason
        : undefined;
  const data = "data" in value && record(value.data) ? value.data : {};
  const rawOutcome = "outcome" in value ? value.outcome : data.outcome;
  const rawRecovery = "recovery" in value ? value.recovery : data.recovery;
  /** @type {DesktopError['outcome']} */
  let outcome;
  if (record(rawOutcome) && (rawOutcome.kind === "noMutation" || rawOutcome.kind === "rejected"))
    outcome = { kind: rawOutcome.kind };
  if (
    record(rawOutcome) &&
    (rawOutcome.kind === "admitted" || rawOutcome.kind === "unconfirmed") &&
    record(rawOutcome.operation)
  ) {
    const op = rawOutcome.operation;
    const target = op.target;
    if (
      typeof op.method === "string" &&
      /^[A-Za-z][A-Za-z0-9/]*$/.test(op.method) &&
      op.method.length <= 128 &&
      (op.requestId === undefined || identifier(op.requestId)) &&
      record(target)
    ) {
      /** @type {import('../../../runtime-client/core.js').OperationTarget | undefined} */
      let safeTarget;
      if (target.kind === "project") safeTarget = { kind: "project" };
      if (target.kind === "thread" && identifier(target.threadId))
        safeTarget = { kind: "thread", threadId: String(target.threadId) };
      if (target.kind === "task" && identifier(target.taskId))
        safeTarget = { kind: "task", taskId: String(target.taskId) };
      if (safeTarget)
        outcome = {
          kind: rawOutcome.kind,
          operation: {
            method: op.method,
            ...(typeof op.requestId === "string" ? { requestId: op.requestId } : {}),
            target: safeTarget,
          },
        };
    }
  }
  /** @type {DesktopError['recovery']} */
  const recovery =
    record(rawRecovery) &&
    ["retryRead", "queryOriginal", "needsUser", "none"].includes(String(rawRecovery.kind))
      ? { kind: /** @type {NonNullable<DesktopError['recovery']>['kind']} */ (rawRecovery.kind) }
      : undefined;
  const originalId = outcome && "operation" in outcome ? outcome.operation.requestId : requestId;
  const unknown = outcome
    ? outcome.kind === "admitted" || outcome.kind === "unconfirmed"
    : "submissionUnknown" in value && value.submissionUnknown === true;
  return {
    message: typeof value.message === "string" ? value.message.slice(0, 4096) : "桌面操作失败",
    ...(typeof code === "string" || typeof code === "number" ? { code } : {}),
    ...(unknown ? { submissionUnknown: true } : {}),
    ...(typeof originalId === "string" && identifier(originalId) ? { requestId: originalId } : {}),
    ...(reason ? { reason: reason.slice(0, 128) } : {}),
    ...(("delivery" in value ? value.delivery : data.delivery) === "resultUnavailable"
      ? { delivery: /** @type {const} */ ("resultUnavailable") }
      : {}),
    ...(outcome ? { outcome } : {}),
    ...(recovery ? { recovery } : {}),
  };
}

/** A malformed response does not establish whether a write was admitted. */
/** @param {string} name @param {Record<string,unknown>} params @param {unknown} cause */
function commandResponseError(name, params, cause) {
  const semantics = commandSemantics(name, params);
  const write = semantics.effect === "mutation";
  const requestId = semantics.requestId ? params[semantics.requestId] : undefined;
  return Object.assign(new Error("Invalid Desktop command response", { cause }), {
    code: "DESKTOP_RESPONSE_INVALID",
    ...(typeof requestId === "string" ? { requestId } : {}),
    ...(write
      ? {
          submissionUnknown: true,
          outcome: { kind: "unconfirmed" },
          recovery: { kind: "queryOriginal" },
        }
      : { outcome: { kind: "noMutation" }, recovery: { kind: "retryRead" } }),
  });
}

module.exports = {
  commandDefinitions,
  commandSemantics,
  desktopError,
  commandResponseError,
  record,
  identifier,
  invalid,
};
