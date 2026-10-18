"use strict";
const {
  readFile,
  readdir,
  realpath,
  open,
  mkdir,
  writeFile,
  rename,
} = require("node:fs/promises");
const { constants } = require("node:fs");
const { join, relative, isAbsolute } = require("node:path");
const { homedir } = require("node:os");
const { createHash, randomUUID } = require("node:crypto");
const YAML = require("yaml");
const { WorktreeResources } = require('./worktree-resources.cjs');
const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const within = (root, path) => {
  const r = relative(root, path);
  return !r || (!r.startsWith("..") && !isAbsolute(r));
};
const validId = (id) =>
  typeof id === "string" &&
  /^[a-zA-Z0-9_.-]{1,128}$/.test(id) &&
  !id.startsWith(".") &&
  !["__proto__", "constructor", "prototype"].includes(id);
async function bounded(path, bytes = 32768) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await file.stat()).isFile())
      throw new Error("技能资源必须是普通文件");
    const b = Buffer.alloc(bytes + 1);
    const { bytesRead } = await file.read(b, 0, b.length, 0);
    return b.subarray(0, bytesRead).toString("utf8");
  } finally {
    await file.close();
  }
}
function metadata(text, id) {
  const lines = text.split(/\r?\n/);
  let data;
  if (lines[0] === "---") {
    const end = lines.findIndex((v, i) => i && ["---", "..."].includes(v));
    if (end < 0) throw new Error("技能元信息超过 32 KiB 或未闭合");
    data =
      YAML.parse(lines.slice(1, end).join("\n"), { maxAliasCount: 0 }) ?? {};
  } else data = { name: id, description: lines[0] };
  if (
    (typeof data.name !== "string" && data.name != null) ||
    (typeof data.description !== "string" && data.description != null)
  )
    throw new Error("技能名称和描述必须是文本");
  const name = data.name?.trim() || id;
  if (Buffer.byteLength(name) > 256) throw new Error("技能名称过长");
  return { name, description: (data.description ?? "").slice(0, 2048) };
}
// App-owned configuration. Runtime still owns task bindings, resource reads and
// live MCP connections. This directory is never an alternative execution loop.
class ScopedResources {
  constructor(backend) {
    this.backend = backend;
    this.value = { revision: 0, skills: {}, mcp: [] };
    this.worktrees = new WorktreeResources(this);
  }
  async init() {
    try {
      this.value = JSON.parse(
        await readFile(join(this.backend.home, "resources.json"), "utf8"),
      );
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  project(id) {
    const p = this.backend.saved.find((p) => p.id === id);
    if (!p) throw new Error("请先打开项目");
    return p;
  }
  scope(request) {
    if (request.scope === "user") return "user";
    if (request.scope === "project") return this.project(request.projectId).id;
    throw new Error("无效资源范围");
  }
  async scan(scope) {
    const rawBase =
      scope === "user"
        ? this.backend.userHome || homedir()
        : this.project(scope).root;
    const base = await realpath(rawBase);
    const roots = [];
    for (const rel of [".agents/skills", ".claude/skills"]) {
      try {
        const root = await realpath(join(base, rel));
        if (scope !== "user" && !within(base, root))
          throw new Error("项目技能目录超出工作区");
        roots.push(root);
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
    }
    let managedRoot = join(this.backend.home, "resources", scope, "skills");
    try {
      managedRoot = await realpath(managedRoot);
      roots.unshift(managedRoot);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    const items = new Map();
    for (const root of roots) {
      let entries;
      try {
        entries = await readdir(root, { withFileTypes: true });
      } catch (e) {
        if (e.code === "ENOENT") continue;
        throw e;
      }
      if (entries.length > 256) throw new Error("单个技能目录最多支持 256 项");
      for (const entry of entries.sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        const id = entry.name;
        if (
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
        try {
          item.root = await realpath(join(root, id));
          if (
            !roots.some((r) => within(r, item.root)) &&
            !(scope !== "user" && within(base, item.root))
          )
            throw new Error("技能目录链接超出可信范围");
          Object.assign(
            item,
            metadata(await bounded(join(item.root, "SKILL.md")), id),
          );
          item.revision = `harness-${digest([item.root, item.name, item.description]).slice(0, 32)}`;
        } catch (e) {
          item.error = e.message;
          item.name = id;
          item.enabled = false;
        }
        items.set(id, item);
      }
    }
    return [...items.values()];
  }
  async skills(request) {
    const scope = this.scope(request),
      data = await this.scan(scope);
    const projectSkills = request.projectId
      ? await this.scan(this.project(request.projectId).id)
      : [];
    return {
      revision: this.value.revision,
      data: data.map((item) => ({
        ...item,
        overridden:
          scope === "user" && projectSkills.some((p) => p.id === item.id),
      })),
      customDeployment:
        !!this.backend.desktopConfig &&
        this.backend.desktopConfig !== join(__dirname, "desktop-profile.json"),
    };
  }
  async deployment(project) {
    // Explicit deployments retain their own permission/profile contract.
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
      .filter((s) => s.enabled && !s.error)
      .map(({ id, revision, root, name, description }) => ({
        id,
        revision,
        root,
        metadata: { name, description },
      }));
    const base = JSON.parse(await readFile(this.backend.desktopConfig, "utf8"));
    const profile = {
      ...base.profiles[0],
      skills: skills.map(({ id, revision }) => ({ id, revision })),
    };
    profile.revision = `resources-${digest(profile).slice(0, 32)}`;
    // Keep resource references used by older tasks available after restart.
    const filename = `${project.id}-skills.json`;
    let previous = [];
    try {
      previous = JSON.parse(
        await readFile(join(this.backend.home, filename), "utf8"),
      );
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
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
    if (all.length > 128)
      throw new Error("技能版本目录超过 Runtime 的 128 项限制");
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
  async beforeCreate(project) {
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
      if (!(await project.client.request("areal/server/status")).restartSafe)
        throw new Error("技能配置已保存，请在当前任务和终端结束后创建新任务");
      const connected = (await project.client.request("areal/mcp/list")).data
        .filter((m) => ["connected", "stale"].includes(m.state))
        .map((m) => m.id);
      const result = await project.client.request("areal/server/drain", {
        strategy: "wait",
        timeoutMs: 5000,
      });
      if (!result.restartSafe)
        throw new Error("Core 尚未就绪，技能将在下次创建任务时应用");
      await this.backend.restartProject(project);
      const current = (await project.client.request("areal/mcp/list")).data;
      for (const id of connected) {
        const m = current.find((m) => m.id === id);
        if (m)
          await this.backend.submit(project, "areal/mcp/connect", {
            id,
            expectedRevision: m.revision,
          });
      }
      return project;
    } finally {
      this.backend.resourcesUpdating = false;
    }
  }
  async mcpList(request) {
    const scope = this.scope(request);
    const project = request.projectId
      ? await this.backend.start(request.projectId)
      : null;
    const live = project
      ? (await project.client.request("areal/mcp/list")).data
      : [];
    if (scope === "user")
      return {
        revision: this.value.revision,
        data: this.value.mcp.map((m) => ({
          ...m,
          ...(live.find((x) => x.id === m.runtimeId) ?? {}),
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
  async syncMcp(project) {
    if (!this.value.mcp.length || project.pending.length) return; // Reconcile unknown receipts before attempting any synchronization.
    const live = (await project.client.request("areal/mcp/list")).data;
    for (const m of this.value.mcp) {
      const current = live.find((s) => s.id === m.runtimeId);
      if (current && digest(normalizeMcp(current.config)) === digest(m.config))
        continue;
      if (current && !["disconnected", "failed"].includes(current.state))
        throw new Error(`请先断开 ${m.id}，再应用用户配置`);
      await this.backend.submit(project, "areal/mcp/configure", {
        id: m.runtimeId,
        expectedRevision: current?.revision ?? 0,
        config: m.config,
      });
    }
  }
  async command(request) {
    const { operation } = request;
    if (this.backend.resourcesUpdating || this.backend.providerUpdating)
      throw new Error("配置正在更新，请稍后重试");
    if (operation === "hooks" || operation === "hooksSave") return this.backend.hooks.command(request);
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
      const item = (await this.scan(this.scope(request))).find(
        (s) => s.id === request.id,
      );
      if (!item || item.error) throw new Error("技能不可读");
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
        const project = await this.backend.start(request.projectId);
        if (project.pending.length)
          throw new Error("请先核对项目中未确认的操作");
        const item =
          scope === "user"
            ? this.value.mcp.find((m) => m.id === request.id)
            : null;
        if (scope === "user" && !item) throw new Error("服务器已不存在");
        await this.syncMcp(project);
        const id = item?.runtimeId ?? request.id;
        const live = (await project.client.request("areal/mcp/list")).data.find(
          (m) => m.id === id,
        );
        if (!live) throw new Error("服务器已不存在");
        if (scope !== "user" && request.expectedRevision !== live.revision)
          throw new Error("配置已变化，请刷新");
        await this.backend.submit(
          project,
          operation === "mcpConnect"
            ? "areal/mcp/connect"
            : "areal/mcp/disconnect",
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
        if (
          !(await this.scan(scope)).some((s) => s.id === request.id && !s.error)
        )
          throw new Error("技能不可用");
        next.skills[scope] ??= {};
        next.skills[scope][request.id] = request.enabled === true;
      } else if (operation === "skillSave") {
        if (!validId(request.id))
          throw new Error(
            "技能 ID 仅支持字母、数字、连字符、下划线与点（最多 128 字符）",
          );
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
        const directory = join(
          this.backend.home,
          "resources",
          scope,
          "skills",
          request.id,
        );
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await writeFile(
          join(directory, "SKILL.md"),
          `---\n${YAML.stringify(meta)}---\n${request.content.trim()}\n`,
          { flag: "wx", mode: 0o600 },
        );
      } else if (operation === "mcpSave") {
        if (!/^[a-zA-Z0-9_-]{1,32}$/.test(request.id))
          throw new Error("服务 ID 仅支持 1–32 位字母、数字、下划线或连字符");
        const config = normalizeMcp(request.config);
        if (scope !== "user") {
          if (this.value.mcp.some((m) => m.runtimeId === request.id))
            throw new Error("请在用户范围编辑此配置");
          const project = await this.backend.start(request.projectId);
          if (project.pending.length)
            throw new Error("请先核对项目中未确认的操作");
          await this.backend.submit(project, "areal/mcp/configure", {
            id: request.id,
            expectedRevision: request.expectedRevision,
            config,
          });
          return this.mcpList(request);
        }
        const old = next.mcp.find((m) => m.id === request.id);
        if (!old && next.mcp.length >= 16)
          throw new Error("最多配置 16 个用户 MCP");
        for (const p of this.backend.projects.values()) {
          if (p.pending.length || (p.service && !p.client?.ready))
            throw new Error("请先恢复所有项目连接并核对未确认操作");
          if (old && p.client?.ready) {
            const m = (await p.client.request("areal/mcp/list")).data.find(
              (m) => m.id === old.runtimeId,
            );
            if (m && !["disconnected", "failed"].includes(m.state))
              throw new Error(`请先在 ${p.root} 断开 ${request.id}`);
          }
        }
        const item = {
          id: request.id,
          runtimeId:
            old?.runtimeId ??
            `user_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
          config,
        };
        next.mcp = old
          ? next.mcp.map((m) => (m.id === item.id ? item : m))
          : [...next.mcp, item];
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
              failures.push(`${p.root}: ${e.message}`);
            }
          }
      this.backend.onChange();
      return {
        revision: next.revision,
        warning: failures.length
          ? `配置已保存，部分项目未同步：${failures.join("；")}`
          : null,
      };
    } finally {
      this.backend.resourcesUpdating = false;
    }
  }
}
function normalizeMcp(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("无效 MCP 配置");
  const t = raw.transport;
  const env = (v) =>
    typeof v === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(v);
  const keys = (object, allowed) => {
    if (Object.keys(object).some((k) => !allowed.includes(k)))
      throw new Error("MCP 配置包含不支持的字段");
  };
  keys(raw, ["transport", "startupTimeoutMs", "callTimeoutMs", "enabledTools"]);
  if (!t || typeof t !== "object" || Array.isArray(t))
    throw new Error("请配置 MCP transport");
  let transport;
  if (t.type === "stdio") {
    keys(t, ["type", "command", "args", "cwd", "envVars"]);
    if (
      typeof t.command !== "string" ||
      !t.command.trim() ||
      t.command.includes("\0") ||
      !Array.isArray(t.args ?? []) ||
      (t.args ?? []).length > 256 ||
      (t.args ?? []).some((a) => typeof a !== "string" || a.includes("\0")) ||
      !Array.isArray(t.envVars ?? []) ||
      (t.envVars ?? []).length > 64 ||
      (t.envVars ?? []).some((e) => !env(e)) ||
      (t.cwd != null && (typeof t.cwd !== "string" || !t.cwd))
    )
      throw new Error("MCP 命令、参数或环境变量名称无效");
    transport = {
      type: t.type,
      command: t.command,
      args: t.args ?? [],
      cwd: t.cwd ?? null,
      envVars: t.envVars ?? [],
    };
  } else if (t.type === "streamableHttp") {
    keys(t, ["type", "url", "bearerTokenEnv"]);
    let url;
    try {
      url = new URL(t.url);
    } catch {
      throw new Error("MCP URL 无效");
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash ||
      (t.bearerTokenEnv != null && !env(t.bearerTokenEnv))
    )
      throw new Error("MCP URL 或认证环境变量名称无效");
    transport = {
      type: t.type,
      url: t.url,
      bearerTokenEnv: t.bearerTokenEnv ?? null,
    };
  } else throw new Error("不支持的 MCP transport");
  const startupTimeoutMs = raw.startupTimeoutMs ?? 30000,
    callTimeoutMs =
      raw.callTimeoutMs === undefined ? 120000 : raw.callTimeoutMs;
  if (
    !Number.isSafeInteger(startupTimeoutMs) ||
    startupTimeoutMs <= 0 ||
    (callTimeoutMs !== null &&
      (!Number.isSafeInteger(callTimeoutMs) || callTimeoutMs <= 0))
  )
    throw new Error("MCP 超时必须为正整数");
  const enabledTools = raw.enabledTools ?? null;
  if (
    enabledTools !== null &&
    (!Array.isArray(enabledTools) ||
      enabledTools.length > 128 ||
      enabledTools.some((v) => typeof v !== "string" || !v || v.length > 256))
  )
    throw new Error("无效工具列表");
  const result = { transport, startupTimeoutMs, callTimeoutMs, enabledTools };
  if (Buffer.byteLength(JSON.stringify(result)) > 65536)
    throw new Error("MCP 配置过大");
  return result;
}
module.exports = { ScopedResources, metadata, normalizeMcp };
