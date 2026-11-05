// @ts-check
"use strict";
const { record, threadRead, part } = require("@areal/workbench-service/desktop/core/remote-core-decoder.cjs");
const { basename } = require("node:path");
/** @param {Record<string,unknown>|null|undefined} value @param {string[]} fields */
const pick = (value, fields) =>
  Object.fromEntries(
    fields.filter((key) => value?.[key] !== undefined).map((key) => [key, value?.[key]]),
  );

// Explicit projection: neither backend.snapshot() nor arbitrary Core RPC results
// may cross this boundary. User-authored task contents remain intentionally visible.
/** @param {InstanceType<typeof import("@areal/workbench-service/desktop/core/backend.cjs").CoreBackend>} backend @param {{projects:string[]}} device */
function projectSnapshot(backend, device) {
  /** @type {unknown} */
  const snapshot = backend.snapshot();
  if (!record(snapshot) || !Array.isArray(snapshot.projects) || !snapshot.projects.every(record))
    throw new Error("项目快照无效");
  const names =
    record(snapshot.library) && record(snapshot.library.projects) ? snapshot.library.projects : {};
  return {
    projects: snapshot.projects
      .filter((project) => typeof project.id === "string" && device.projects.includes(project.id))
      .map((project) => {
        if (
          typeof project.id !== "string" ||
          typeof project.root !== "string" ||
          !Array.isArray(project.summaries) ||
          !project.summaries.every(record) ||
          !Array.isArray(project.pending) ||
          !project.pending.every(record) ||
          (project.state != null && !record(project.state))
        )
          throw new Error("项目快照无效");
        const state = project.state ?? {};
        if (
          (state.threads != null && !record(state.threads)) ||
          (state.interactions != null && !record(state.interactions))
        )
          throw new Error("会话快照无效");
        const interactions = state.interactions ?? {},
          name = names[project.id];
        return {
          id: project.id,
          name: record(name) ? (name.name ?? basename(project.root)) : basename(project.root),
          connected: state.connected === true,
          summaries: project.summaries.map((value) =>
            pick(value, ["id", "title", "preview", "updatedAt", "createdAt"]),
          ),
          threads: Object.fromEntries(
            Object.entries(state.threads ?? {}).map(([id, raw]) => {
              const thread = threadRead({ thread: raw }).thread;
              const interaction = interactions[id];
              /** @type {Record<string,unknown>[]} */
              let data = [];
              if (interaction != null) {
                if (
                  !record(interaction) ||
                  !Array.isArray(interaction.data) ||
                  !interaction.data.every(record)
                )
                  throw new Error("交互快照无效");
                data = interaction.data;
              }
              return [
                id,
                {
                  id,
                  title: thread.title,
                  archived: thread.desktop?.archived === true,
                  turns: (thread.turns ?? []).map((turn) => ({
                    id: turn.id,
                    status: turn.status,
                    items: (turn.items ?? []).flatMap((item) => {
                      if (item.type === "agentMessage")
                        return [pick(item, ["id", "type", "text", "phase"])];
                      if (item.type === "userMessage")
                        return [
                          {
                            id: item.id,
                            type: item.type,
                            content: (item.content ?? [])
                              .filter(part)
                              .filter((value) => ["text", "image"].includes(value.type))
                              .map((value) => pick(value, ["type", "text", "url"])),
                          },
                        ];
                      if (item.type === "agentMedia" && item.modality === "image")
                        return [{ id: item.id, type: item.type, url: item.media?.uri }];
                      return [];
                    }),
                  })),
                  interactions: data
                    .filter((value) => value.status === "pending")
                    .map((value) =>
                      pick(value, [
                        "requestId",
                        "kind",
                        "status",
                        "threadId",
                        "turnId",
                        "tool",
                        "effectiveArguments",
                        "questions",
                      ]),
                    ),
                },
              ];
            }),
          ),
          pending: project.pending.map((entry) => ({
            threadId: record(entry.params) ? entry.params.threadId : undefined,
            awaitingResponse: entry.awaitingResponse,
          })),
        };
      }),
  };
}
/** @param {InstanceType<typeof import("@areal/workbench-service/desktop/core/service-protocol.cjs").DesktopService>} service @param {{projects:string[]}} device @param {unknown} message */
async function remoteCommand(service, device, message) {
  if (!record(message) || typeof message.method !== "string") throw new Error("手机端不支持此操作");
  if (message.method === "snapshot") return projectSnapshot(service.backend, device);
  const params = message.params;
  if (
    !record(params) ||
    typeof params.projectId !== "string" ||
    !device.projects.includes(params.projectId) ||
    !service.backend.saved.some(
      (/** @type {import("@areal/workbench-service/desktop/core/project-index.cjs").SavedProject} */ project) =>
        project.id === params.projectId,
    )
  )
    throw new Error("此设备未获准访问该项目");
  const common = pick(params, ["projectId", "threadId"]);
  if (
    typeof common.projectId !== "string" ||
    (message.method !== "create" &&
      message.method !== "list" &&
      message.method !== "reconcile" &&
      typeof common.threadId !== "string")
  )
    throw new Error("无效任务标识");
  let name = message.method;
  /** @type {Record<string,unknown>} */
  let request = common;
  switch (name) {
    case "list":
    case "open":
    case "create":
    case "stop":
    case "reconcile":
      break;
    case "send":
    case "steer":
      if (typeof params.text !== "string" || !params.text.trim() || params.text.length > 128000)
        throw new Error("消息必须为 1–128000 字符");
      request = {
        ...common,
        text: params.text,
        ...(name === "steer" ? { expectedTurnId: params.expectedTurnId } : {}),
      };
      break;
    case "respond":
      if (typeof params.requestId !== "string") throw new Error("无效审批标识");
      if (
        params.decision !== undefined &&
        params.decision !== "allowOnce" &&
        params.decision !== "deny"
      )
        throw new Error("手机仅支持本次批准或拒绝");
      if (
        params.answers !== undefined &&
        (!params.answers ||
          typeof params.answers !== "object" ||
          Array.isArray(params.answers) ||
          Object.values(params.answers).some(
            (answer) => typeof answer !== "string" || answer.length > 16000,
          ))
      )
        throw new Error("无效回答");
      request = {
        ...common,
        requestId: params.requestId,
        decision: params.decision,
        answers: params.answers,
      };
      break;
    case "image":
      request = { ...common, operation: "read", uri: params.uri };
      name = "media";
      break;
    case "diff":
      request = { ...common, operation: "turnReview", turnId: params.turnId };
      name = "workspace";
      break;
    default:
      throw new Error("手机端不支持此操作");
  }
  /** @type {unknown} */
  const result = await service.executeRemote(name, request);
  if (!record(result)) throw new Error("远程结果无效");
  if (message.method === "create") return { threadId: result.threadId };
  if (message.method === "image") {
    const raw = result.bytes;
    if (
      !(raw instanceof Uint8Array) &&
      !(
        Array.isArray(raw) &&
        raw.every(
          (value) =>
            typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 255,
        )
      )
    )
      throw new Error("图片结果无效");
    const bytes = Buffer.from(raw);
    // Core's blob endpoint may use application/octet-stream. Recognize only
    // raster signatures; never pass through arbitrary active image content.
    const mime = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      ? "image/png"
      : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
        ? "image/jpeg"
        : /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString("ascii"))
          ? "image/gif"
          : bytes.subarray(0, 4).toString() === "RIFF" &&
              bytes.subarray(8, 12).toString() === "WEBP"
            ? "image/webp"
            : null;
    if (!mime || bytes.length > 16 * 1024 * 1024) throw new Error("图片类型或大小不支持");
    return { mime, bytes: bytes.toString("base64") };
  }
  if (message.method === "diff") {
    if (
      typeof result.diff !== "string" ||
      (result.files != null && (!Array.isArray(result.files) || !result.files.every(record)))
    )
      throw new Error("Diff 结果无效");
    const files = result.files ?? [];
    const patches = result.diff.split(/(?=^diff --git )/m).filter(Boolean);
    return {
      notice: result.notice,
      files: files.map((file, index) => ({
        workspaceRelativePath: file.path,
        patch: patches[index] ?? "",
        binary: file.binary,
        added: file.additions,
        removed: file.deletions,
      })),
    };
  }
  return projectSnapshot(service.backend, device);
}
module.exports = { projectSnapshot, remoteCommand };
