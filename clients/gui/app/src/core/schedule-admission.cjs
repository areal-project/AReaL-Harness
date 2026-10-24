"use strict";
const { mkdir, readFile, writeFile, realpath } = require("node:fs/promises");
const { join, relative, isAbsolute, sep } = require("node:path");
const { createHash } = require("node:crypto");
const { checkoutRoot } = require("@areal/workspace-git");
const identifier = (value) =>
    typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\0\r\n]/.test(value);
const reject = (message) =>
    Object.assign(new Error(message), {
        code: "SCHEDULE_WORKSPACE_REQUIRED",
        submissionUnknown: false,
        outcome: { kind: "noMutation" },
    });
const familyToken = (projectId, family) =>
    "schedule:" +
    createHash("sha256")
        .update(JSON.stringify([projectId, family.kind, family.id]))
        .digest("hex");
const contains = (root, cwd) => {
    const tail = relative(root, cwd);
    return tail === "" || (!isAbsolute(tail) && tail !== ".." && !tail.startsWith(".." + sep));
};

/** 调度家庭独占自动分配的项目外目录，普通线程使用同一目录作者账本。 */
class ScheduleAdmission {
    constructor(backend) {
        this.backend = backend;
        this.writes = new Map();
    }
    file(project) {
        if (!/^[a-f0-9]{24}$/.test(project.id)) throw reject("定时任务工作区身份无效");
        return join("schedule-authors", project.id + ".json");
    }
    async eligible(project, cwd = project.root) {
        const saved = this.backend.saved.find((value) => value.id === project.id);
        const allocation = this.backend.projectless.records?.[saved?.projectlessRequestId];
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
            throw reject(
                "定时任务需要为本任务自动分配的独立项目外目录；已有共享目录的安排不会自动启用",
            );
        const checkout = await checkoutRoot(root);
        if (checkout && checkout !== root)
            throw reject("任务目录位于共享 Git 检出内，不能作为独立调度目录");
        return { root, cwd: directory, allocationId: saved.projectlessRequestId };
    }
    async read(project) {
        let value;
        try {
            value = JSON.parse(await readFile(join(this.backend.home, this.file(project)), "utf8"));
        } catch (error) {
            if (error.code === "ENOENT") return null;
            throw reject("无法读取原定时任务目录预约");
        }
        if (
            value?.version !== 1 ||
            value.projectId !== project.id ||
            !identifier(value.family?.id) ||
            !["draft", "request"].includes(value.family?.kind) ||
            value.token !== familyToken(project.id, value.family) ||
            typeof value.root !== "string" ||
            typeof value.cwd !== "string" ||
            !identifier(value.taskRequestId)
        )
            throw reject("定时任务目录预约无效");
        return value;
    }
    async serial(project, work) {
        const next = (this.writes.get(project.id) ?? Promise.resolve()).catch(() => {}).then(work);
        this.writes.set(project.id, next);
        try {
            return await next;
        } finally {
            if (this.writes.get(project.id) === next) this.writes.delete(project.id);
        }
    }
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
                    (anchorThreadId &&
                        value.anchorThreadId &&
                        anchorThreadId !== value.anchorThreadId))
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
                    await writeFile(
                        join(this.backend.home, this.file(project)),
                        JSON.stringify(value),
                        { flag: "wx", mode: 0o600 },
                    );
                } catch (error) {
                    if (error.code !== "EEXIST") throw error;
                    const previous = await this.read(project);
                    if (
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
    reserveDraft(project, threadId, cwd, requests) {
        return this.reserve(project, { kind: "draft", id: threadId }, cwd, requests);
    }
    async reserveCreate(project, requestId, anchorThreadId, requests = {}) {
        let cwd = project.root;
        if (anchorThreadId) {
            const response = await project.client.request("thread/read", {
                threadId: anchorThreadId,
                includeTurns: false,
            });
            if (response.thread?.id !== anchorThreadId) throw reject("定时任务执行锚点无法确认");
            cwd = response.thread.cwd;
        }
        return this.reserve(
            project,
            { kind: "request", id: requestId },
            cwd,
            { ...requests, taskRequestId: requestId },
            anchorThreadId,
        );
    }
    async setAnchor(project, threadId) {
        if (!identifier(threadId)) throw reject("定时任务执行锚点无效");
        return this.serial(project, async () => {
            const value = await this.read(project);
            if (!value) throw reject("定时任务尚未预约独立目录");
            const response = await project.client.request("thread/read", {
                threadId,
                includeTurns: false,
            });
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
    async admitTask(project, taskId) {
        if (!identifier(taskId)) throw reject("定时任务身份无效");
        const task = await project.client.request("areal/task/read", { taskId });
        if (task?.id !== taskId || task.mode !== "scheduled") throw reject("无法确认原定时任务");
        let value = await this.read(project);
        if (!value) throw reject("原安排没有可核对的独立目录预约，请保持暂停或取消后重新安排");
        const identity = await this.eligible(project, value.cwd);
        if (
            value.root !== identity.root ||
            value.allocationId !== identity.allocationId ||
            task.threadId !== value.anchorThreadId
        )
            throw reject("原安排的目录或执行锚点已变化");
        if (!value.taskId) {
            const receipts = await project.client.request("areal/request/read", {
                requestId: value.taskRequestId,
            });
            const receipt = receipts.data?.find(
                (item) =>
                    (item.method ?? item.operation?.method) === "areal/task/create" &&
                    (item.requestId ?? item.operation?.requestId ?? value.taskRequestId) ===
                        value.taskRequestId,
            );
            const result = receipt?.result ?? receipt?.response?.result;
            if ((result?.id ?? receipt?.taskId) !== task.id)
                throw reject("原任务创建结果尚未核对，不会将回调绑定到其他安排");
            value = await this.bind(project, task);
        }
        if (value.taskId !== task.id) throw reject("此目录属于另一个定时任务，不会改绑");
        await this.backend.worktreeAdmission.claim(project, value.token);
        return { task, reservation: value };
    }
    async authorForSession(project, { name, request, threads, sessionId }) {
        if (!["respond", "continue"].includes(name)) return null;
        const reservation = await this.read(project);
        if (!reservation) return null;
        if (!identifier(reservation.taskId)) throw reject("原定时任务尚未完成绑定");
        const identity = await this.eligible(project, reservation.cwd);
        const task = await project.client.request("areal/task/read", {
            taskId: reservation.taskId,
        });
        if (
            identity.root !== reservation.root ||
            identity.allocationId !== reservation.allocationId ||
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
            task.runs.filter((run) => !["completed", "failed", "cancelled"].includes(run.status))
                .length !== 1
        )
            throw reject("只有当前未结束的定时执行可继续交互；暂停执行请使用任务恢复入口");
        const run = await project.client.request("areal/task/run/read", {
            taskId: task.id,
            runId: current.id,
        });
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
                [request.threadId, request.parentThreadId, request.sourceThreadId].filter(Boolean),
            ),
        ];
        if (
            !targetIds.length ||
            !Array.isArray(threads) ||
            threads.length !== targetIds.length ||
            targetIds.some((id) => !threads.some((thread) => thread.id === id))
        )
            throw reject("定时执行目标尚未全部核对");
        const readThread = async (threadId) => {
            const response = await project.client.request("thread/read", {
                threadId,
                includeTurns: false,
            });
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
            const target = targets.get(request.threadId);
            const result = await project.client.request("areal/interaction/list", {
                threadId: request.threadId,
            });
            const interaction = result.data?.find((value) => value.requestId === request.requestId);
            if (
                !target ||
                interaction?.threadId !== target.thread.id ||
                interaction.turnId !== target.turnId ||
                interaction.status !== "pending" ||
                !["approval", "question"].includes(interaction.kind) ||
                !Number.isSafeInteger(interaction.expiresAt) ||
                interaction.expiresAt <= Math.floor(Date.now() / 1000)
            )
                throw reject("原运行的待处理交互已结束或身份不匹配");
            if (interaction.kind === "approval") {
                if (
                    request.answers !== undefined ||
                    !["allowOnce", "allowSession", "allowProject", "deny"].includes(
                        request.decision,
                    )
                )
                    throw reject("审批回答与原交互类型不匹配");
            } else {
                const answers = request.answers;
                if (
                    request.decision !== undefined ||
                    !answers ||
                    typeof answers !== "object" ||
                    Array.isArray(answers) ||
                    !Array.isArray(interaction.questions) ||
                    Object.keys(answers).length !== interaction.questions.length ||
                    interaction.questions.some(
                        (question) =>
                            typeof answers[question.id] !== "string" ||
                            Buffer.byteLength(answers[question.id]) > 4096 ||
                            (question.allowFreeText === false &&
                                !question.options?.includes(answers[question.id])),
                    )
                )
                    throw reject("问题回答与原交互不匹配");
            }
            // 实际 respond 分支使用投影，先以刚核对的 Core 原始请求刷新，避免旧摘要误配。
            project.model.setInteractions(request.threadId, result);
        }
        if (name === "continue" && request.expectedTurnId !== targets.get(request.threadId)?.turnId)
            throw reject("原定时执行轮次已变化");
        return reservation.token;
    }
    async prepare(project, params) {
        if (
            !identifier(params?.taskId) ||
            !identifier(params.runId) ||
            !identifier(params.threadId) ||
            !["start", "resume"].includes(params.intent)
        )
            throw reject("定时执行准备身份无效");
        const { task, reservation } = await this.admitTask(project, params.taskId);
        const run = task.runs?.at(-1);
        if (
            task.cancelled !== false ||
            run?.id !== params.runId ||
            ![
                "queued",
                "running",
                "waitingForInput",
                "waitingForAgents",
                "paused",
                "blocked",
            ].includes(run.status) ||
            run.reason === "stopRequested" ||
            (params.intent === "start" && run.status !== "queued")
        )
            throw reject("原定时执行已结束或不是当前可准备的执行");
        const expected = params.intent === "start" ? reservation.anchorThreadId : run.threadId;
        if (params.threadId !== expected) throw reject("定时执行回调与原执行身份不匹配");
        const response = await project.client.request("thread/read", {
            threadId: params.threadId,
            includeTurns: false,
        });
        if (
            response.thread?.id !== params.threadId ||
            (await realpath(response.thread.cwd)) !== reservation.cwd
        )
            throw reject("定时执行目录已变化，未放行执行");
        return { task, reservation };
    }
}
module.exports = { ScheduleAdmission };
