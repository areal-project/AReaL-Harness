// @ts-check
"use strict";
const { realpath, stat, open, rename, unlink } = require("node:fs/promises");
const { createWriteStream, constants } = require("node:fs");
const { pipeline } = require("node:stream/promises");
const { randomUUID } = require("node:crypto");
const { join, resolve, sep, basename, dirname } = require("node:path");
const childProcess = require("node:child_process");
const { modelRecord } = require("@areal/workbench/core-model-contract");
// 对话里内联显示工作区图片：只按文件头识别常见位图，SVG 等可执行格式只给文件卡。
const MAX_INLINE_IMAGE_BYTES = 20 * 1024 * 1024;
/** @param {Buffer} bytes */
function imageMimeType(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  const head = bytes.subarray(0, 6).toString("latin1");
  if (head === "GIF87a" || head === "GIF89a") return "image/gif";
  if (
    bytes.subarray(0, 4).toString("latin1") === "RIFF" &&
    bytes.subarray(8, 12).toString("latin1") === "WEBP"
  )
    return "image/webp";
  return undefined;
}
const editors = [
  { id: "zed", label: "Zed", bundle: "Zed.app" },
  { id: "vscode", label: "Visual Studio Code", bundle: "Visual Studio Code.app" },
  { id: "cursor", label: "Cursor", bundle: "Cursor.app" },
];

/** @param {Pick<InstanceType<typeof import("./service-client.cjs").SharedCoreBackend>,"snapshot">} backend @param {Record<string,unknown>} request @returns {import("./service-state.cjs").ServiceProject} */
function fileWorkspace(backend, request) {
  /** @type {import("./service-state.cjs").ServiceProject|undefined} */
  const project = backend.snapshot().projects.find((value) => value.id === request.projectId);
  if (!project) throw new Error("未知工作区");
  if (request.threadId === undefined) return project;
  if (typeof request.threadId !== "string" || !request.threadId) throw new Error("无效会话身份");
  const thread =
    project.state?.threads?.[request.threadId] ??
    (Array.isArray(project.summaries)
      ? project.summaries.filter(modelRecord).find((value) => value.id === request.threadId)
      : undefined);
  if (!modelRecord(thread)) throw new Error("会话工作目录尚未确认，请先打开会话");
  if (!thread.worktree) return project;
  if (
    !modelRecord(thread.worktree) ||
    thread.worktree.state !== "ready" ||
    typeof thread.worktree.directory !== "string"
  )
    throw new Error("工作树绑定尚未确认");
  return {
    ...project,
    root: thread.worktree.directory,
    executionProjectId: thread.executionProjectId,
  };
}

// Main owns OS handoff. Renderer selects a registered workspace and an opaque
// target ID, never an executable, command line or unrestricted absolute path.
/** @param {{backend:Pick<InstanceType<typeof import("./service-client.cjs").SharedCoreBackend>,"snapshot"|"command">,shell:Pick<typeof import("electron").shell,"showItemInFolder"|"openPath">,home:string,authorize:()=>void,chooseSave:(options:import("electron").SaveDialogOptions)=>Promise<import("electron").SaveDialogReturnValue>}} options @param {unknown} request */
async function fileOpen({ backend, shell, home, authorize, chooseSave }, request) {
  if (!modelRecord(request)) throw new Error("无效文件打开请求");
  /** @type {Array<{id:string,label:string,application?:string}>} */
  const targets = [{ id: "system", label: "系统默认应用" }];
  if (process.platform === "darwin") {
    targets.push({ id: "finder", label: "Finder" });
    for (const editor of editors) {
      for (const base of ["/Applications", join(home, "Applications")]) {
        const path = join(base, editor.bundle);
        try {
          if ((await stat(path)).isDirectory()) {
            targets.push({ id: editor.id, label: editor.label, application: path });
            break;
          }
        } catch (error) {
          if (!modelRecord(error) || error.code !== "ENOENT") throw error;
        }
      }
    }
  }
  const preferred = backend.snapshot().library.settings.fileOpenTarget ?? "system";
  if (request.operation === "targets")
    return {
      targets: targets.map(({ id, label }) => ({ id, label })),
      preferred,
      preferredLabel:
        targets.find((t) => t.id === preferred)?.label ??
        `${editors.find((t) => t.id === preferred)?.label ?? preferred}（不可用）`,
    };
  if (request.operation === "setDefault") {
    if (typeof request.target !== "string" || !targets.some((t) => t.id === request.target))
      throw new Error("所选打开应用不可用，请重新选择");
    authorize();
    await backend.command("library", {
      operation: "settings",
      key: "fileOpenTarget",
      value: request.target,
    });
    return {};
  }
  if (
    typeof request.operation !== "string" ||
    !["open", "reveal", "saveAs", "readImage"].includes(request.operation) ||
    typeof request.projectId !== "string" ||
    typeof request.path !== "string" ||
    !request.path ||
    request.path.length > 4096 ||
    request.path.includes("\0")
  )
    throw new Error("无效文件打开请求");
  const project = fileWorkspace(backend, request);
  const root = await realpath(project.root),
    path = await realpath(resolve(root, request.path));
  if (path !== root && !path.startsWith(root + sep)) throw new Error("文件不在当前工作区内");
  const info = await stat(path);
  if (!info.isFile() && !info.isDirectory()) throw new Error("仅支持文件或目录");
  if (request.operation === "readImage") {
    if (!info.isFile()) throw new Error("仅支持图片文件");
    if (info.size > MAX_INLINE_IMAGE_BYTES) throw new Error("图片超过 20 MB，请在外部应用中打开");
    const source = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const bytes = await source.readFile();
      if (bytes.byteLength > MAX_INLINE_IMAGE_BYTES)
        throw new Error("图片超过 20 MB，请在外部应用中打开");
      const mimeType = imageMimeType(bytes);
      if (!mimeType) throw new Error("不是可直接显示的图片");
      return { mimeType, bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) };
    } finally {
      await source.close();
    }
  }
  if (request.operation === "saveAs") {
    if (!info.isFile()) throw new Error("仅支持另存普通文件");
    authorize();
    const source = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    /** @type {string|null|undefined} */ let temporary;
    /** @type {Array<'dev'|'ino'|'size'|'mtimeMs'|'ctimeMs'>} */
    const versionKeys = ["dev", "ino", "size", "mtimeMs", "ctimeMs"];
    /** @param {import('node:fs').Stats} value */
    const sameVersion = (value) =>
      value.isFile() && versionKeys.every((key) => value[key] === info[key]);
    try {
      if (!sameVersion(await source.stat())) throw new Error("源文件已变化，请重新另存");
      // The native chooser alone grants the destination. Pin the source inode
      // and stage the full bytes so a failed copy cannot truncate a destination.
      const result = await chooseSave({ title: "另存文件", defaultPath: basename(path) });
      if (result.canceled || !result.filePath) return { saved: false };
      authorize();
      const current = fileWorkspace(backend, request);
      if (
        current.root !== project.root ||
        current.executionProjectId !== project.executionProjectId ||
        (await realpath(resolve(root, request.path))) !== path ||
        !sameVersion(await stat(path)) ||
        !sameVersion(await source.stat())
      )
        throw new Error("源文件已变化，请重新另存");
      let destination;
      try {
        destination = await stat(result.filePath);
      } catch (error) {
        if (!modelRecord(error) || error.code !== "ENOENT") throw error;
      }
      if (destination?.dev === info.dev && destination?.ino === info.ino)
        throw new Error("另存位置不能是原文件");
      temporary = join(dirname(result.filePath), `.areal-save-${randomUUID()}.tmp`);
      await pipeline(
        source.createReadStream({ autoClose: false }),
        createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
      );
      if (!sameVersion(await stat(path)) || !sameVersion(await source.stat()))
        throw new Error("源文件已变化，请重新另存");
      authorize();
      await rename(temporary, result.filePath);
      temporary = null;
      return { saved: true };
    } catch (error) {
      if (modelRecord(error) && typeof error.code === "string") {
        const message = ["EISDIR", "ENOTDIR"].includes(error.code)
          ? "请选择文件位置，不能覆盖目录"
          : ["EACCES", "EPERM"].includes(error.code)
            ? "所选位置不可写，请重新选择另存位置"
            : error.code === "ENOENT"
              ? "源文件或另存位置已不存在，请重新选择"
              : "无法另存文件，请检查所选位置后重试";
        throw new Error(message);
      }
      throw error;
    } finally {
      if (temporary) await unlink(temporary).catch(() => {});
      await source.close();
    }
  }
  if (request.operation === "reveal") {
    authorize();
    shell.showItemInFolder(path);
    return {};
  }
  const target = targets.find((t) => t.id === preferred);
  if (!target) throw new Error("默认打开应用已不可用，请在设置中重新选择");
  authorize();
  if (target.id === "finder") {
    shell.showItemInFolder(path);
    return {};
  }
  if (target.id === "system") {
    const error = await shell.openPath(path);
    if (error) throw new Error(error);
    return {};
  }
  const application = target.application;
  if (!application) throw new Error("所选打开应用不可用，请重新选择");
  await new Promise((done, reject) => {
    childProcess.execFile(
      "/usr/bin/open",
      ["-a", application, path],
      { timeout: 15000 },
      (error) => (error ? reject(error) : done(undefined)),
    );
  });
  return {};
}
module.exports = { fileOpen };
