// @ts-check
"use strict";
const { readFile, readdir, realpath, open, mkdir, writeFile } = require("node:fs/promises");
const { constants } = require("node:fs");
const { join, relative, isAbsolute } = require("node:path");
const { homedir } = require("node:os");
const { createHash, randomUUID } = require("node:crypto");
const YAML = require("yaml");
const { builtinSkill, BUILTIN_SKILL_ID } = require("./builtin-skills.cjs");
const { WorktreeResources } = require("./worktree-resources.cjs");
const resourceContract = require("./resource-contract.cjs");
const { normalizeMcp } = resourceContract;
const { serverStatus } = require("./provider-contract.cjs");
/** @typedef {import('./project-state.cjs').CoreProject} CoreProject */
/** @typedef {Record<string,unknown> & {operation?:string,scope?:string,projectId?:string,id?:string,expectedRevision?:number,enabled?:boolean,content?:unknown,name?:unknown,description?:unknown,config?:unknown}} ResourceRequest */
const MAX_REGISTERED_SKILLS = 512;
const MAX_SKILL_DIRECTORY_ENTRIES = 512;
/** @param {unknown} value */
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** @param {string} root @param {string} path */
const within = (root, path) => {
  const r = relative(root, path);
  return !r || (!r.startsWith("..") && !isAbsolute(r));
};
/** @param {unknown} id @returns {id is string} */
const validId = (id) =>
  typeof id === "string" &&
  /^[a-zA-Z0-9_.-]{1,128}$/.test(id) &&
  !id.startsWith(".") &&
  !["__proto__", "constructor", "prototype"].includes(id);
/** @param {string} path */
async function bounded(path, bytes = 32768) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await file.stat()).isFile()) throw new Error("技能资源必须是普通文件");
    const b = Buffer.alloc(bytes + 1);
    const { bytesRead } = await file.read(b, 0, b.length, 0);
    return b.subarray(0, bytesRead).toString("utf8");
  } finally {
    await file.close();
  }
}
/** @param {string} text @param {string} id */
function metadata(text, id) {
  const lines = text.split(/\r?\n/);
  /** @type {unknown} */ let data;
  if (lines[0] === "---") {
    const end = lines.findIndex((v, i) => i && ["---", "..."].includes(v));
    if (end < 0) throw new Error("技能元信息超过 32 KiB 或未闭合");
    data = YAML.parse(lines.slice(1, end).join("\n"), { maxAliasCount: 0 }) ?? {};
  } else data = { name: id, description: lines[0] };
  if (
    !resourceContract.record(data) ||
    (typeof data.name !== "string" && data.name != null) ||
    (typeof data.description !== "string" && data.description != null)
  )
    throw new Error("技能名称和描述必须是文本");
  const name = data.name?.trim() || id;
  if (Buffer.byteLength(name) > 256) throw new Error("技能名称过长");
  return { name, description: (data.description ?? "").slice(0, 2048) };
}
// Desktop 管理资源配置，Runtime 仍拥有任务绑定、资源读取和 MCP 实时连接。
class ScopedResources {
  /** @param {InstanceType<typeof import('./backend.cjs').CoreBackend>} backend */
  constructor(backend) {
    this.backend = backend;
    /** @type {import('./resource-contract.cjs').ResourceState} */
    this.value = { revision: 0, skills: {}, mcp: [] };
    this.worktrees = new WorktreeResources(this);
  }
  async init() {
    try {
      this.value = resourceContract.resources(
        JSON.parse(await readFile(join(this.backend.home, "resources.json"), "utf8")),
      );
    } catch (e) {
      if (!(e instanceof Error && "code" in e && e.code === "ENOENT")) throw e;
    }
  }
  /** @param {unknown} id */
  project(id) {
    const p = this.backend.saved.find((p) => p.id === id);
    if (!p) throw new Error("请先打开项目");
    return p;
  }
  /** @param {ResourceRequest} request */
  scope(request) {
    if (request.scope === "user") return "user";
    if (request.scope === "project") return this.project(request.projectId).id;
    throw new Error("无效资源范围");
  }
  /** @param {string} scope */
  async scan(scope) {
    const rawBase =
      scope === "user" ? this.backend.userHome || homedir() : this.project(scope).root;
    const base = await realpath(rawBase);
    const roots = [];
    for (const rel of [".agents/skills", ".claude/skills"]) {
      try {
        const root = await realpath(join(base, rel));
        if (scope !== "user" && !within(base, root)) throw new Error("项目技能目录超出工作区");
        roots.push(root);
      } catch (e) {
        if (!(e instanceof Error && "code" in e && e.code === "ENOENT")) throw e;
      }
    }
    let managedRoot = join(this.backend.home, "resources", scope, "skills");
    try {
      managedRoot = await realpath(managedRoot);
      roots.unshift(managedRoot);
    } catch (e) {
      if (!(e instanceof Error && "code" in e && e.code === "ENOENT")) throw e;
    }
    /** @type {Map<string,import('./resource-contract.cjs').Skill>} */
    const items = new Map();
    for (const root of roots) {
      let entries;
      try {
        entries = await readdir(root, { withFileTypes: true });
      } catch (e) {
        if (e instanceof Error && "code" in e && e.code === "ENOENT") continue;
        throw e;
      }
      if (entries.length > MAX_SKILL_DIRECTORY_ENTRIES)
        throw new Error(
          `单个技能目录有 ${entries.length} 个原始目录项，超过 ${MAX_SKILL_DIRECTORY_ENTRIES} 项上限`,
        );
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const id = entry.name;
        if (
          id === BUILTIN_SKILL_ID ||
          !validId(id) ||
          items.has(id) ||
          !(entry.isDirectory() || entry.isSymbolicLink())
        )
          continue;
        const item = {
          id,
          scope: scope === "user" ? "user" : "project",
          managed: root === managedRoot,
          enabled: this.value.skills[scope]?.[id] !== false,
        };
        /** @type {string|undefined} */ let resolvedRoot;
        try {
          const directory = await realpath(join(root, id));
          resolvedRoot = directory;
          if (
            !roots.some((r) => within(r, directory)) &&
            !(scope !== "user" && within(base, directory))
          )
            throw new Error("技能目录链接超出可信范围");
          const meta = metadata(await bounded(join(directory, "SKILL.md")), id);
          items.set(id, {
            ...item,
            root: directory,
            ...meta,
            revision: `harness-${digest([directory, meta.name, meta.description]).slice(0, 32)}`,
          });
        } catch (e) {
          items.set(id, {
            ...item,
            root: resolvedRoot,
            name: id,
            enabled: false,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
    }
    return [...items.values()];
  }
  /** @param {ResourceRequest} request */
  async skills(request) {
    const scope = this.scope(request),
      data = await this.scan(scope);
    const projectSkills =
      scope === "user" && request.projectId
        ? await this.scan(this.project(request.projectId).id)
        : [];
    return {
      revision: this.value.revision,
      data: data.map((item) => ({
        ...item,
        overridden: scope === "user" && projectSkills.some((p) => p.id === item.id),
      })),
      customDeployment:
        !!this.backend.desktopConfig &&
        this.backend.desktopConfig !== join(__dirname, "desktop-profile.json"),
    };
  }
  /** @param {CoreProject} project */
  async deployment(project) {
    // 显式部署保留自身的权限与任务配置契约。
    if (this.backend.desktopConfig !== join(__dirname, "desktop-profile.json"))
      return {
        path: this.backend.desktopConfig,
        profile: this.backend.defaultProfile,
        fingerprint: "external",
      };
    const user = await this.scan("user"),
      local = await this.scan(project.id);
    const selected = new Map(user.map((s) => [s.id, s]));
    for (const s of local) selected.set(s.id, s);
    const skills = [...selected.values()]
      .filter(
        /** @returns {s is import('./resource-contract.cjs').AvailableSkill} */ (s) =>
          s.enabled && s.error === undefined,
      )
      .map(({ id, revision, root, name, description }) => ({
        id,
        revision,
        root,
        metadata: { name, description },
      }));
    const builtin = await builtinSkill(this.backend.home, BUILTIN_SKILL_ID);
    const { id, revision, name: builtinName, description } = builtin.skill;
    skills.push({ id, revision, root: builtin.root, metadata: { name: builtinName, description } });
    const base = resourceContract.deployment(
      JSON.parse(await readFile(this.backend.desktopConfig, "utf8")),
    );
    const profile = {
      ...base.profiles[0],
      allowPluginSkills: true,
      skills: skills.map(({ id, revision }) => ({ id, revision })),
    };
    profile.revision = `resources-${digest(profile).slice(0, 32)}`;
    // 重启后仍保留旧任务引用的资源版本。
    const filename = `${project.id}-skills.json`;
    /** @type {import('./resource-contract.cjs').DeployedSkill[]} */
    let previous = [];
    try {
      previous = resourceContract.deployedSkills(
        JSON.parse(await readFile(join(this.backend.home, filename), "utf8")),
      );
    } catch (e) {
      if (!(e instanceof Error && "code" in e && e.code === "ENOENT")) throw e;
    }
    const union = new Map(previous.map((s) => [`${s.id}/${s.revision}`, s]));
    for (const s of skills) union.set(`${s.id}/${s.revision}`, s);
    const all = [];
    for (const s of union.values()) {
      try {
        await bounded(join(s.root, "SKILL.md"), 1);
        all.push(s);
      } catch {}
    }
    if (all.length > MAX_REGISTERED_SKILLS)
      throw new Error(
        `技能登记超出容量：当前启用 ${skills.length} 项，保留版本合计 ${all.length} 项，上限 ${MAX_REGISTERED_SKILLS} 项`,
      );
    await this.backend.save(filename, all);
    const name = `${project.id}-desktop.json`;
    await this.backend.save(name, {
      ...base,
      skills: all,
      profiles: [...base.profiles, profile],
    });
    return {
      path: join(this.backend.home, name),
      profile: { id: profile.id, revision: profile.revision },
      fingerprint: profile.revision,
    };
  }
  /** @param {CoreProject} project */
  async beforeCreate(project) {
    if (!project.client) throw new Error("Core 尚未连接");
    const deployment = await this.deployment(project);
    if (deployment.fingerprint === project.resourceFingerprint) return project;
    if (
      this.backend.resourcesUpdating ||
      this.backend.activeCommands > 1 ||
      this.backend.starting.size ||
      project.pending.length
    )
      throw new Error("技能配置正在更新，请稍后创建任务");
    this.backend.resourcesUpdating = true;
    try {
      if (
        !(await project.client.request("areal/server/status", {}, { decode: serverStatus }))
          .restartSafe
      )
        throw new Error("技能配置已保存，请在当前任务和终端结束后创建新任务");
      const connected = (
        await project.client.request("areal/mcp/list", {}, { decode: resourceContract.mcpServers })
      ).data
        .filter((m) => ["connected", "stale"].includes(m.state))
        .map((m) => m.id);
      const connectedPlugins = ["areal/plugin/mcp/list", "areal/plugin/connection"].every(
        (method) => requireClient(project).capabilities?.methods?.includes(method),
      )
        ? (
            await requireClient(project).request(
              "areal/plugin/mcp/list",
              {},
              { decode: resourceContract.pluginConnections },
            )
          ).data
            .filter((plugin) => plugin.trusted && ["connected", "partial"].includes(plugin.state))
            .map(({ pluginId, installedDigest }) => ({ pluginId, installedDigest }))
        : [];
      const result = await project.client.request(
        "areal/server/drain",
        {
          strategy: "wait",
          timeoutMs: 5000,
        },
        { decode: serverStatus },
      );
      if (!result.restartSafe) throw new Error("Core 尚未就绪，技能将在下次创建任务时应用");
      await this.backend.restartProject(project);
      const current = (
        await project.client.request("areal/mcp/list", {}, { decode: resourceContract.mcpServers })
      ).data;
      for (const id of connected) {
        const m = current.find((m) => m.id === id);
        if (m)
          await this.backend.submit(project, "areal/mcp/connect", {
            id,
            expectedRevision: m.revision,
          });
      }
      for (const plugin of connectedPlugins) {
        const restored = resourceContract.pluginConnections(
          await this.backend.submit(project, "areal/plugin/connection", {
            id: plugin.pluginId,
            expectedDigest: plugin.installedDigest,
            connect: true,
          }),
        );
        const current = restored.data.find((row) => row.pluginId === plugin.pluginId);
        if (
          current?.installedDigest !== plugin.installedDigest ||
          !current.trusted ||
          !["connected", "partial"].includes(current.state)
        )
          throw new Error(`插件 ${plugin.pluginId} 连接未恢复，请检查认证和连接状态`);
      }
      return project;
    } finally {
      this.backend.resourcesUpdating = false;
    }
  }
  /** @param {CoreProject} project @param {import('@areal/workbench/desktop-contract').ResourceRef} [requestedProfile] */
  async prepareCreator(project, requestedProfile) {
    if (!project.client) throw new Error("Core 尚未连接");
    if (
      project.projectless ||
      !this.backend.saved.some((item) => item.id === project.id && !item.projectless)
    )
      throw new Error("请先选择要创建 Skill 的项目。");
    const { skill, provenance } = await builtinSkill(this.backend.home, BUILTIN_SKILL_ID);
    await this.beforeCreate(project);
    const managed = this.backend.desktopConfig === join(__dirname, "desktop-profile.json");
    const base =
      managed && this.backend.desktopConfig
        ? resourceContract.deployment(
            JSON.parse(await readFile(this.backend.desktopConfig, "utf8")),
          ).profiles[0]
        : null;
    const useCurrent =
      !requestedProfile ||
      (managed && requestedProfile.id === base?.id && requestedProfile.revision === base?.revision);
    const profile = useCurrent
      ? (project.resourceProfile ?? this.backend.defaultProfile)
      : requestedProfile;
    if (!profile) throw new Error("当前部署未配置默认任务配置，现有草稿已保留。");
    const available = await project.client.request(
      "areal/skill/list",
      { agentProfile: profile },
      { decode: resourceContract.availableSkills },
    );
    if (
      !available.data.some(
        (item) => item.available && item.id === skill.id && item.revision === skill.revision,
      )
    )
      throw new Error("当前任务配置未提供官方 Skill Creator 的确切版本，现有草稿已保留。");
    this.backend.onChange();
    return { projectId: project.id, profile, skill, provenance };
  }
  /** @param {ResourceRequest} request */
  async mcpList(request) {
    const scope = this.scope(request);
    const project = request.projectId
      ? await this.backend.start(this.project(request.projectId).id)
      : null;
    const live = project
      ? (
          await requireClient(project).request(
            "areal/mcp/list",
            {},
            { decode: resourceContract.mcpServers },
          )
        ).data
      : [];
    if (scope === "user")
      return {
        revision: this.value.revision,
        data: this.value.mcp.map((m) => ({
          ...m,
          ...live.find((x) => x.id === m.runtimeId),
          id: m.id,
          runtimeId: m.runtimeId,
          config: m.config,
          liveRevision: live.find((x) => x.id === m.runtimeId)?.revision ?? 0,
          scope: "user",
          state: live.find((x) => x.id === m.runtimeId)?.state ?? "notApplied",
        })),
      };
    return {
      revision: this.value.revision,
      data: live
        .filter((m) => !this.value.mcp.some((u) => u.runtimeId === m.id))
        .map((m) => ({ ...m, scope: "project" })),
    };
  }
  /** @param {CoreProject} project */
  async syncMcp(project) {
    if (!this.value.mcp.length || project.pending.length) return; // 同步前先核对未知回执。
    const client = requireClient(project);
    const live = (
      await client.request("areal/mcp/list", {}, { decode: resourceContract.mcpServers })
    ).data;
    for (const m of this.value.mcp) {
      const current = live.find((s) => s.id === m.runtimeId);
      if (current && digest(normalizeMcp(current.config)) === digest(m.config)) continue;
      if (current && !["disconnected", "failed"].includes(current.state))
        throw new Error(`请先断开 ${m.id}，再应用用户配置`);
      await this.backend.submit(project, "areal/mcp/configure", {
        id: m.runtimeId,
        expectedRevision: current?.revision ?? 0,
        config: m.config,
      });
    }
  }
  /** @param {unknown} request */
  async command(request) {
    if (!isResourceRequest(request)) throw new Error("资源操作参数无效");
    const { operation } = request;
    if (typeof operation !== "string") throw new Error("资源操作无效");
    if (this.backend.resourcesUpdating || this.backend.providerUpdating)
      throw new Error("配置正在更新，请稍后重试");
    if (operation === "hooks" || operation === "hooksSave")
      return this.backend.hooks.command(request);
    if (operation === "builtinSkill") {
      const { skill, provenance } = await builtinSkill(this.backend.home, request.id ?? "");
      return { skill, provenance };
    }
    if (operation === "skills") return this.skills(request);
    if (operation === "mcp") {
      this.backend.activeCommands++;
      try {
        return await this.mcpList(request);
      } finally {
        this.backend.activeCommands--;
      }
    }
    if (operation === "skillRead") {
      const item = (await this.scan(this.scope(request))).find((s) => s.id === request.id);
      if (!item || item.error || !item.root) throw new Error("技能不可读");
      const content = await bounded(join(item.root, "SKILL.md"), 256 * 1024);
      return {
        content: content.slice(0, 256 * 1024),
        truncated: Buffer.byteLength(content) > 256 * 1024,
      };
    }
    if (
      this.backend.providerUpdating ||
      this.backend.resourcesUpdating ||
      this.backend.activeCommands ||
      this.backend.starting.size
    )
      throw new Error("配置正在更新，请稍后重试");
    this.backend.resourcesUpdating = true;
    try {
      const scope = this.scope(request);
      if (["mcpConnect", "mcpDisconnect"].includes(operation)) {
        /** @type {CoreProject} */
        const project = await this.backend.start(this.project(request.projectId).id);
        if (!project.client) throw new Error("Core 尚未连接");
        if (project.pending.length) throw new Error("请先核对项目中未确认的操作");
        const item = scope === "user" ? this.value.mcp.find((m) => m.id === request.id) : null;
        if (scope === "user" && !item) throw new Error("服务器已不存在");
        await this.syncMcp(project);
        const id = item?.runtimeId ?? request.id;
        const live = (
          await project.client.request(
            "areal/mcp/list",
            {},
            { decode: resourceContract.mcpServers },
          )
        ).data.find((m) => m.id === id);
        if (!live) throw new Error("服务器已不存在");
        if (scope !== "user" && request.expectedRevision !== live.revision)
          throw new Error("配置已变化，请刷新");
        await this.backend.submit(
          project,
          operation === "mcpConnect" ? "areal/mcp/connect" : "areal/mcp/disconnect",
          { id, expectedRevision: live.revision },
        );
        return this.mcpList(request);
      }
      if (
        request.expectedRevision !== this.value.revision &&
        !(operation === "mcpSave" && scope !== "user")
      )
        throw new Error("配置已变化，请刷新后重试");
      const next = structuredClone(this.value);
      if (operation === "skillToggle") {
        if (!(await this.scan(scope)).some((s) => s.id === request.id && !s.error))
          throw new Error("技能不可用");
        next.skills[scope] ??= {};
        if (!request.id) throw new Error("技能 ID 无效");
        next.skills[scope][request.id] = request.enabled === true;
      } else if (operation === "skillSave") {
        if (request.id === BUILTIN_SKILL_ID || !validId(request.id))
          throw new Error("技能 ID 仅支持字母、数字、连字符、下划线与点（最多 128 字符）");
        const meta = metadata(
          `---\n${YAML.stringify({ name: request.name, description: request.description })}---`,
          request.id,
        );
        if (
          typeof request.content !== "string" ||
          !request.content.trim() ||
          Buffer.byteLength(request.content) > 128 * 1024
        )
          throw new Error("请填写技能指令（最多 128 KiB）");
        const found = (await this.scan(scope)).find((s) => s.id === request.id);
        if (found) throw new Error("此范围已有同名技能，请使用其他 ID");
        const directory = join(this.backend.home, "resources", scope, "skills", request.id);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await writeFile(
          join(directory, "SKILL.md"),
          `---\n${YAML.stringify(meta)}---\n${request.content.trim()}\n`,
          { flag: "wx", mode: 0o600 },
        );
      } else if (operation === "mcpSave") {
        if (typeof request.id !== "string" || !/^[a-zA-Z0-9_-]{1,32}$/.test(request.id))
          throw new Error("服务 ID 仅支持 1–32 位字母、数字、下划线或连字符");
        const config = normalizeMcp(request.config);
        if (scope !== "user") {
          if (this.value.mcp.some((m) => m.runtimeId === request.id))
            throw new Error("请在用户范围编辑此配置");
          /** @type {CoreProject} */
          const project = await this.backend.start(this.project(request.projectId).id);
          if (!project.client) throw new Error("Core 尚未连接");
          if (project.pending.length) throw new Error("请先核对项目中未确认的操作");
          await this.backend.submit(project, "areal/mcp/configure", {
            id: request.id,
            expectedRevision: request.expectedRevision,
            config,
          });
          return this.mcpList(request);
        }
        const old = next.mcp.find((m) => m.id === request.id);
        if (!old && next.mcp.length >= 16) throw new Error("最多配置 16 个用户 MCP");
        for (const p of this.backend.projects.values()) {
          if (p.pending.length || (old && p.service && !p.client?.ready))
            throw new Error("请先恢复所有项目连接并核对未确认操作");
          if (old && p.client?.ready) {
            const m = (
              await p.client.request("areal/mcp/list", {}, { decode: resourceContract.mcpServers })
            ).data.find((m) => m.id === old.runtimeId);
            if (m && !["disconnected", "failed"].includes(m.state))
              throw new Error(`请先在 ${p.root} 断开 ${request.id}`);
          }
        }
        /** @type {import('./resource-contract.cjs').UserMcp} */
        const item = {
          id: request.id,
          runtimeId: old?.runtimeId ?? `user_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
          config,
        };
        next.mcp = old ? next.mcp.map((m) => (m.id === item.id ? item : m)) : [...next.mcp, item];
      } else throw new Error("不支持的资源操作");
      next.revision++;
      await this.backend.save("resources.json", next);
      this.value = next;
      const failures = [];
      if (operation === "mcpSave")
        for (const p of this.backend.projects.values())
          if (p.client?.ready) {
            try {
              await this.syncMcp(p);
            } catch (e) {
              failures.push(`${p.root}: ${e instanceof Error ? e.message : String(e)}`);
            }
          }
      this.backend.onChange();
      return {
        revision: next.revision,
        warning: failures.length ? `配置已保存，部分项目未同步：${failures.join("；")}` : null,
      };
    } finally {
      this.backend.resourcesUpdating = false;
    }
  }
}
/** @param {CoreProject} project */
function requireClient(project) {
  if (!project.client) throw new Error("Core 尚未连接");
  return project.client;
}
/** @param {unknown} value @returns {value is ResourceRequest} */
function isResourceRequest(value) {
  return resourceContract.isRequest("resources", value);
}
module.exports = { ScopedResources, metadata, normalizeMcp };
