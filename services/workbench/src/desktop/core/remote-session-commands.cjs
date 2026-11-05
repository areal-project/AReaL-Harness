// @ts-check
"use strict";
const { isPendingSubmission, isAwaitingResponse } = require("./project-state.cjs");
const decoder = require("./remote-core-decoder.cjs");
/** @typedef {InstanceType<typeof import('./remote.cjs').RemoteControl>} Remote */
/** @typedef {import('./remote-session-observer.cjs').RemoteConnection} Connection */
/** @typedef {import('./remote-session-observer.cjs').SessionState} SessionState */
/** @typedef {import('./project-state.cjs').CoreProject} CoreProject */
/** @typedef {{client:CoreProject['client'],endpoint:CoreProject['endpoint'],token:CoreProject['token'],serviceId?:string,generation?:string}} ProjectIdentity */
/** @typedef {import('./remote-session-controls.cjs').ControlRequest} Control */
/** @typedef {import('./remote-interactions.cjs').ResponseParams} InteractionResponse */
/** @typedef {import('./remote-task-questions.cjs').ReplyParams} Reply */
/** @typedef {import('./remote-task-questions.cjs').PauseParams} Pause */
/** @typedef {{commandId?:string,threadId?:string,expectedTurnId?:string,expectedConfigRevision?:number,text?:string,enqueue?:boolean,taskId?:string,runId?:string,questionId?:string,answers?:Record<string,string>,turnId?:string,interactionId?:string,argumentsDigest?:string,decision?:'allowOnce'|'deny',reviewToken?:string,expectedRunId?:string,expectedRevision?:number,operation?:string,values?:Control['values']}} Params */
/** @typedef {{projectId:string,gatewayGeneration:string,grantRevision:number,serviceGeneration:string}} WriteContext */
/** @typedef {{commandId?:never,context:{projectId:string},method:'command.read',params:Params & {commandId:string}}|({commandId:string,context:WriteContext} & (
 * {method:'session.create',params:Params}|{method:'session.control',params:Params & Control}|
 * {method:'session.send',params:Params & {threadId:string,expectedConfigRevision:number,text:string}}|
 * {method:'turn.stop',params:Params & {threadId:string,expectedTurnId:string}}|
 * {method:'interaction.respond',params:Params & InteractionResponse}|{method:'task.question.reply',params:Params & Reply}|{method:'task.pause',params:Params & Pause}))} Request */
/** @typedef {{method:string,capability:string,semanticDigest:string,target:Record<string,unknown>,[key:string]:unknown}} RemoteAssociation */
/** @typedef {{method:string,operationId:string,remote:RemoteAssociation,params?:Record<string,unknown>,admissionState?:string,threadId?:string,turnId?:string,receipt?:unknown,error?:unknown,[key:string]:unknown}} CommandRecord */
/** @typedef {Error & {code?:unknown,coreCode?:unknown,submissionUnknown?:unknown}} CommandError */
const { createHash } = require("node:crypto");
/** @type {(params:unknown)=>asserts params is Reply} */
const validateReply = require("./remote-task-questions.cjs").validateReply;
/** @type {(params:unknown)=>asserts params is Pause} */
const validatePause = require("./remote-task-questions.cjs").validatePause;
/** @type {(params:unknown)=>asserts params is InteractionResponse} */
const validateResponse = require("./remote-interactions.cjs").validateResponse;
/** @type {(params:unknown)=>asserts params is Control} */
const validateControl = require("./remote-session-controls.cjs").validateControl;
const { nativeControl } = require("./remote-session-controls.cjs");
const METHODS = [
  "session.control",
  "session.create",
  "session.send",
  "turn.stop",
  "interaction.respond",
  "task.question.reply",
  "task.pause",
  "command.read",
];
const LIMITS = {
  commandTextBytes: 64 * 1024,
  commandJournalEntries: 4096,
  commandPendingBytes: 72 * 1024,
  commandOutcomeBytes: 4096,
};
/** @param {string} code @param {string} message */
const failure = (code, message) => Object.assign(new Error(message), { code });
/** @param {unknown} value @param {string[]} keys @returns {value is Record<string,unknown>} */
const exact = (value, keys) =>
  !!value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).every((key) => keys.includes(key));
/** @param {unknown} value @returns {value is string} */
const uuid = (value) =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
/** @param {unknown} request @returns {asserts request is Request} */
function validate(request) {
  if (!decoder.record(request)) throw failure("INVALID_PARAMS", "无效的命令参数");
  const read = request.method === "command.read";
  if (
    typeof request.method !== "string" ||
    !METHODS.includes(request.method) ||
    !exact(request, ["id", "method", "context", "params", ...(read ? [] : ["commandId"])]) ||
    !exact(
      request.context,
      read
        ? ["projectId"]
        : ["projectId", "gatewayGeneration", "grantRevision", "serviceGeneration"],
    ) ||
    typeof request.context.projectId !== "string" ||
    request.context.projectId.length > 128 ||
    !exact(
      request.params,
      read
        ? ["commandId"]
        : request.method === "task.pause"
          ? ["taskId", "expectedRunId", "expectedRevision"]
          : request.method === "task.question.reply"
            ? ["taskId", "runId", "questionId", "answers"]
            : request.method === "interaction.respond"
              ? [
                  "threadId",
                  "turnId",
                  "interactionId",
                  "argumentsDigest",
                  "decision",
                  "answers",
                  "reviewToken",
                ]
              : request.method === "turn.stop"
                ? ["threadId", "expectedTurnId"]
                : request.method === "session.send"
                  ? ["threadId", "expectedConfigRevision", "text", "enqueue", "expectedTurnId"]
                  : request.method === "session.control"
                    ? ["threadId", "operation", "expectedRevision", "values"]
                    : [],
    ) ||
    !uuid(read ? request.params.commandId : request.commandId)
  )
    throw failure("INVALID_PARAMS", "无效的命令参数");
  if (
    request.method === "session.send" &&
    ((request.params.enqueue !== undefined && typeof request.params.enqueue !== "boolean") ||
      (request.params.expectedTurnId !== undefined &&
        (typeof request.params.expectedTurnId !== "string" ||
          request.params.expectedTurnId.length > 128)))
  )
    throw failure("INVALID_PARAMS", "无效的后续消息条件");
  if (
    !read &&
    (typeof request.context.gatewayGeneration !== "string" ||
      typeof request.context.grantRevision !== "number" ||
      !Number.isSafeInteger(request.context.grantRevision) ||
      typeof request.context.serviceGeneration !== "string")
  )
    throw failure("INVALID_PARAMS", "缺少当前连接身份");
  const params = request.params;
  if (
    request.method === "turn.stop" &&
    ["threadId", "expectedTurnId"].some(
      (key) =>
        typeof params[key] !== "string" || !params[key] || Buffer.byteLength(params[key]) > 128,
    )
  )
    throw failure("INVALID_PARAMS", "缺少确切的会话和轮次");
  if (
    request.method === "session.send" &&
    (typeof request.params.threadId !== "string" ||
      !request.params.threadId ||
      request.params.threadId.length > 128 ||
      typeof request.params.expectedConfigRevision !== "number" ||
      !Number.isSafeInteger(request.params.expectedConfigRevision) ||
      request.params.expectedConfigRevision < 0 ||
      typeof request.params.text !== "string" ||
      !request.params.text.trim() ||
      Buffer.byteLength(request.params.text) > LIMITS.commandTextBytes)
  )
    throw failure("INVALID_PARAMS", "文本或会话条件无效");
  if (request.method === "session.control") validateControl(request.params);
  if (request.method === "task.pause") validatePause(request.params);
  if (request.method === "interaction.respond") validateResponse(request.params);
  if (request.method === "task.question.reply") validateReply(request.params);
}
/** @param {Remote} remote @param {Connection} connection @param {string} projectId @param {string} [capability] */
function authorize(remote, connection, projectId, capability = "submit") {
  if (
    remote.closed ||
    remote.backend.closing ||
    !connection.alive() ||
    connection.gatewayGeneration !== remote.gatewayGeneration
  )
    throw failure("RESYNC_REQUIRED", "连接已变化，请重新连接");
  const grant = remote.config?.deviceGrants?.find(
    (value) => value.devicePeerId === connection.peer && value.status === "active",
  );
  if (!grant || grant.revision !== connection.grantRevision)
    throw failure("GRANT_CHANGED", "授权已变化，请重新连接");
  if (
    !grant.projectIds.includes(projectId) ||
    !grant.capabilities.includes(capability) ||
    !remote.backend.saved.some((value) => value.id === projectId)
  )
    throw failure("FORBIDDEN", "此命令未获授权");
  return grant;
}
/** @param {unknown} raw @param {string} method */
function nativeError(raw, method) {
  const error = commandError(raw);
  if (method === "areal/thread/start" && error.code === -32004)
    return {
      code: "CONFIGURATION_UNAVAILABLE",
      coreCode: -32004,
      message: "会话配置不可用，请在桌面检查默认模型与技能配置，再新建会话。",
    };
  const code =
    typeof error.code === "string"
      ? error.code
      : error.code === -32009
        ? "TARGET_CHANGED"
        : error.code === -32001
          ? "CAPACITY_EXCEEDED"
          : error.code === -32602
            ? "INVALID_PARAMS"
            : "CORE_UNAVAILABLE";
  return {
    code,
    ...(typeof (error.coreCode ?? error.code) === "number"
      ? { coreCode: error.coreCode ?? error.code }
      : {}),
    message: "命令未受理，请刷新状态后检查草稿",
  };
}
/** @param {Remote["backend"]} backend @param {string} projectId @param {CommandRecord|null} record @param {string} commandId */
function view(backend, projectId, record, commandId) {
  if (!record) return { commandId, admissionState: "notFound", submissionUnknown: true };
  return {
    commandId,
    method: record.remote.method,
    target: record.remote.target,
    operationId: record.operationId,
    ...(!["turn/interrupt", "turn/steer", "areal/interaction/respond"].includes(record.method)
      ? { nativeRequestId: record.params?.requestId ?? record.operationId }
      : {}),
    admissionState:
      record.admissionState ??
      (isPendingSubmission(record) &&
      isAwaitingResponse(backend.awaitingResponses, projectId, record)
        ? "pending"
        : "unknown"),
    submissionUnknown: !record.admissionState,
    ...(record.threadId ? { threadId: record.threadId } : {}),
    ...(record.turnId ? { turnId: record.turnId } : {}),
    ...(record.receipt ? { receipt: record.receipt } : {}),
    ...(record.error ? { error: nativeError(record.error, record.method) } : {}),
  };
}
/** @template T @param {Remote} remote @param {Connection} connection @param {unknown} input @param {(value:unknown)=>T} publish
 * @param {(connection:Connection,projectId:string,threadId:string)=>Promise<SessionState>} [observeAdmission]
 * @param {InstanceType<typeof import('./remote-interactions.cjs').InteractionReviews>} [reviews]
 * @param {InstanceType<typeof import('./remote-task-questions.cjs').TaskQuestions>} [taskQuestions] */
async function sessionCommand(
  remote,
  connection,
  input,
  publish,
  observeAdmission,
  reviews,
  taskQuestions,
) {
  const request = structuredClone(input);
  validate(request);
  const backend = remote.backend,
    projectId = request.context.projectId;
  const control = request.method === "session.control";
  const controlCall = control ? nativeControl(request.params) : null;
  const stop = request.method === "turn.stop";
  const respond = request.method === "interaction.respond";
  const reply = request.method === "task.question.reply";
  const pause = request.method === "task.pause";
  const capability = pause
    ? "pauseTask"
    : respond || reply
      ? "answer"
      : stop
        ? "interrupt"
        : request.method === "command.read"
          ? "observe"
          : "submit";
  const auth = () => authorize(remote, connection, projectId, capability);
  auth();
  const hostIdentity = remote.config.identity;
  if (!hostIdentity) throw failure("RESYNC_REQUIRED", "Host 身份尚未就绪");
  const association = {
    hostId: remote.crypto.identityId(hostIdentity),
    devicePeerId: connection.peer,
    projectId,
    commandId: (request.method === "command.read"
      ? request.params.commandId
      : request.commandId
    ).toLowerCase(),
  };
  const project = await backend.loadProjectJournal(projectId);
  auth();
  /** @type {ProjectIdentity|undefined} */
  let readIdentity;
  const readRecord = async () =>
    commandRecord(
      await backend.readRemoteRecord(project, association, (/** @type {unknown} */ raw) => {
        const entry = commandRecord(raw);
        if (!entry) throw failure("RESOURCE_UNAVAILABLE", "提交关联不可用");
        authorize(remote, connection, projectId, entry.remote.capability);
        readIdentity = {
          client: project.client,
          generation: project.service?.generation,
          serviceId: project.service?.serviceId,
          endpoint: project.endpoint,
          token: project.token,
        };
      }),
    );
  let record = await readRecord();
  const firstAdmission = request.method === "session.send" && !record;
  auth();
  const semantic = control
    ? { method: request.method, ...request.params }
    : pause
      ? {
          method: request.method,
          taskId: request.params.taskId,
          expectedRunId: request.params.expectedRunId,
          expectedRevision: request.params.expectedRevision,
        }
      : reply
        ? {
            method: request.method,
            taskId: request.params.taskId,
            runId: request.params.runId,
            questionId: request.params.questionId,
            answers: Object.fromEntries(
              Object.entries(request.params.answers).sort(([a], [b]) => a.localeCompare(b)),
            ),
          }
        : respond
          ? {
              method: request.method,
              threadId: request.params.threadId,
              turnId: request.params.turnId,
              interactionId: request.params.interactionId,
              argumentsDigest: request.params.argumentsDigest,
              decision: request.params.decision,
              ...(request.params.answers
                ? {
                    answers: Object.fromEntries(
                      Object.entries(request.params.answers).sort(([a], [b]) => a.localeCompare(b)),
                    ),
                  }
                : {}),
            }
          : stop
            ? {
                method: request.method,
                threadId: request.params.threadId,
                expectedTurnId: request.params.expectedTurnId,
              }
            : request.method === "session.send"
              ? {
                  method: request.method,
                  threadId: request.params.threadId,
                  expectedConfigRevision: request.params.expectedConfigRevision,
                  text: request.params.text,
                  ...(request.params.enqueue !== undefined
                    ? { enqueue: request.params.enqueue }
                    : {}),
                  ...(request.params.expectedTurnId
                    ? { expectedTurnId: request.params.expectedTurnId }
                    : {}),
                }
              : { method: request.method };
  const semanticDigest = createHash("sha256").update(JSON.stringify(semantic)).digest("hex");
  if (
    request.method !== "command.read" &&
    record &&
    record.remote.semanticDigest !== semanticDigest
  )
    throw failure("COMMAND_CONFLICT", "命令标识已用于不同内容");
  /** @type {ProjectIdentity|undefined} */
  let identity;
  const checkIdentity = () => {
    if (
      backend.projects.get(projectId) !== project ||
      (identity &&
        (project.client !== identity.client ||
          project.endpoint !== identity.endpoint ||
          project.token !== identity.token ||
          project.service?.serviceId !== identity.serviceId ||
          project.service?.generation !== identity.generation))
    )
      throw failure("RESYNC_REQUIRED", "项目连接已变化，请刷新状态");
  };
  const current = () => {
    auth();
    if (
      backend.projects.get(projectId) !== project ||
      !project.client?.ready ||
      project.client.closed ||
      !project.model?.state?.connected ||
      project.resourceInitializing
    )
      throw failure("CORE_UNAVAILABLE", "项目 Core 当前不可用");
    checkIdentity();
  };
  if (request.method !== "command.read" && !record) {
    try {
      current();
      identity = {
        client: project.client,
        endpoint: project.endpoint,
        token: project.token,
        serviceId: project.service?.serviceId,
        generation: project.service?.generation,
      };
      const nativeMethod = controlCall
        ? controlCall.method
        : pause
          ? "areal/task/pause"
          : reply
            ? "areal/channel/reply"
            : respond
              ? "areal/interaction/respond"
              : stop
                ? "turn/interrupt"
                : request.method === "session.create"
                  ? "areal/thread/start"
                  : request.params.enqueue
                    ? "areal/turn/enqueue"
                    : "areal/turn/start";
      const feature = pause
        ? "taskPauseRunGuard"
        : stop
          ? "turnInterruptAdmissionGuard"
          : request.method === "session.create"
            ? "threadStartAdmissionGuard"
            : request.params.enqueue
              ? "turnEnqueueAdmissionGuard"
              : "turnStartAdmissionGuard";
      const check = () => {
        current();
        const context = request.context;
        if (
          context.gatewayGeneration !== remote.gatewayGeneration ||
          context.grantRevision !== connection.grantRevision ||
          context.serviceGeneration !== project.service?.generation
        )
          throw failure("RESYNC_REQUIRED", "提交条件已变化，请刷新状态");
        if (
          (!control && !respond && !reply && !project.client?.capabilities?.features?.[feature]) ||
          !project.client?.capabilities?.methods?.includes(nativeMethod)
        )
          throw failure("CORE_INCOMPATIBLE", "Core 不支持安全提交，请在桌面升级");
        if (
          (request.method === "session.create" ||
            (control && request.params.values.options?.permissionPreset !== undefined)) &&
          project.client?.capabilities?.features?.permissionPresets !== true
        )
          throw failure("CORE_INCOMPATIBLE", "Core 不支持权限模式，请在桌面升级");
        if (request.method === "session.send" || control) {
          if (project.configurationChanges?.has(request.params.threadId))
            throw failure("TARGET_CHANGED", "会话配置正在变化");
          const thread = project.model.state.threads?.[request.params.threadId];
          if (thread?.parentThreadId || thread?.source === "nativeTaskAgent")
            throw failure("TASK_CONTROL_REQUIRED", "此会话由 Task 管理");
        }
      };
      check();
      /** @type {SessionState|undefined} */
      let admissionState;
      if (request.method === "session.send" || stop || control) {
        if (!observeAdmission) throw failure("CORE_INCOMPATIBLE", "缺少安全会话观察入口");
        const state = await observeAdmission(connection, projectId, request.params.threadId);
        check();
        admissionState = state;
        const ownGoalControl =
          control &&
          ["goalPause", "goalResume", "goalClear"].includes(request.params.operation) &&
          state.goalControlAllowed &&
          state.goals?.goal?.id === request.params.values.goalId;
        if (
          control &&
          ["goalPause", "goalResume", "goalClear"].includes(request.params.operation) &&
          !ownGoalControl
        )
          throw failure("TASK_CONTROL_REQUIRED", "此目标不属于本设备创建的普通 Session");
        if (state?.ownership?.kind !== "ordinary" && !ownGoalControl)
          throw failure("TASK_CONTROL_REQUIRED", "此会话由 Task 管理");
        if (request.params.enqueue && state.activeTurnId !== request.params.expectedTurnId)
          throw failure("TARGET_CHANGED", "原活动轮次已变化");
        if (stop && state.activeTurnId !== request.params.expectedTurnId)
          throw failure("TARGET_CHANGED", "原轮次已结束或改变");
        if (
          !stop &&
          !control &&
          !request.params.enqueue &&
          (state.activeTurnId || state.status !== "idle")
        )
          throw failure("TURN_BUSY", "会话正在运行，草稿已保留");
        if (
          !stop &&
          !control &&
          (state.configRevision !== request.params.expectedConfigRevision ||
            (!request.params.enqueue && state.queue?.pendingCount))
        )
          throw failure("TARGET_CHANGED", "配置或队列条件已变化，草稿已保留");
      }
      const profile = project.resourceProfile ?? backend.defaultProfile;
      if (control && controlCall) {
        if (!admissionState) throw failure("RESYNC_REQUIRED", "会话准入快照不可用");
        const op = request.params.operation;
        if (
          op === "configure" &&
          (admissionState.activeTurnId ||
            admissionState.configRevision !== request.params.expectedRevision)
        )
          throw failure("TARGET_CHANGED", "配置或轮次已变化");
        if (
          ["steer", "queueSteer"].includes(op) &&
          admissionState.activeTurnId !== request.params.values.expectedTurnId
        )
          throw failure("TARGET_CHANGED", "原轮次已变化");
        if (op === "configure") {
          const client = project.client;
          if (!client) throw failure("CORE_UNAVAILABLE", "Core 连接不可用");
          const inspection = await client.request("areal/thread/inspect", {
            threadId: request.params.threadId,
          });
          check();
          if (
            !decoder.record(inspection) ||
            !decoder.record(inspection.configuration) ||
            inspection.configuration.revision !== request.params.expectedRevision
          )
            throw failure("TARGET_CHANGED", "配置已变化");
          if (request.params.values.options) {
            if (!decoder.record(inspection.configuration.options))
              throw failure("CORE_INCOMPATIBLE", "Core 配置不可用");
            controlCall.params.options = {
              ...inspection.configuration.options,
              ...request.params.values.options,
            };
          }
          if (request.params.values.parameters) {
            if (!decoder.record(inspection.configuration.parameters))
              throw failure("CORE_INCOMPATIBLE", "Core 参数不可用");
            controlCall.params.parameters = {
              ...inspection.configuration.parameters,
              ...request.params.values.parameters,
            };
          }
        }
        if (op === "queueUpdate") {
          const item = admissionState.queue.items?.find(
            (item) => item.id === request.params.values.queueItemId,
          );
          if (!item || item.truncated || item.hasAttachments)
            throw failure("TARGET_CHANGED", "此排队消息必须在桌面编辑");
        }
      }
      let preparedParams;
      if (respond) {
        if (!reviews) throw failure("CORE_INCOMPATIBLE", "缺少交互审阅入口");
        preparedParams = await reviews.prepare(connection, projectId, request.params);
        check();
      }
      if (pause) {
        if (!taskQuestions) throw failure("CORE_INCOMPATIBLE", "缺少 Task 读取入口");
        preparedParams = await taskQuestions.preparePause(connection, projectId, request.params);
        check();
      }
      if (reply) {
        if (!taskQuestions) throw failure("CORE_INCOMPATIBLE", "缺少 Task 问题读取入口");
        preparedParams = await taskQuestions.prepare(connection, projectId, request.params);
        check();
      }
      const params = controlCall
        ? controlCall.params
        : respond || reply || pause
          ? preparedParams
          : stop
            ? {
                threadId: request.params.threadId,
                turnId: request.params.expectedTurnId,
                admissionGuard: { ordinarySession: true },
              }
            : request.method === "session.create"
              ? {
                  cwd: project.root,
                  options: { permissionPreset: "ask" },
                  ...(profile ? { agentProfile: profile } : {}),
                  admissionGuard: { ordinarySession: true },
                }
              : {
                  threadId: request.params.threadId,
                  input: [{ type: "text", text: request.params.text }],
                  expectedConfigRevision: request.params.expectedConfigRevision,
                  admissionGuard: {
                    ordinarySession: true,
                    configRevision: request.params.expectedConfigRevision,
                    ...(request.params.enqueue
                      ? { expectedTurnId: request.params.expectedTurnId }
                      : {}),
                  },
                };
      if (!params) throw failure("CORE_INCOMPATIBLE", "控制请求尚未完成身份准备");
      record = commandRecord(
        await backend.submit(project, nativeMethod, params, {
          remote: {
            ...association,
            method: request.method,
            capability,
            admittedGrantRevision: connection.grantRevision,
            semanticDigest,
            target: control
              ? {
                  threadId: request.params.threadId,
                  operation: request.params.operation,
                  expectedRevision: request.params.expectedRevision,
                }
              : pause
                ? { ...request.params }
                : reply
                  ? {
                      taskId: request.params.taskId,
                      runId: request.params.runId,
                      questionId: request.params.questionId,
                    }
                  : respond
                    ? {
                        threadId: request.params.threadId,
                        turnId: request.params.turnId,
                        interactionId: request.params.interactionId,
                        ...(request.params.argumentsDigest
                          ? { argumentsDigest: request.params.argumentsDigest }
                          : {}),
                      }
                    : stop
                      ? {
                          threadId: request.params.threadId,
                          expectedTurnId: request.params.expectedTurnId,
                        }
                      : request.method === "session.send"
                        ? {
                            threadId: request.params.threadId,
                            expectedConfigRevision: request.params.expectedConfigRevision,
                          }
                        : {},
          },
          dispatch: async (
            /** @type {import('./project-state.cjs').PendingSubmission} */ entry,
          ) => {
            /** @type {Promise<{result?:unknown,error?:CommandError}>|undefined} */
            let response;
            // 与撤权共享队列；同步检查和 request 启动之间不得 await，RPC 回应在队列外等待。
            const admission = (remote.writes ?? Promise.resolve())
              .catch(() => {})
              .then(() => {
                check();
                try {
                  if (!identity?.client) throw failure("CORE_UNAVAILABLE", "Core 连接不可用");
                  response = identity.client.request(nativeMethod, entry.params).then(
                    (result) => ({ result }),
                    (error) => ({ error: commandError(error) }),
                  );
                } catch (error) {
                  response = Promise.resolve({
                    error: Object.assign(commandError(error), { submissionUnknown: true }),
                  });
                }
              });
            remote.writes = admission;
            await admission;
            const received = await response;
            if (!received) throw failure("SUBMISSION_UNKNOWN", "命令响应不可用");
            if (received.error) {
              const error = received.error;
              if (typeof error.code !== "number" || error.code === -32603)
                error.submissionUnknown = true;
              if (error.code === -32602 && error.message?.includes("UNSUPPORTED_PROFILE:")) {
                error.coreCode = error.code;
                error.code = "UNSUPPORTED_PROFILE";
              }
              throw error;
            }
            return received.result;
          },
        }),
      );
      if (record) remote.push.track(projectId, record, !firstAdmission);
    } catch (error) {
      // 异步预检查期间另一请求可能已持久受理；原关联优先于新命令的准入拒绝。
      auth();
      const original = await readRecord();
      auth();
      checkIdentity();
      if (!original) throw error;
      if (original.remote.semanticDigest !== semanticDigest)
        throw failure("COMMAND_CONFLICT", "命令标识已用于不同内容");
      record = original;
      // 已有关联允许离线核对；上面的身份校验与最终授权之间不再 await。
      identity = undefined;
    }
  }
  /** @type {unknown} */
  let observedState;
  /** @type {ProjectIdentity|undefined} */
  let observationIdentity;
  const observation =
    record?.remote.method === "task.pause" && taskQuestions
      ? { observe: taskQuestions.observePause.bind(taskQuestions) }
      : record?.remote.method === "task.question.reply"
        ? taskQuestions
        : record?.remote.method === "interaction.respond"
          ? reviews
          : null;
  if (observation && record) {
    authorize(remote, connection, projectId, record.remote.capability);
    observationIdentity = {
      client: project.client,
      generation: project.service?.generation,
      serviceId: project.service?.serviceId,
      endpoint: project.endpoint,
      token: project.token,
    };
    try {
      observedState = await observation.observe(connection, projectId, record.remote.target);
    } catch {
      observedState = {
        source:
          record.remote.method === "task.pause"
            ? "task.read"
            : record.remote.method === "task.question.reply"
              ? "task.question.read"
              : "interaction.read",
        status: "unavailable",
        provesCommandAdmission: false,
      };
    }
  }
  // 响应最终授权必须紧挨发布；已派发结果即使撤权仍由 journal 保存。
  authorize(remote, connection, projectId, record?.remote.capability ?? "observe");
  if (
    readIdentity &&
    (backend.projects.get(projectId) !== project ||
      project.client !== readIdentity.client ||
      project.service?.generation !== readIdentity.generation ||
      project.service?.serviceId !== readIdentity.serviceId ||
      project.endpoint !== readIdentity.endpoint ||
      project.token !== readIdentity.token)
  )
    throw failure("RESYNC_REQUIRED", "收据查询期间项目连接已变化");
  if (
    observationIdentity &&
    (project.client !== observationIdentity.client ||
      project.service?.generation !== observationIdentity.generation ||
      project.service?.serviceId !== observationIdentity.serviceId ||
      project.endpoint !== observationIdentity.endpoint ||
      project.token !== observationIdentity.token)
  )
    throw failure("RESYNC_REQUIRED", "交互观察期间项目连接已变化");
  checkIdentity();
  if (identity) current();
  if (record) remote.push.track(projectId, record, !firstAdmission);
  return publish({
    ...view(backend, projectId, record, association.commandId),
    ...(observedState ? { observedState } : {}),
  });
}
/** @param {unknown} value @returns {CommandRecord|null} */
function commandRecord(value) {
  if (value == null) return null;
  assertCommandRecord(value);
  return value;
}
/** @param {unknown} value @returns {asserts value is CommandRecord} */
function assertCommandRecord(value) {
  if (
    !decoder.record(value) ||
    typeof value.method !== "string" ||
    typeof value.operationId !== "string" ||
    !decoder.record(value.remote) ||
    typeof value.remote.method !== "string" ||
    typeof value.remote.capability !== "string" ||
    typeof value.remote.semanticDigest !== "string" ||
    !decoder.record(value.remote.target) ||
    (value.params !== undefined && !decoder.record(value.params)) ||
    (value.admissionState !== undefined && typeof value.admissionState !== "string") ||
    (value.threadId !== undefined && typeof value.threadId !== "string") ||
    (value.turnId !== undefined && typeof value.turnId !== "string")
  )
    throw failure("RESOURCE_UNAVAILABLE", "提交关联不可用");
}
/** @param {unknown} value @returns {CommandError} */
function commandError(value) {
  if (value instanceof Error) return value;
  return Object.assign(new Error("Core 请求失败"), decoder.record(value) ? value : {});
}
module.exports = { sessionCommand, METHODS, LIMITS, validate, view };
