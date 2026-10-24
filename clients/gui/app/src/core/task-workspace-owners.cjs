"use strict";
const { mkdir, readdir, readFile } = require("node:fs/promises");
const { join } = require("node:path");
const unavailable = (message) =>
    Object.assign(new Error(message), {
        code: "TASK_WORKSPACE_UNAVAILABLE",
        submissionUnknown: false,
        outcome: { kind: "noMutation" },
    });
const identifier = (value) =>
    typeof value === "string" && value.length > 0 && value.length <= 256 && !value.includes("\0");

class TaskWorkspaceOwners {
    constructor(backend) {
        this.backend = backend;
        this.hosts = new Map();
        this.owners = new Map();
        this.writes = new Map();
        this.dirty = new Set();
    }
    logical(project) {
        return project.logicalProjectId ?? project.id;
    }
    registered(id) {
        const owner = this.backend.saved.find((project) => project.id === id);
        if (!owner) throw unavailable("任务执行工作区已移除，请检查原任务");
        return owner;
    }
    async init() {
        const directory = join(this.backend.home, "task-owners");
        await mkdir(directory, { recursive: true, mode: 0o700 });
        for (const name of await readdir(directory)) {
            if (!/^[a-f0-9]{24}\.json$/.test(name)) continue;
            const records = JSON.parse(await readFile(join(directory, name), "utf8"));
            if (!Array.isArray(records)) throw unavailable("任务执行归属索引无效");
            // 已移除的宿主也保留归属，避免旧任务意外回退到来源目录。
            for (const record of records)
                this.remember(
                    name.slice(0, -5),
                    typeof record === "string" ? { id: record } : record,
                );
        }
    }
    remember(projectId, task) {
        if (!task || !identifier(task.id) || (task.threadId != null && !identifier(task.threadId)))
            throw unavailable("任务身份无效");
        let records = this.hosts.get(projectId);
        if (!records) {
            records = new Map();
            this.hosts.set(projectId, records);
        }
        const previous = records.get(task.id);
        const record = { id: task.id, threadId: task.threadId ?? previous?.threadId };
        if (
            task.ambiguous ||
            previous?.ambiguous ||
            (previous?.threadId && task.threadId && previous.threadId !== task.threadId)
        )
            record.ambiguous = true;
        records.set(task.id, record);
        let owners = this.owners.get(task.id);
        if (!owners) {
            owners = new Set();
            this.owners.set(task.id, owners);
        }
        owners.add(projectId);
        return JSON.stringify(previous) !== JSON.stringify(record);
    }
    async observe(project, task) {
        if (task?.id) await this.observeTasks(project, [task]);
    }
    async observeProject(project) {
        await this.observeTasks(project, Object.values(project.model.state.tasks ?? {}));
    }
    async observeTasks(project, tasks) {
        this.registered(project.id);
        let changed = false;
        for (const task of tasks)
            changed = this.remember(project.id, { ...task, id: task.taskId ?? task.id }) || changed;
        if (changed) this.dirty.add(project.id);
        if (this.dirty.has(project.id)) {
            const write = (this.writes.get(project.id) ?? Promise.resolve())
                .catch(() => {})
                .then(async () => {
                    await mkdir(join(this.backend.home, "task-owners"), {
                        recursive: true,
                        mode: 0o700,
                    });
                    try {
                        await this.backend.save(join("task-owners", project.id + ".json"), [
                            ...this.hosts.get(project.id).values(),
                        ]);
                        this.dirty.delete(project.id);
                    } catch (error) {
                        this.dirty.add(project.id);
                        throw error;
                    }
                });
            this.writes.set(project.id, write);
            await write;
        }
        if (
            tasks.some(
                (task) =>
                    this.owners.get(task.taskId ?? task.id)?.size > 1 ||
                    this.hosts.get(project.id).get(task.taskId ?? task.id)?.ambiguous,
            )
        )
            throw unavailable("任务执行归属不唯一，未向任何工作区发送操作");
    }
    async read(owner, taskId) {
        try {
            const { project, client } = await this.backend.readConnection(owner.id);
            const task = await client.request("areal/task/read", { taskId });
            this.backend.requireConnection(project, client);
            if (task?.id !== taskId) throw unavailable("原任务身份不匹配");
            return { project, task };
        } catch (error) {
            if (error.code === -32004) return null;
            throw unavailable("无法确认原任务的执行工作区，未发送操作；请先重新读取任务目录");
        }
    }
    async target(logicalId, taskId, options = {}) {
        if (!identifier(taskId)) throw unavailable("任务身份无效");
        const logical = this.logical(this.registered(logicalId));
        const indexed = this.owners.get(taskId);
        if (indexed?.size > 1) throw unavailable("任务执行归属不唯一，未向任何工作区发送操作");
        let candidates;
        if (indexed?.size) {
            const id = [...indexed][0];
            const owner = this.registered(id);
            if (this.logical(owner) !== logical) throw unavailable("任务不属于此逻辑项目");
            const record = this.hosts.get(id).get(taskId);
            if (record.ambiguous) throw unavailable("任务会话锚点不唯一，未向任何工作区发送操作");
            if (record.threadId && !options.execution) {
                await this.writes.get(id);
                // 等待落盘期间其他宿主可能报告冲突；放行前重新验证归属和锚点。
                const currentOwners = this.owners.get(taskId);
                const current = this.hosts.get(id)?.get(taskId);
                if (
                    currentOwners?.size !== 1 ||
                    !currentOwners.has(id) ||
                    current?.ambiguous ||
                    current?.threadId !== record.threadId
                )
                    throw unavailable("任务执行归属已变化，未向任何工作区发送操作");
                if (this.logical(this.registered(id)) !== logical)
                    throw unavailable("任务不属于此逻辑项目");
                return { projectId: id, threadId: current.threadId };
            }
            candidates = [owner];
        } else
            candidates = this.backend.saved.filter((project) => this.logical(project) === logical);
        let timer;
        let matches;
        try {
            matches = await Promise.race([
                Promise.all(candidates.map((owner) => this.read(owner, taskId))),
                new Promise((_, reject) => {
                    timer = setTimeout(
                        () => reject(unavailable("任务执行归属读取超时，未发送操作")),
                        5000,
                    );
                }),
            ]);
        } finally {
            clearTimeout(timer);
        }
        const found = matches.filter(Boolean);
        // 多宿主确认全部成功后才保存或放行，离线/超时不等于不存在。
        if (found.length !== 1)
            throw unavailable(
                found.length ? "任务执行归属不唯一，未发送操作" : "任务不存在于此逻辑项目",
            );
        await this.observe(found[0].project, found[0].task);
        return {
            projectId: found[0].project.id,
            threadId: found[0].task.threadId ?? undefined,
            ...(options.execution ? { mode: found[0].task.mode } : {}),
        };
    }
    async resolve(logicalId, taskId) {
        return (await this.target(logicalId, taskId)).projectId;
    }
}
module.exports = { TaskWorkspaceOwners };
