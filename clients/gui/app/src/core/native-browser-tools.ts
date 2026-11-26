import {
  validToolInput,
  failure,
  success,
  unconfirmed,
  describeCommands,
  discoveryGuidance,
  interactionGuidance,
} from "@areal/browser-automation/host-tool";
import type { DesktopCallback } from "./native-host-transport";
import type { CorePreview } from "./preview.cjs";
import type { DiscoveryRequest, HostRequest } from "./preview-native/model.js";

type Fields = Record<string, unknown>;
const shortBlobId = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && Buffer.byteLength(v) <= 512;
const record = (value: unknown): value is Fields =>
  !!value && typeof value === "object" && !Array.isArray(value);
const samePage = (a: Fields, b: Fields) =>
  ["pageId", "browserHostId", "hostGeneration", "pageGeneration", "controlEpoch"].every(
    (key) => a[key] === b[key],
  );
type Preview = Pick<
  InstanceType<typeof CorePreview>,
  | "prepareDiscovery"
  | "consumeDiscovery"
  | "ensureAgentPage"
  | "controlPermit"
  | "prepare"
  | "execute"
  | "cancelRead"
  | "page"
  | "pageStillOwned"
  | "workspace"
>;

/** 原生预览拥有页面与批准计划，Host拥有Core租约与媒体；不再维护第二份页面认领表。 */
export class NativeBrowserTools {
  constructor(
    private options: {
      preview(): Preview;
      current(frame: DesktopCallback): boolean;
      call(method: string, params: Fields): Promise<unknown>;
      reveal(projectId: string, threadId: string, pageId: string): void;
    },
  ) {}

  async callback(frame: DesktopCallback, signal: AbortSignal): Promise<unknown> {
    const params = frame.params;
    if (
      !["item/tool/call", "areal/browser/prepare"].includes(frame.method) ||
      !record(params) ||
      params.tool !== "browser_v1" ||
      !validToolInput(params.arguments) ||
      !["threadId", "turnId", "callId", "hostGeneration"].every(
        (key) => typeof params[key] === "string" && !!params[key],
      ) ||
      (params.itemId !== undefined &&
        (typeof params.itemId !== "string" || !params.itemId || params.itemId.length > 128)) ||
      (params.browserApproval !== undefined && !record(params.browserApproval))
    )
      throw new Error("Unsupported native browser callback");
    const input = params.arguments;
    const phase = frame.method === "areal/browser/prepare" ? "prepare" : "execute";
    const mutates = !["describe", "observe", "capture", "diagnostics"].includes(input.operation);
    const current = () => !signal.aborted && this.options.current(frame);
    if (!current())
      return failure("host_unavailable", "Original desktop attachment is unavailable");
    const preview = this.options.preview();
    const identity: DiscoveryRequest = {
      coreInstanceId: frame.coreInstanceId,
      coreGeneration: frame.coreGeneration,
      projectId: frame.guiProjectId,
      threadId: String(params.threadId),
      turnId: String(params.turnId),
      callId: String(params.callId),
      ...(typeof params.itemId === "string" ? { itemId: params.itemId } : {}),
      requestId: String(frame.coreRequestId),
      phase,
      operation: "describe",
      ...(record(params.browserApproval) ? { browserApproval: params.browserApproval } : {}),
    };
    if (input.operation === "describe") {
      try {
        if (phase === "prepare") return preview.prepareDiscovery(identity).plan;
        if (identity.browserApproval?.plan) preview.consumeDiscovery(identity);
        else {
          const page = preview.page(identity.projectId, identity.threadId, undefined);
          if (!page || page.control !== "agent" || !preview.pageStillOwned(page))
            return failure(
              "approval_required",
              "Core approval is required to authorize a browser page",
            );
        }
        const entry = await preview.ensureAgentPage(identity.projectId, identity.threadId);
        if (!current()) return failure("host_unavailable", "Original desktop attachment changed");
        const permit = preview.controlPermit(identity.projectId, identity.threadId, entry.pageId);
        this.options.reveal(identity.projectId, identity.threadId, entry.pageId);
        return success({
          ...entry,
          ...discoveryGuidance,
          ...interactionGuidance,
          command: describeCommands(input.parameters.topic),
          controlPermit: permit,
          pages: preview.workspace
            .workspacePages(identity.projectId, identity.threadId)
            .filter((page) => page.control === "agent" && preview.pageStillOwned(page))
            .map((page) => page.id),
        });
      } catch (error) {
        const code =
          error instanceof Error && /plan_stale/.test(error.message)
            ? "plan_stale"
            : "host_unavailable";
        return phase === "prepare"
          ? { error: code, dispatch: "not_sent" }
          : failure(code, "Browser entry authorization changed");
      }
    }
    if (
      phase === "execute" &&
      (!record(identity.browserApproval?.plan) ||
        typeof identity.browserApproval.plan.preparedActionId !== "string")
    )
      return failure("approval_required", "Core approval metadata is required");
    if (!preview.page(identity.projectId, identity.threadId, input.parameters.pageId))
      return phase === "prepare"
        ? { error: "wrong_page", dispatch: "not_sent" }
        : failure("wrong_page", "Page does not belong to this thread");
    let permit: ReturnType<Preview["controlPermit"]>;
    try {
      permit = preview.controlPermit(
        identity.projectId,
        identity.threadId,
        input.parameters.pageId,
      );
    } catch {
      return phase === "prepare"
        ? { error: "human_control", dispatch: "not_sent" }
        : failure("human_control", "Human controls this page");
    }
    const imagePage =
      input.operation === "command" && "tabId" in input.parameters.command
        ? (input.parameters.command.tabId ?? permit.pageId)
        : permit.pageId;
    let imagePermit: typeof permit;
    try {
      imagePermit = preview.controlPermit(identity.projectId, identity.threadId, imagePage);
    } catch {
      return failure("human_control", "The command target is not authorized");
    }
    const request = {
      ...identity,
      ...input,
      ...permit,
      workspacePath: frame.workspacePath,
    } as HostRequest;
    const cancel = () =>
      preview.cancelRead({
        requestId: request.requestId,
        projectId: request.projectId,
        threadId: request.threadId,
        hostGeneration: request.hostGeneration,
      });
    signal.addEventListener("abort", cancel, { once: true });
    let dispatched = false;
    const pageCurrent = () => {
      if (!current()) return false;
      try {
        return samePage(
          permit,
          preview.controlPermit(request.projectId, request.threadId, permit.pageId),
        );
      } catch {
        return false;
      }
    };
    try {
      if (!pageCurrent()) return failure("human_control", "Browser authorization changed");
      dispatched = phase === "execute";
      const result: unknown = await (phase === "prepare"
        ? preview.prepare(request)
        : preview.execute(request));
      if (!record(result)) throw new Error("Invalid native browser result");
      const maximum =
        input.operation === "command"
          ? 16 * 1024 * 1024
          : input.operation === "capture"
            ? 3 * 1024 * 1024
            : 512 * 1024;
      // prepare 只返回 plan。封套若再次回显同一个 ID，仅计一次；真实计划和其余数据仍受原限额。
      const measured =
        phase === "prepare" &&
        identity.itemId &&
        record(result.plan) &&
        result.callId === identity.callId &&
        result.plan.callId === identity.callId
          ? { ...result, callId: identity.itemId }
          : result;
      if (Buffer.byteLength(JSON.stringify(measured)) > maximum)
        throw new Error("Native browser result exceeds its budget");
      if (
        !current() ||
        (!pageCurrent() &&
          !(
            input.operation === "command" &&
            [result.closedPageIds, result.revokedPageIds].some(
              (ids) => Array.isArray(ids) && ids.includes(permit.pageId),
            )
          ))
      )
        return phase === "prepare"
          ? { error: "plan_stale", dispatch: "not_sent" }
          : mutates
            ? unconfirmed(input.operation, "control_changed", result)
            : failure("human_control", "Browser authorization changed");
      if (typeof result.error === "string") {
        if (phase === "prepare") return { error: result.error, dispatch: "not_sent" };
        if (
          result.error === "outcome_unknown" ||
          result.dispatch === "unknown" ||
          result.dispatch === "possibly_sent"
        )
          return unconfirmed(input.operation, result.reason, result);
        return {
          ...failure(result.error, "Browser operation failed"),
          structuredContent: {
            ...result,
            code: result.error,
            dispatch: result.dispatch ?? "not_sent",
          },
        };
      }
      if (phase === "prepare") {
        if (
          !record(result.plan) ||
          result.plan.pageId !== permit.pageId ||
          result.plan.operation !== input.operation
        )
          throw new Error("Invalid native browser approval plan");
        return result.plan;
      }
      if (pageCurrent())
        result.controlPermit = preview.controlPermit(
          request.projectId,
          request.threadId,
          permit.pageId,
        );
      if (record(result.createdPage) && typeof result.createdPage.pageId === "string") {
        result.controlPermits = [
          result.controlPermit,
          preview.controlPermit(request.projectId, request.threadId, result.createdPage.pageId),
        ].filter(Boolean);
      }
      if (input.operation === "capture") {
        if (
          result.mimeType !== "image/png" ||
          typeof result.imageBase64 !== "string" ||
          result.imageBase64.length > 2_800_000
        )
          throw new Error("Invalid native browser capture");
        const media = await this.upload(
          frame,
          params,
          "image/png",
          result.imageBase64,
          pageCurrent,
        );
        const { imageBase64: _, ...metadata } = result;
        // 原始调用 ID 已在账本和模型工具配对中。只收窄可信截图元信息中的重复字段，
        // 不动页面数据、其他业务字段或 Core 对混合媒体结果的 16 KiB 上限。
        if (
          typeof params.itemId === "string" &&
          !shortBlobId(params.callId) &&
          metadata.callId === params.callId
        ) {
          delete metadata.callId;
          metadata.itemId = params.itemId;
        }
        return {
          success: true,
          contentItems: [
            { type: "inputText", text: JSON.stringify({ ...metadata, media }) },
            { type: "arealMedia", modality: "image", media },
          ],
        };
      }
      if (input.operation === "command") {
        const value = result.commandResult;
        if (!record(value) || typeof value.ok !== "boolean")
          throw new Error("Invalid native browser command result");
        if (record(value.error) && value.error.sideEffect === "uncertain")
          return {
            ...unconfirmed("command", "action_unconfirmed"),
            structuredContent: { code: "outcome_unknown", dispatch: "unknown", result: value },
          };
        const { image, ...metadata } = value;
        if (result.controlPermit) metadata.controlPermit = result.controlPermit;
        if (result.controlPermits) metadata.controlPermits = result.controlPermits;
        const contentItems: Fields[] = [{ type: "inputText", text: JSON.stringify(metadata) }];
        if (image !== undefined) {
          if (
            !record(image) ||
            typeof image.mimeType !== "string" ||
            typeof image.base64 !== "string"
          )
            throw new Error("Invalid native browser command image");
          const imageCurrent = () => {
            if (!current()) return false;
            try {
              return samePage(
                imagePermit,
                preview.controlPermit(request.projectId, request.threadId, imagePage),
              );
            } catch {
              return false;
            }
          };
          metadata.imageSource = {
            pageId: imagePermit.pageId,
            pageGeneration: imagePermit.pageGeneration,
            controlEpoch: imagePermit.controlEpoch,
          };
          const media = await this.upload(
            frame,
            params,
            image.mimeType,
            image.base64,
            imageCurrent,
          );
          contentItems.push({ type: "arealMedia", modality: "image", media });
        }
        return { success: value.ok, contentItems, structuredContent: metadata };
      }
      if (input.operation === "openDocument" && result.dispatch === "confirmed")
        this.options.reveal(request.projectId, request.threadId, permit.pageId);
      return { ...success(result), ...(mutates ? { structuredContent: result } : {}) };
    } catch (error) {
      // 原生执行器在派发后统一抛outcome_unknown；这些明确错误证明尚未输入。
      const known: Record<string, string> = {
        plan_stale: "Page or target changed; observe again before a new action",
        stale_ref: "Target changed; observe again",
        not_sent: "Target unavailable before input; observe again",
        target_unavailable: "Target unavailable before input; observe again",
        human_control: "Human controls this page",
        human_takeover_required: "Use human takeover for this page",
        condition_timeout: "The requested page condition was not observed before timeout",
      };
      const message = error instanceof Error ? error.message : "";
      const code = message === "target_unavailable" ? "not_sent" : message;
      if (known[message])
        return phase === "prepare"
          ? { error: code, dispatch: "not_sent" }
          : failure(code, known[message]);
      if (dispatched && mutates) {
        const reason =
          record(error) &&
          ["navigation_timeout", "navigation_interrupted"].includes(String(error.reason))
            ? error.reason
            : "action_unconfirmed";
        return unconfirmed(input.operation, reason);
      }
      return phase === "prepare"
        ? { error: "plan_stale", dispatch: "not_sent" }
        : failure("evidence_unavailable", "Browser observation is unavailable");
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  }

  private async upload(
    frame: DesktopCallback,
    params: Fields,
    mime: string,
    base64: string,
    current: () => boolean,
  ) {
    if (
      !["image/png", "image/jpeg"].includes(mime) ||
      base64.length > 12 * 1024 * 1024 ||
      !current()
    )
      throw new Error("Invalid native browser image owner");
    const bytes = Buffer.from(base64, "base64");
    if (!bytes.length || bytes.length > 8 * 1024 * 1024 || bytes.toString("base64") !== base64)
      throw new Error("Invalid native browser image encoding");
    const owner =
      params.itemId !== undefined && shortBlobId(params.itemId) && shortBlobId(params.turnId)
        ? { turnId: params.turnId, itemId: params.itemId }
        : params.itemId === undefined && shortBlobId(params.callId)
          ? { callId: params.callId }
          : null;
    if (!owner) throw new Error("Invalid native browser image owner");
    const result = await this.options.call("core.blob", {
      sourceId: frame.sourceId,
      projectId: frame.projectId,
      lease: frame.lease,
      operation: "upload",
      threadId: params.threadId,
      ...owner,
      hostGeneration: params.hostGeneration,
      mime,
      base64,
    });
    if (!current()) throw new Error("Native browser image owner changed");
    return result;
  }
}
