// @ts-check
"use strict";
const { cp, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } = require("node:fs/promises");
const { join } = require("node:path");
const { record, mcpServers, normalizeMcp } = require("./resource-contract.cjs");
/** @typedef {{sourceId:string,sourceRoot:string,targetRoot:string,preferences:Record<string,boolean>,mcp:Array<{id:string,config:import('./resource-contract.cjs').McpConfig}>}} ResourcePlan */

// One-time Desktop resource import. Git owns repository files; Core owns MCP
// revisions and connections. A durable snapshot precedes project registration,
// so retries never read a newer source or replace a destination's later edits.
class WorktreeResources {
  /** @param {InstanceType<typeof import('./scoped-resources.cjs').ScopedResources>} resources */
  constructor(resources) {
    this.resources = resources;
    this.backend = resources.backend;
    this.writes = Promise.resolve();
  }
  /** @param {string} id */
  directory(id) {
    this.backend.worktrees.key(id);
    return join(this.backend.home, "worktree-resource-imports", id);
  }
  /** @param {import('./project-index.cjs').SavedProject} project */
  async read(project) {
    if (!project.worktreeResources) return null;
    const directory = this.directory(project.worktreeResources);
    const plan = readPlan(JSON.parse(await readFile(join(directory, "plan.json"), "utf8")));
    if (plan.targetRoot !== project.root) throw new Error("工作树资源记录与项目目录不匹配");
    try {
      /** @type {unknown} */
      const complete = JSON.parse(await readFile(join(directory, "complete.json"), "utf8"));
      if (!record(complete) || complete.projectId !== project.id)
        throw new Error("工作树资源记录与项目不匹配");
      return null;
    } catch (error) {
      if (!record(error) || error.code !== "ENOENT") throw error;
    }
    return { directory, plan };
  }
  /** @param {string} source @param {string} destination */
  async copySkills(source, destination) {
    // Managed skill folders may contain supporting scripts/assets. Preserve
    // their bytes/modes, but do not follow links into another scope or copy IPC.
    await cp(source, destination, {
      recursive: true,
      force: false,
      errorOnExist: true,
      filter: async (path) => {
        const stat = await lstat(path);
        if (!stat.isFile() && !stat.isDirectory())
          throw new Error("项目管理的技能包含链接或特殊文件，无法安全继承");
        return true;
      },
    });
  }
  /** @param {import('./project-index.cjs').SavedProject} source @param {string} targetRoot @param {string} requestId */
  async snapshot(source, targetRoot, requestId) {
    const directory = this.directory(requestId);
    try {
      const plan = readPlan(JSON.parse(await readFile(join(directory, "plan.json"), "utf8")));
      if (
        plan.sourceId !== source.id ||
        plan.sourceRoot !== source.root ||
        plan.targetRoot !== targetRoot
      )
        throw new Error("工作树资源快照不属于此创建请求");
      return;
    } catch (error) {
      if (!record(error) || error.code !== "ENOENT") throw error;
    }
    const b = this.backend;
    // This is a read-only source snapshot, not a Core restart. Ordinary sidebar
    // reads and unrelated project startups must not prevent opening a worktree.
    // Configuration writers own these locks; await the source's own start below.
    if (b.resourcesUpdating || b.providerUpdating)
      throw new Error("配置正在使用，请稍后打开工作树");
    b.resourcesUpdating = true;
    let staging;
    try {
      const live = await b.start(source.id);
      if (live.pending.length) throw new Error("源项目有待核对的提交，请先恢复后再继承资源");
      if (!live.client) throw new Error("Core 连接不可用");
      const mcp = (await live.client.request("areal/mcp/list", {}, { decode: mcpServers })).data
        .filter((item) => !this.resources.value.mcp.some((user) => user.runtimeId === item.id))
        .map((item) => ({ id: item.id, config: normalizeMcp(item.config) }));
      await mkdir(join(b.home, "worktree-resource-imports"), { recursive: true, mode: 0o700 });
      staging = await mkdtemp(directory + ".staging-");
      const managed = join(b.home, "resources", source.id, "skills");
      let exists = true;
      try {
        await lstat(managed);
      } catch (error) {
        if (!record(error) || error.code !== "ENOENT") throw error;
        exists = false;
      }
      if (exists) await this.copySkills(managed, join(staging, "skills"));
      else await mkdir(join(staging, "skills"), { mode: 0o700 });
      const plan = {
        sourceId: source.id,
        sourceRoot: source.root,
        targetRoot,
        preferences: structuredClone(this.resources.value.skills[source.id] ?? {}),
        mcp,
      };
      await writeFile(join(staging, "plan.json"), JSON.stringify(plan), {
        mode: 0o600,
        flag: "wx",
      });
      await rename(staging, directory);
      staging = null;
    } finally {
      try {
        if (staging) await rm(staging, { recursive: true, force: true });
      } finally {
        b.resourcesUpdating = false;
      }
    }
  }
  /** @param {import('./project-index.cjs').SavedProject} project */
  async prepare(project) {
    // Multiple projects may start concurrently. Serialize the one shared
    // preference write; ordinary resource editing is blocked during startup.
    const work = this.writes
      .catch(() => {})
      .then(async () => {
        const pending = await this.read(project);
        if (!pending) return;
        const parent = join(this.backend.home, "resources", project.id);
        const destination = join(parent, "skills");
        const marker = ".worktree-import.json";
        await mkdir(parent, { recursive: true, mode: 0o700 });
        let exists = true;
        try {
          if (!(await lstat(destination)).isDirectory())
            throw new Error("工作树技能目录不是独立目录，未覆盖");
        } catch (error) {
          if (!record(error) || error.code !== "ENOENT") throw error;
          exists = false;
        }
        if (exists) {
          /** @type {unknown} */
          const receipt = JSON.parse(await readFile(join(destination, marker), "utf8"));
          if (!record(receipt) || receipt.requestId !== project.worktreeResources)
            throw new Error("工作树已有不同技能资源，未覆盖");
        } else {
          const staging = await mkdtemp(join(parent, ".inherit-"));
          try {
            await this.copySkills(join(pending.directory, "skills"), join(staging, "skills"));
            await writeFile(
              join(staging, "skills", marker),
              JSON.stringify({ requestId: project.worktreeResources }),
              { mode: 0o600 },
            );
            await rename(join(staging, "skills"), destination);
          } finally {
            await rm(staging, { recursive: true, force: true });
          }
        }
        const next = structuredClone(this.resources.value);
        const preferences = { ...pending.plan.preferences, ...next.skills[project.id] };
        if (JSON.stringify(next.skills[project.id]) !== JSON.stringify(preferences)) {
          next.skills[project.id] = preferences;
          next.revision++;
          await this.backend.save("resources.json", next);
          this.resources.value = next;
        }
      });
    this.writes = work;
    await work;
  }
  /** @param {import('./project-state.cjs').CoreProject} project */
  async apply(project) {
    const pending = await this.read(project);
    if (!pending) return;
    if (project.pending.length) throw new Error("工作树资源提交尚未确认，请先核对后重新打开");
    if (!project.client || !project.worktreeResources) throw new Error("Core 工作树资源归属不可用");
    const live = (await project.client.request("areal/mcp/list", {}, { decode: mcpServers })).data;
    for (const item of pending.plan.mcp) {
      const existing = live.find((server) => server.id === item.id);
      if (existing) {
        if (JSON.stringify(normalizeMcp(existing.config)) !== JSON.stringify(item.config))
          throw new Error(`工作树 MCP ${item.id} 已有不同配置，未覆盖`);
        continue;
      }
      await this.backend.submit(project, "areal/mcp/configure", {
        id: item.id,
        config: item.config,
        expectedRevision: 0,
      });
    }
    await this.backend.save(
      join("worktree-resource-imports", project.worktreeResources, "complete.json"),
      { projectId: project.id },
    );
  }
}
/** @param {unknown} value @returns {ResourcePlan} */
function readPlan(value) {
  if (
    !record(value) ||
    typeof value.sourceId !== "string" ||
    typeof value.sourceRoot !== "string" ||
    typeof value.targetRoot !== "string" ||
    !record(value.preferences) ||
    !Array.isArray(value.mcp)
  )
    throw new Error("工作树资源快照无效");
  const preferences = Object.fromEntries(
    Object.entries(value.preferences).map(([id, enabled]) => {
      if (typeof enabled !== "boolean") throw new Error("工作树技能偏好无效");
      return [id, enabled];
    }),
  );
  const mcp = value.mcp.map((/** @type {unknown} */ item) => {
    if (!record(item) || typeof item.id !== "string") throw new Error("工作树 MCP 快照无效");
    return { id: item.id, config: normalizeMcp(item.config) };
  });
  return {
    ...value,
    sourceId: value.sourceId,
    sourceRoot: value.sourceRoot,
    targetRoot: value.targetRoot,
    preferences,
    mcp,
  };
}
module.exports = { WorktreeResources };
