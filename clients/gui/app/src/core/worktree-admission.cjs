"use strict";
const { mkdir, readFile, open, link, unlink, realpath, readdir } = require("node:fs/promises");
const { join, relative, isAbsolute, resolve, sep } = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { commandSemantics } = require("@areal/workbench/desktop-contract");
const { checkoutRoot } = require("@areal/workspace-git");
const contains = (parent, child) => {
    const path = relative(parent, child);
    return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
};

const noWorkspaceEffect = new Set([
    "create",
    "configure",
    "prepareCreator",
    "attachBrowser",
    "prediction",
    "media",
    "dismissRecovery",
]);
const cleanup = new Set([
    "processTerminate",
    "executionCancel",
    "workgroupCancel",
    "taskCancel",
    "taskDelete",
    "taskPause",
    "taskStopRun",
    "goalPause",
    "goalClear",
    "closeResources",
    "toolAcknowledge",
    "hookAcknowledge",
    "serverDrain",
    "mcpAppClose",
]);
const workspaceEffects = new Set(["save", "gitStage", "gitUnstage", "gitCommit", "gitPush"]);
const threadEffects = new Set([
    "send",
    "editMessage",
    "continue",
    "steer",
    "respond",
    "queueEdit",
    "fork",
]);
const taskActivations = new Set([
    "taskRunNow",
    "taskResume",
    "taskResumeRun",
    "taskReply",
    "taskUpdate",
]);
const reject = (reason) =>
    Object.assign(
        new Error(`${reason}。请新建独立 Worktree 会话；已有会话不会迁移或在来源目录重试。`),
        {
            code: "WORKTREE_REQUIRED",
            submissionUnknown: false,
            outcome: { kind: "noMutation" },
        },
    );

class WorktreeAdmission {
    constructor(backend) {
        this.backend = backend;
        this.queues = new Map();
    }
    needsAdmission(name, request) {
        if (
            commandSemantics(name, request).effect !== "mutation" ||
            noWorkspaceEffect.has(name) ||
            name === "stop" ||
            (name === "side" && request.operation !== "create")
        )
            return false;
        if (name === "workspace") return workspaceEffects.has(request.operation);
        if (name === "manage" && request.operation === "taskCreate") return true;
        if (name === "queueEdit" && ["pause", "remove"].includes(request.operation)) return false;
        if (name === "manage" && cleanup.has(request.operation)) return false;
        if (threadEffects.has(name)) return true;
        return !!(request.threadId || request.parentThreadId || request.sourceThreadId);
    }
    async thread(project, threadId) {
        if (typeof threadId !== "string" || !threadId) throw reject("尚未选择可核对的会话");
        const result = await project.client.request("thread/read", {
            threadId,
            includeTurns: false,
        });
        const thread = result?.thread;
        if (thread?.id !== threadId || typeof thread.sessionId !== "string" || !thread.sessionId)
            throw reject("会话执行身份尚未确认");
        return thread;
    }
    async authorSession(project, thread) {
        const owner = thread.parentThreadId
            ? await this.thread(project, thread.sessionId) : thread;
        if (owner.conversation?.kind !== "side" || owner.conversation.policy?.kind !== "sideExecutableV2")
            return thread.sessionId;
        const source = await this.thread(project, owner.conversation.origin?.sourceThreadId);
        if (owner.conversation.version !== 2 || source.conversation?.kind === "side" || source.parentThreadId
            || typeof owner.cwd !== "string" || typeof source.cwd !== "string"
            || await realpath(owner.cwd) !== await realpath(source.cwd)
            || await realpath(owner.cwd) !== await realpath(project.root))
            throw reject("可执行旁路讨论的来源与执行目录尚未确认");
        return source.sessionId;
    }
    async session(project, request) {
        const targets = [
            ...new Set(
                [request.threadId, request.parentThreadId, request.sourceThreadId].filter(Boolean),
            ),
        ];
        if (!targets.length) throw reject("写入需要绑定到具体会话");
        const threads = await Promise.all(targets.map((id) => this.thread(project, id)));
        const sessions = new Set(await Promise.all(threads.map((thread) => this.authorSession(project, thread))));
        if (sessions.size !== 1) throw reject("一次执行不能包含不同会话作者");
        return {
            threads,
            sessionId: [...sessions][0],
            readOnlySide: threads.some((thread) => thread.conversation?.kind === "side" && thread.conversation.policy?.kind !== "sideExecutableV2"),
            readOnlyTaskDraft: threads.every((thread) => {
                const options = thread.desktop?.configuration?.options;
                return (
                    options?.appendInstructions?.startsWith("AREAL_TASK_DRAFT_V1\n") === true &&
                    options.readOnly === true &&
                    Array.isArray(options.toolAllowlist) &&
                    options.toolAllowlist.length === 0
                );
            }),
        };
    }
    async checkExistingEffects(project, sessionId) {
        const status = await project.client.request("areal/server/status", {});
        if (
            status?.acceptingWork !== true ||
            ![
                "activeTurns",
                "resources",
                "unresolvedTools",
                "activeGoals",
                "compactions",
                "workgroups",
            ].every((key) => Array.isArray(status[key])) ||
            !["activeTasks", "pendingQueueItems"].every(
                (key) => Number.isSafeInteger(status[key]) && status[key] >= 0,
            )
        )
            throw reject("后台执行状态尚未确认");
        if (
            status.activeTasks ||
            status.pendingQueueItems ||
            status.unresolvedTools.length ||
            status.workgroups.some(
                (group) => group.status === "running" || group.cleanupConfirmed !== true,
            )
        )
            throw reject("后台仍有待结算或无法归属的执行");
        const ids = new Set([
            ...status.activeTurns.map((value) => value.threadId),
            ...status.activeGoals,
            ...status.compactions,
        ]);
        for (const resource of status.resources) {
            if (
                typeof resource.threadId !== "string" ||
                !resource.threadId ||
                ["cleanupUnknown", "unavailable", "closing"].includes(resource.state)
            )
                throw reject("后台进程或子任务的写入归属尚未确认");
            ids.add(resource.threadId);
        }
        for (const id of ids)
            if (await this.authorSession(project, await this.thread(project, id)) !== sessionId)
                throw reject("此目录已有其他会话或其后台任务在执行");
    }
    registeredProjects() {
        return new Map(
            [...(this.backend.saved ?? []), ...(this.backend.projects?.values() ?? [])].map(
                (project) => [project.id, project],
            ),
        ).values();
    }
    async registeredIdentity(candidate, root) {
        try {
            const cwd = await realpath(candidate.root);
            return (await checkoutRoot(cwd)) ?? cwd;
        } catch (error) {
            const path = resolve(candidate.root);
            if (error.code === "ENOENT" && !contains(root, path) && !contains(path, root))
                return null;
            throw error;
        }
    }
    async checkPeerEffects(project, root, sessionId) {
        for (const candidate of this.registeredProjects()) {
            if (candidate.id === project.id || !candidate.root) continue;
            if ((await this.registeredIdentity(candidate, root)) !== root) continue;
            if (!candidate.client?.ready)
                throw reject("同一检出目录的其他执行后台尚未连接，无法确认已有后台任务");
            await this.checkExistingEffects(candidate, sessionId);
        }
    }
    async checkTaskCatalog(project, sessionId) {
        let schedule = null;
        if (sessionId.startsWith("schedule:")) {
            if (typeof this.backend.scheduleAdmission?.read !== "function")
                throw reject("定时任务家庭记录尚不可核对");
            schedule = await this.backend.scheduleAdmission.read(project);
        }
        let after;
        const seen = new Set();
        for (let page = 0; page < 1000; page++) {
            let value;
            try {
                value = await project.client.request("areal/task/list", {
                    limit: 100,
                    ...(after ? { after } : {}),
                });
            } catch (cause) {
                throw Object.assign(reject("无法核对可能休眠或已准备的定时任务目录"), { cause });
            }
            if (
                !Array.isArray(value?.data) ||
                !Object.hasOwn(value, "nextCursor") ||
                (value.nextCursor !== null &&
                    (typeof value.nextCursor !== "string" || !value.nextCursor)) ||
                (value.hasMore !== undefined && value.hasMore !== (value.nextCursor !== null))
            )
                throw reject("任务目录分页状态尚未确认");
            let previous = after;
            for (const task of value.data) {
                if (
                    typeof task?.id !== "string" ||
                    !task.id ||
                    seen.has(task.id) ||
                    (previous && task.id <= previous) ||
                    !["scheduled", "foreground", "background"].includes(task.mode) ||
                    typeof task.cancelled !== "boolean"
                )
                    throw reject("任务目录包含无法核对的执行身份");
                seen.add(task.id);
                previous = task.id;
                if (
                    task.mode === "scheduled" &&
                    !task.cancelled &&
                    (!schedule ||
                        schedule.token !== sessionId ||
                        schedule.taskId !== task.id ||
                        schedule.anchorThreadId !== task.threadId)
                )
                    throw reject(
                        "目录仍有不属于已核对调度家庭的定时任务，休眠或暂停不释放执行资格",
                    );
            }
            if (value.nextCursor === null) return;
            if (!value.data.length || value.nextCursor !== previous)
                throw reject("任务目录分页未前进，不能放行写入");
            after = value.nextCursor;
        }
        throw reject("任务目录尚未完整核对，不能放行写入");
    }
    async checkCheckoutTasks(project, root, sessionId) {
        await this.checkTaskCatalog(project, sessionId);
        for (const candidate of this.registeredProjects()) {
            if (candidate.id === project.id || !candidate.root) continue;
            if ((await this.registeredIdentity(candidate, root)) !== root) continue;
            if (!candidate.client?.ready) throw reject("同一检出目录的其他任务目录尚不可核对");
            await this.checkTaskCatalog(candidate, sessionId);
        }
    }
    async read(file, root) {
        let record;
        try {
            record = JSON.parse(await readFile(file, "utf8"));
        } catch (error) {
            if (error.code === "ENOENT") return null;
            throw reject("目录作者记录无法读取");
        }
        if (
            record?.version !== 1 ||
            typeof record.root !== "string" ||
            !isAbsolute(record.root) ||
            (root !== undefined && record.root !== root) ||
            typeof record.projectId !== "string" ||
            !record.projectId ||
            typeof record.sessionId !== "string" ||
            !record.sessionId
        )
            throw reject("目录作者记录与执行目录不匹配");
        return record;
    }
    async identity(project) {
        const cwd = await realpath(project.root);
        const checkout = await checkoutRoot(cwd);
        const root = checkout ?? cwd;
        if (!contains(root, cwd)) throw reject("检出目录身份与执行目录不一致");
        for (const candidate of this.registeredProjects()) {
            if (!candidate.root || candidate.id === project.id) continue;
            const other = await this.registeredIdentity(candidate, root);
            if (!other) continue;
            if (other !== root && (contains(root, other) || contains(other, root)))
                throw reject("不同检出或非 Git 执行目录物理重叠，无法确认独占作者");
        }
        return root;
    }
    async checkOverlappingRecords(directory, root, schedulesOnly = false) {
        for (const name of await readdir(directory)) {
            if (!name.endsWith(".json")) continue;
            const record = await this.read(join(directory, name));
            if (!record) throw reject("已有目录作者记录无法核对");
            if (schedulesOnly && !record.sessionId.startsWith("schedule:")) continue;
            if (
                (schedulesOnly && record.root === root) ||
                (record.root !== root &&
                    (contains(root, record.root) || contains(record.root, root)))
            )
                throw reject("重叠目录已有作者记录，须核查旧执行身份，未覆盖或迁移记录");
        }
    }
    async claimLock(directory) {
        const file = join(directory, "claim.lock");
        for (let attempt = 0; attempt < 100; attempt++) {
            try {
                const handle = await open(file, "wx", 0o600);
                return async () => {
                    await handle.close();
                    await unlink(file);
                };
            } catch (error) {
                if (error.code !== "EEXIST") throw error;
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
        }
        // 崩溃留下的锁不根据心跳自动删除，避免让尚未停止的旧进程失去所有权。
        throw reject("目录作者登记仍在处理中或中断后尚未核对");
    }
    async claim(project, sessionId) {
        const root = await this.identity(project),
            directory = join(this.backend.home, "workspace-authors");
        await this.checkCheckoutTasks(project, root, sessionId);
        const file = join(directory, createHash("sha256").update(root).digest("hex") + ".json");
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await this.checkOverlappingRecords(directory, root);
        let current = await this.read(file, root);
        if (!current) {
            const release = await this.claimLock(directory);
            try {
                await this.checkOverlappingRecords(directory, root);
                current = await this.read(file, root);
                if (current) {
                    if (current.sessionId !== sessionId)
                        throw reject("此执行目录已保留给另一个会话及其后台任务");
                    return;
                }
                await this.checkExistingEffects(project, sessionId);
                await this.checkPeerEffects(project, root, sessionId);
                const temporary = file + "." + randomUUID() + ".tmp";
                const handle = await open(temporary, "wx", 0o600);
                try {
                    await handle.writeFile(
                        JSON.stringify({
                            version: 1,
                            root,
                            projectId: project.id,
                            sessionId,
                            claimedAt: new Date().toISOString(),
                        }),
                    );
                    await handle.sync();
                } finally {
                    await handle.close();
                }
                try {
                    await link(temporary, file);
                } catch (error) {
                    if (error.code !== "EEXIST") throw error;
                } finally {
                    await unlink(temporary);
                }
                current = await this.read(file, root);
            } finally {
                await release();
            }
        }
        if (current.sessionId !== sessionId)
            throw reject("此执行目录已保留给另一个会话及其后台任务");
    }
    async admit(project, name, request) {
        if (name === "manage" && request.operation === "taskDraftStart") return;
        // 专用调度门禁在创建任何执行会话前保留 Task 家族作者；不误认只读管理会话。
        if (
            name === "manage" &&
            (request.operation === "taskDraftConfirm" ||
                (request.operation === "taskCreate" && request.mode === "scheduled"))
        ) {
            if (
                typeof this.backend.scheduleAdmission?.reserveDraft !== "function" ||
                typeof this.backend.scheduleAdmission?.reserveCreate !== "function"
            )
                throw reject("专用定时任务执行目录准入尚不可用");
            return;
        }
        if (name === "manage" && taskActivations.has(request.operation) && request.taskId) {
            try {
                const task = await project.client.request("areal/task/read", {
                    taskId: request.taskId,
                });
                if (
                    task?.id !== request.taskId ||
                    !["scheduled", "background", "foreground"].includes(task.mode)
                )
                    throw reject("任务执行身份尚未确认");
                if (task.mode === "scheduled") {
                    if (typeof this.backend.scheduleAdmission?.admitTask !== "function")
                        throw reject("专用定时任务执行目录准入尚不可用");
                    await this.backend.scheduleAdmission.admitTask(
                        project,
                        task.id,
                        request.operation,
                    );
                    return;
                }
            } catch (error) {
                if (error.code === "WORKTREE_REQUIRED") throw error;
                throw Object.assign(reject("无法确认定时任务的执行目录准入"), { cause: error });
            }
        }
        if (!this.needsAdmission(name, request)) return;
        const previous = this.queues.get(project.id) ?? Promise.resolve();
        const task = previous
            .catch(() => {})
            .then(async () => {
                if (!project.client?.ready) throw reject("原执行后台尚未连接");
                const { threads, sessionId, readOnlySide, readOnlyTaskDraft } = await this.session(
                    project,
                    request,
                );
                if (
                    readOnlyTaskDraft &&
                    (name === "send" ||
                        (name === "manage" && request.operation === "taskDraftSend"))
                )
                    return;
                // Legacy Side retention is Core-owned history management, not workspace authorship.
                if (name === "manage" && ["archive", "unarchive"].includes(request.operation)
                    && threads.some(thread => thread.id === request.threadId
                        && thread.conversation?.kind === "side"
                        && thread.conversation.policy?.kind === "sideReadOnlyV1")) return;
                if (readOnlySide) throw reject("旁路讨论不能作为工作区作者执行写入");
                if (typeof this.backend.scheduleAdmission?.authorForSession === "function") {
                    const verified = await this.backend.scheduleAdmission.authorForSession(
                        project,
                        { name, request, threads, sessionId },
                    );
                    if (verified !== null) {
                        if (
                            typeof verified !== "string" ||
                            !/^schedule:[a-f0-9]{64}$/.test(verified)
                        )
                            throw reject("调度执行作者映射尚未确认");
                        await this.claim(project, verified);
                        return;
                    }
                }
                const cwd = await realpath(project.root),
                    root = (await checkoutRoot(cwd)) ?? cwd,
                    directory = join(this.backend.home, "workspace-authors");
                await this.checkCheckoutTasks(project, root, sessionId);
                let release;
                try {
                    release = await this.claimLock(directory);
                } catch (error) {
                    if (error.code !== "ENOENT") throw error;
                }
                try {
                    if (release) await this.checkOverlappingRecords(directory, root, true);
                    if (await this.backend.scheduleAdmission?.read?.(project))
                        throw reject("此目录已保留给独立定时任务家庭");
                } finally {
                    await release?.();
                }
            });
        this.queues.set(project.id, task);
        try {
            await task;
        } catch (error) {
            if (error.code === "WORKTREE_REQUIRED") throw error;
            // 资格检查失败尚未启动用户操作，不能把它当作未知提交而在来源目录重试。
            throw Object.assign(reject("无法确认目录作者或后台状态"), { cause: error });
        } finally {
            if (this.queues.get(project.id) === task) this.queues.delete(project.id);
        }
    }
}
module.exports = { WorktreeAdmission };
