// @ts-check
"use strict";
const { mkdir, readFile, writeFile, realpath } = require("node:fs/promises");
const { join, relative, isAbsolute, sep } = require("node:path");
const { createHash } = require("node:crypto");
const { checkoutRoot } = require("@areal/workspace-git");
const { modelRecord } = require("@areal/workbench/core-model-contract");
const { readTask, readTaskRun } = require("@areal/workbench/desktop-contract/management-tasks");
const { readReceipts, receiptResult } = require("./receipt-contract.cjs");
const { readAdmissionThread } = require("./worktree-admission.cjs");
const { readHistoryInteractions } = require("./history-contract.cjs");
/** @typedef {import('./project-state.cjs').CoreProject} Project */
/** @typedef {{kind:'draft'|'request',id:string}} Family */
/** @typedef {{taskRequestId:string,executionRequestId?:string}} Requests */
/** @typedef {{version:1,projectId:string,root:string,cwd:string,allocationId:string,family:Family,token:string,taskRequestId:string,executionRequestId?:string,anchorThreadId?:string,taskId?:string,kind?:never}} Reservation */
/** @typedef {import('./worktree-admission.cjs').AdmissionThread & {goalOwner?:{threadId:string,goalId:string}|null,goals?:import('@areal/workbench/core-model-contract').CoreGoals & {goal?:{id:string,threadId:string,status:string,activeTurnId?:string|null}|null}}} ScheduleThread */
/** @param {unknown} value @returns {value is string} */
const identifier = (value) =>
  typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\0\r\n]/.test(value);
/** @param {string} message */
const reject = (message) =>
  Object.assign(new Error(message), {
    code: "SCHEDULE_WORKSPACE_REQUIRED",
    submissionUnknown: false,
    outcome: { kind: "noMutation" },
  });
/** @param {string} projectId @param {Family} family */
const familyToken = (projectId, family) =>
  "schedule:" +
  createHash("sha256")
    .update(JSON.stringify([projectId, family.kind, family.id]))
    .digest("hex");
/** @param {string} root @param {string} cwd */
const contains = (root, cwd) => {
  const tail = relative(root, cwd);
  return tail === "" || (!isAbsolute(tail) && tail !== ".." && !tail.startsWith(".." + sep));
};

/** 旧调度家庭保留独占预约；普通来源安排从 Core 身份派生共享目录资格。 */
class ScheduleAdmission {
  /** @param {InstanceType<typeof import('./backend.cjs').CoreBackend>} backend */
  constructor(backend) {
    this.backend = backend;
    /** @type {Map<string,Promise<unknown>>} */
    this.writes = new Map();
  }
  /** @param {Project} project */
  file(project) {
    if (!/^[a-f0-9]{24}$/.test(project.id)) throw reject("定时任务工作区身份无效");
    return join("schedule-authors", project.id + ".json");
  }
  /** @param {Project} project @param {string} [cwd] */
  async eligible(project, cwd = project.root) {
    const saved = this.backend.saved.find((value) => value.id === project.id);
    const allocation = saved?.projectlessRequestId
      ? this.backend.projectless.records[saved.projectlessRequestId]
      : undefined;
    const root = await realpath(project.root),
      directory = await realpath(cwd);
    if (
      !saved?.projectless ||
      !saved.projectlessRequestId ||
      !allocation ||
      allocation.existing === true ||
      allocation.root !== root ||
      (await realpath(saved.root)) !== root ||
      !contains(root, directory)
    )
      throw reject("定时任务需要为本任务自动分配的独立项目外目录；已有共享目录的安排不会自动启用");
    const checkout = await checkoutRoot(root);
    if (checkout && checkout !== root)
      throw reject("任务目录位于共享 Git 检出内，不能作为独立调度目录");
    return { root, cwd: directory, allocationId: saved.projectlessRequestId };
  }
  /** @param {Project} project @returns {Promise<Reservation|null>} */
  async read(project) {
    /** @type {unknown} */
    let value;
    try {
      value = JSON.parse(await readFile(join(this.backend.home, this.file(project)), "utf8"));
    } catch (error) {
      if (modelRecord(error) && error.code === "ENOENT") return null;
      throw reject("无法读取原定时任务目录预约");
    }
    if (
      !isReservation(value) ||
      value.projectId !== project.id ||
      value.token !== familyToken(project.id, value.family)
    )
      throw reject("定时任务目录预约无效");
    return value;
  }
  /** @template T @param {Project} project @param {()=>Promise<T>} work */
  async serial(project, work) {
    const next = (this.writes.get(project.id) ?? Promise.resolve()).catch(() => {}).then(work);
    this.writes.set(project.id, next);
    try {
      return await next;
    } finally {
      if (this.writes.get(project.id) === next) this.writes.delete(project.id);
    }
  }
  /** @param {Project} project @param {Family} family @param {string} cwd @param {Requests} requests @param {string} [anchorThreadId] */
  async reserve(project, family, cwd, requests, anchorThreadId) {
    if (
      !identifier(family.id) ||
      !identifier(requests.taskRequestId) ||
      (requests.executionRequestId !== undefined && !identifier(requests.executionRequestId))
    )
      throw reject("定时任务缺少稳定创建身份");
    return this.serial(project, async () => {
      const identity = await this.eligible(project, cwd);
      const token = familyToken(project.id, family);
      let value = await this.read(project);
      if (
        value &&
        (value.token !== token ||
          value.root !== identity.root ||
          value.cwd !== identity.cwd ||
          value.taskRequestId !== requests.taskRequestId ||
          value.executionRequestId !== requests.executionRequestId ||
          (anchorThreadId && value.anchorThreadId && anchorThreadId !== value.anchorThreadId))
      )
        throw reject("此目录已保留给另一个定时任务家庭，不会替换原安排");
      await this.backend.worktreeAdmission.claim(project, token);
      if (!value) {
        value = {
          version: 1,
          projectId: project.id,
          ...identity,
          family,
          token,
          ...requests,
          ...(anchorThreadId ? { anchorThreadId } : {}),
        };
        await mkdir(join(this.backend.home, "schedule-authors"), {
          recursive: true,
          mode: 0o700,
        });
        try {
          await writeFile(join(this.backend.home, this.file(project)), JSON.stringify(value), {
            flag: "wx",
            mode: 0o600,
          });
        } catch (error) {
          if (!modelRecord(error) || error.code !== "EEXIST") throw error;
          const previous = await this.read(project);
          if (
            !previous ||
            previous.token !== token ||
            previous.root !== identity.root ||
            previous.cwd !== identity.cwd ||
            previous.taskRequestId !== requests.taskRequestId ||
            previous.executionRequestId !== requests.executionRequestId ||
            (anchorThreadId &&
              previous.anchorThreadId &&
              anchorThreadId !== previous.anchorThreadId)
          )
            throw reject("定时任务目录已被其他创建请求或不同参数预约");
          value = previous;
        }
      }
      return value;
    });
  }
  /** @param {Project} project @param {string} threadId @param {string} cwd @param {Requests} requests */
  reserveDraft(project, threadId, cwd, requests) {
    return this.reserve(project, { kind: "draft", id: threadId }, cwd, requests);
  }
  /** @param {Project} project @param {string} requestId @param {string|null|undefined} anchorThreadId @param {{executionRequestId?:string}} [requests] */
  async reserveCreate(project, requestId, anchorThreadId, requests = {}) {
    const client = project.client;
    if (!client) throw reject("Core 未连接");
    let cwd = project.root;
    if (anchorThreadId) {
      const response = await client.request(
        "thread/read",
        {
          threadId: anchorThreadId,
          includeTurns: false,
        },
        { decode: readScheduleThread },
      );
      if (response.thread?.id !== anchorThreadId) throw reject("定时任务执行锚点无法确认");
      cwd = response.thread.cwd;
    }
    return this.reserve(
      project,
      { kind: "request", id: requestId },
      cwd,
      { ...requests, taskRequestId: requestId },
      anchorThreadId ?? undefined,
    );
  }
  /** @param {Project} project @param {unknown} threadId */
  async setAnchor(project, threadId) {
    const client = project.client;
    if (!client) throw reject("Core 未连接");
    if (!identifier(threadId)) throw reject("定时任务执行锚点无效");
    return this.serial(project, async () => {
      const value = await this.read(project);
      if (!value) throw reject("定时任务尚未预约独立目录");
      const response = await client.request(
        "thread/read",
        {
          threadId,
          includeTurns: false,
        },
        { decode: readScheduleThread },
      );
      if (
        response.thread?.id !== threadId ||
        (await realpath(response.thread.cwd)) !== value.cwd ||
        (value.anchorThreadId && value.anchorThreadId !== threadId)
      )
        throw reject("执行锚点与原定时任务目录不匹配");
      await this.backend.save(this.file(project), { ...value, anchorThreadId: threadId });
      return { ...value, anchorThreadId: threadId };
    });
  }
  /** @param {Project} project @param {import("@areal/workbench/desktop-contract/management-tasks").Task} task */
  async bind(project, task) {
    return this.serial(project, async () => {
      const value = await this.read(project);
      if (
        !value ||
        task?.mode !== "scheduled" ||
        !identifier(task.id) ||
        task.threadId !== value.anchorThreadId ||
        (value.taskId && value.taskId !== task.id)
      )
        throw reject("定时任务与原目录预约不匹配");
      await this.backend.save(this.file(project), { ...value, taskId: task.id });
      return { ...value, taskId: task.id };
    });
  }
  /** @param {Project} project @param {import("@areal/workbench/desktop-contract/management-tasks").Task} task */
  async sourceWorkspace(project, task) {
    const client = project.client;
    // Core 服务在 core/server/src/lib.rs 颁发 desktop-owner principal；此处只读 Core Task 的 owner。
    if (
      !client?.ready ||
      task?.mode !== "scheduled" ||
      task.owner !== "desktop-owner" ||
      task.cancelled !== false ||
      !identifier(task.id) ||
      !identifier(task.sourceThreadId) ||
      !identifier(task.threadId) ||
      task.sourceThreadId === task.threadId
    )
      throw reject("普通来源安排的桌面宿主身份尚未确认");
    const source = await client.request(
      "thread/read",
      {
        threadId: task.sourceThreadId,
        includeTurns: false,
      },
      { decode: readScheduleThread },
    );
    const anchor = await client.request(
      "thread/read",
      {
        threadId: task.threadId,
        includeTurns: false,
      },
      { decode: readScheduleThread },
    );
    if (
      source.thread?.id !== task.sourceThreadId ||
      !identifier(source.thread.sessionId) ||
      source.thread.parentThreadId ||
      source.thread.goalOwner ||
      source.thread.conversation?.kind === "side" ||
      source.thread.source === "nativeTaskAgent" ||
      !source.thread.desktop ||
      source.thread.desktop.configuration?.readOnly === true ||
      anchor.thread?.id !== task.threadId ||
      !identifier(anchor.thread.sessionId) ||
      anchor.thread.parentThreadId ||
      anchor.thread.goalOwner ||
      anchor.thread.conversation?.kind === "side" ||
      typeof source.thread.cwd !== "string" ||
      typeof anchor.thread.cwd !== "string"
    )
      throw reject("普通来源安排的来源或执行锚点尚未确认");
    const root = await realpath(project.root);
    const cwd = await realpath(source.thread.cwd);
    if (
      !contains(root, cwd) ||
      (await realpath(anchor.thread.cwd)) !== cwd ||
      project.client !== client ||
      !client.ready
    )
      throw reject("普通来源安排的来源、执行锚点或运行目录已变化");
    return {
      kind: /** @type {const} */ ("sourceSchedule"),
      root,
      cwd,
      taskId: task.id,
      sourceThreadId: task.sourceThreadId,
      sourceSessionId: source.thread.sessionId,
      anchorThreadId: task.threadId,
    };
  }
  /** @param {Project} project @param {string} taskId @param {string} [_operation] */
  async admitTask(project, taskId, _operation) {
    const client = project.client;
    if (!client) throw reject("Core 未连接");
    if (!identifier(taskId)) throw reject("定时任务身份无效");
    const task = await client.request("areal/task/read", { taskId }, { decode: readTask });
    if (task?.id !== taskId || task.mode !== "scheduled") throw reject("无法确认原定时任务");
    let value = await this.read(project);
    if (!value) {
      if (!identifier(task.sourceThreadId))
        throw reject("原安排没有可核对的独立目录预约，请保持暂停或取消后重新安排");
      const reservation = await this.sourceWorkspace(project, task);
      await this.backend.worktreeAdmission.shared(project, reservation.sourceSessionId);
      return { task, reservation };
    }
    const identity = await this.eligible(project, value.cwd);
    if (
      value.root !== identity.root ||
      value.allocationId !== identity.allocationId ||
      task.threadId !== value.anchorThreadId
    )
      throw reject("原安排的目录或执行锚点已变化");
    if (!value.taskId) {
      const taskRequestId = value.taskRequestId;
      const receipts = await client.request(
        "areal/request/read",
        {
          requestId: taskRequestId,
        },
        { decode: readReceipts },
      );
      const receipt = receipts.data?.find(
        (item) =>
          (item.method ?? item.operation?.method) === "areal/task/create" &&
          (item.requestId ?? item.operation?.requestId ?? taskRequestId) === taskRequestId,
      );
      const result = receipt ? receiptResult(receipt) : undefined;
      if (((modelRecord(result) ? result.id : undefined) ?? receipt?.taskId) !== task.id)
        throw reject("原任务创建结果尚未核对，不会将回调绑定到其他安排");
      value = await this.bind(project, task);
    }
    if (value.taskId !== task.id) throw reject("此目录属于另一个定时任务，不会改绑");
    await this.backend.worktreeAdmission.claim(project, value.token);
    return { task, reservation: value };
  }
  /** @param {Project} project @param {{name:string,request:Record<string,unknown>,threads:import("./worktree-admission.cjs").AdmissionThread[],sessionId:string}} context */
  async authorForSession(project, { name, request, threads, sessionId }) {
    const client = project.client;
    if (!client) throw reject("Core 未连接");
    if (!["respond", "continue"].includes(name)) return null;
    const exclusive = await this.read(project);
    let taskId = exclusive?.taskId;
    if (!exclusive) {
      const coordinators = new Set(
        threads
          .map((thread) => {
            if (!scheduleThread(thread)) throw reject("定时执行会话目标结构无效");
            return thread;
          })
          .filter((thread) => thread.goals?.goal || thread.goalOwner)
          .map((thread) => thread.goalOwner?.threadId ?? thread.id),
      );
      if (!coordinators.size) return null;
      const catalog = await this.backend.worktreeAdmission.checkTaskCatalog(project, sessionId);
      const candidates = catalog.filter(
        (task) =>
          task.mode === "scheduled" &&
          task.sourceThreadId &&
          task.runs?.some((run) => !!run.threadId && coordinators.has(run.threadId)),
      );
      if (!candidates.length) return null;
      if (candidates.length !== 1) throw reject("定时执行的任务归属不唯一");
      taskId = candidates[0].id;
    }
    if (!identifier(taskId)) throw reject("原定时任务尚未完成绑定");
    const task = await client.request("areal/task/read", { taskId }, { decode: readTask });
    if (task?.id !== taskId) throw reject("定时执行的任务身份已变化");
    const reservation = exclusive ?? (await this.sourceWorkspace(project, task));
    if (exclusive) {
      const identity = await this.eligible(project, exclusive.cwd);
      if (identity.root !== exclusive.root || identity.allocationId !== exclusive.allocationId)
        throw reject("原定时任务或目录预约已失效");
    }
    if (
      task?.id !== reservation.taskId ||
      task.mode !== "scheduled" ||
      task.cancelled !== false ||
      task.threadId !== reservation.anchorThreadId
    )
      throw reject("原定时任务或目录预约已失效");
    // Task 摘要保留当前 Run 身份，完整 Run 的 worker 记录必须另向 Core 查询。
    const current = task.runs?.at(-1);
    const active = new Set(["running", "waitingForInput", "waitingForAgents"]);
    if (
      !current ||
      !active.has(current.status) ||
      (task.runs ?? []).filter((run) => !["completed", "failed", "cancelled"].includes(run.status))
        .length !== 1
    )
      throw reject("只有当前未结束的定时执行可继续交互；暂停执行请使用任务恢复入口");
    const run = await client.request(
      "areal/task/run/read",
      {
        taskId: task.id,
        runId: current.id,
      },
      { decode: readTaskRun },
    );
    if (
      run?.id !== current.id ||
      !active.has(run.status) ||
      run.reason === "stopRequested" ||
      run.threadId !== current.threadId ||
      run.goalId !== current.goalId ||
      !identifier(run.threadId) ||
      !identifier(run.goalId)
    )
      throw reject("当前定时执行身份已变化");
    const targetIds = [
      ...new Set(
        [request.threadId, request.parentThreadId, request.sourceThreadId].filter(identifier),
      ),
    ];
    if (
      !targetIds.length ||
      !Array.isArray(threads) ||
      threads.length !== targetIds.length ||
      targetIds.some((id) => !threads.some((thread) => thread.id === id))
    )
      throw reject("定时执行目标尚未全部核对");
    /** @param {string} threadId */
    const readThread = async (threadId) => {
      const response = await client.request(
        "thread/read",
        {
          threadId,
          includeTurns: false,
        },
        { decode: readScheduleThread },
      );
      const thread = response.thread;
      if (
        thread?.id !== threadId ||
        !identifier(thread.sessionId) ||
        (await realpath(thread.cwd)) !== reservation.cwd
      )
        throw reject("定时执行会话目录或运行身份已变化");
      return thread;
    };
    const coordinator = await readThread(run.threadId);
    const goal = coordinator.goals?.goal;
    if (
      coordinator.id === reservation.anchorThreadId ||
      coordinator.goalOwner ||
      goal?.id !== run.goalId ||
      goal.threadId !== coordinator.id ||
      goal.status !== "active"
    )
      throw reject("当前定时执行目标已结束或不属于原运行");
    const targets = new Map();
    for (const threadId of targetIds) {
      const thread = threadId === coordinator.id ? coordinator : await readThread(threadId);
      if (thread.sessionId !== sessionId) throw reject("定时执行会话作者已变化");
      let turnId = goal.activeTurnId;
      if (thread.id !== coordinator.id) {
        const worker = run.workers?.find((value) => value.threadId === thread.id);
        if (
          !worker ||
          worker.settled !== false ||
          !["running", "waitingForInput", "waitingForAgents"].includes(worker.status) ||
          !identifier(worker.turnId) ||
          (worker.execution &&
            (worker.execution.kind !== "thread" ||
              worker.execution.threadId !== thread.id ||
              worker.execution.turnId !== worker.turnId)) ||
          thread.goalOwner?.threadId !== coordinator.id ||
          thread.goalOwner?.goalId !== run.goalId
        )
          throw reject("目标会话不是当前定时执行的未结算 worker");
        if (thread.parentThreadId) {
          const visited = new Set([thread.id]);
          let parentId = thread.parentThreadId;
          while (parentId !== coordinator.id) {
            if (visited.has(parentId) || visited.size >= 32)
              throw reject("定时 worker 父会话链无法确认");
            visited.add(parentId);
            const parent = await readThread(parentId);
            if (
              parent.sessionId !== thread.sessionId ||
              parent.goalOwner?.threadId !== coordinator.id ||
              parent.goalOwner?.goalId !== run.goalId ||
              !identifier(parent.parentThreadId)
            )
              throw reject("定时 worker 父会话不属于原运行");
            parentId = parent.parentThreadId;
          }
          if (thread.sessionId !== coordinator.sessionId)
            throw reject("定时 worker 未继承原运行会话");
        } else if (thread.source !== "nativeTaskAgent" || thread.sessionId !== thread.id)
          throw reject("独立 worker 运行身份无法确认");
        turnId = worker.turnId;
      }
      if (!identifier(turnId)) throw reject("定时执行当前轮次尚未确认");
      targets.set(thread.id, { thread, turnId });
    }
    if (name === "respond") {
      if (!identifier(request.threadId)) throw reject("定时执行目标身份无效");
      const target = targets.get(request.threadId);
      const result = await client.request(
        "areal/interaction/list",
        {
          threadId: request.threadId,
        },
        { decode: readScheduleInteractions },
      );
      const interaction = result.data?.find((value) => value.requestId === request.requestId);
      if (
        !target ||
        !interaction ||
        interaction.threadId !== target.thread.id ||
        interaction.turnId !== target.turnId ||
        interaction.status !== "pending" ||
        !(interaction.kind === "approval" || interaction.kind === "question") ||
        typeof interaction.expiresAt !== "number" ||
        !Number.isSafeInteger(interaction.expiresAt) ||
        interaction.expiresAt <= Math.floor(Date.now() / 1000)
      )
        throw reject("原运行的待处理交互已结束或身份不匹配");
      if (interaction.kind === "approval") {
        if (
          request.answers !== undefined ||
          !(
            typeof request.decision === "string" &&
            ["allowOnce", "allowSession", "allowProject", "deny"].includes(request.decision)
          )
        )
          throw reject("审批回答与原交互类型不匹配");
      } else {
        const answers = request.answers;
        if (
          request.decision !== undefined ||
          !modelRecord(answers) ||
          !Array.isArray(interaction.questions) ||
          Object.keys(answers).length !== interaction.questions.length ||
          interaction.questions.some((question) => {
            const answer = answers[question.id];
            return (
              typeof answer !== "string" ||
              Buffer.byteLength(answer) > 4096 ||
              (question.allowFreeText === false && !question.options?.includes(answer))
            );
          })
        )
          throw reject("问题回答与原交互不匹配");
      }
      // 实际 respond 分支使用投影，先以刚核对的 Core 原始请求刷新，避免旧摘要误配。
      project.model.setInteractions(request.threadId, result);
    }
    if (
      name === "continue" &&
      (!identifier(request.threadId) ||
        request.expectedTurnId !== targets.get(request.threadId)?.turnId)
    )
      throw reject("原定时执行轮次已变化");
    return reservation.kind === "sourceSchedule" ? reservation : reservation.token;
  }
  /** @param {Project} project @param {Record<string,unknown>} params */
  async prepare(project, params) {
    const client = project.client;
    if (!client) throw reject("Core 未连接");
    if (
      !identifier(params?.taskId) ||
      !identifier(params.runId) ||
      !identifier(params.threadId) ||
      !(params.intent === "start" || params.intent === "resume")
    )
      throw reject("定时执行准备身份无效");
    const { task, reservation } = await this.admitTask(project, params.taskId);
    const current = task.runs?.at(-1);
    if (current?.id !== params.runId) throw reject("原定时执行身份已变化");
    const run = await client.request(
      "areal/task/run/read",
      {
        taskId: task.id,
        runId: current.id,
      },
      { decode: readTaskRun },
    );
    if (
      task.cancelled !== false ||
      run?.id !== current.id ||
      run.status !== current.status ||
      run.threadId !== current.threadId ||
      run.goalId !== current.goalId ||
      run.reason !== current.reason ||
      !["queued", "running", "waitingForInput", "waitingForAgents", "paused", "blocked"].includes(
        run.status,
      ) ||
      run.reason === "stopRequested" ||
      (params.intent === "start" && run.status !== "queued")
    )
      throw reject("原定时执行已结束或不是当前可准备的执行");
    const expected = params.intent === "start" ? reservation.anchorThreadId : run.threadId;
    if (params.threadId !== expected) throw reject("定时执行回调与原执行身份不匹配");
    const response = await client.request(
      "thread/read",
      {
        threadId: params.threadId,
        includeTurns: false,
      },
      { decode: readScheduleThread },
    );
    if (
      response.thread?.id !== params.threadId ||
      (await realpath(response.thread.cwd)) !== reservation.cwd
    )
      throw reject("定时执行目录已变化，未放行执行");
    return { task, reservation };
  }
}
/** @param {unknown} value @returns {value is Reservation} */
function isReservation(value) {
  return (
    modelRecord(value) &&
    value.version === 1 &&
    value.kind === undefined &&
    typeof value.projectId === "string" &&
    modelRecord(value.family) &&
    identifier(value.family.id) &&
    (value.family.kind === "draft" || value.family.kind === "request") &&
    ["root", "cwd", "allocationId", "token", "taskRequestId"].every(
      (key) => typeof value[key] === "string",
    ) &&
    ["executionRequestId", "anchorThreadId", "taskId"].every(
      (key) => value[key] === undefined || identifier(value[key]),
    )
  );
}
/** @param {unknown} value @returns {{thread:ScheduleThread}} */
function readScheduleThread(value) {
  const { thread } = readAdmissionThread(value);
  if (!scheduleThread(thread)) throw reject("定时执行会话目标结构无效");
  return { thread };
}
/** @param {import('./worktree-admission.cjs').AdmissionThread} thread @returns {thread is ScheduleThread} */
function scheduleThread(thread) {
  const owner = thread.goalOwner;
  const goal = thread.goals?.goal;
  return (
    (owner == null ||
      (modelRecord(owner) &&
        typeof owner.threadId === "string" &&
        typeof owner.goalId === "string")) &&
    (goal == null ||
      (modelRecord(goal) &&
        typeof goal.id === "string" &&
        typeof goal.threadId === "string" &&
        typeof goal.status === "string" &&
        (goal.activeTurnId == null || typeof goal.activeTurnId === "string")))
  );
}
/** @typedef {import('@areal/workbench/core-model-contract').CoreInteraction & {turnId?:string,status?:string,kind?:string,expiresAt?:number,questions?:{id:string,allowFreeText?:boolean,options?:string[]}[]}} ScheduleInteraction */
/** @param {unknown} value @returns {{revision:number,data:ScheduleInteraction[]}} */
function readScheduleInteractions(value) {
  const result = readHistoryInteractions(value);
  if (!result.data.every(scheduleInteraction)) throw reject("定时执行交互结构无效");
  return { ...result, data: result.data };
}
/** @param {import('@areal/workbench/core-model-contract').CoreInteraction} value @returns {value is ScheduleInteraction} */
function scheduleInteraction(value) {
  return (
    ["turnId", "status", "kind"].every(
      (key) => value[key] === undefined || typeof value[key] === "string",
    ) &&
    (value.expiresAt === undefined ||
      (typeof value.expiresAt === "number" && Number.isSafeInteger(value.expiresAt))) &&
    (value.questions === undefined ||
      (Array.isArray(value.questions) &&
        value.questions.every(
          (question) =>
            modelRecord(question) &&
            typeof question.id === "string" &&
            (question.allowFreeText === undefined || typeof question.allowFreeText === "boolean") &&
            (question.options === undefined ||
              (Array.isArray(question.options) &&
                question.options.every((option) => typeof option === "string"))),
        )))
  );
}
module.exports = { ScheduleAdmission };
