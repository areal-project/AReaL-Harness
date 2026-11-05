// @ts-check
"use strict";
const { record } = require("./remote-core-decoder.cjs");
/** @typedef {import('./remote-session-observer.cjs').RemoteConnection} Connection */
/** @typedef {import('./remote-session-observer.cjs').ObserverEntry} Entry */
/** @typedef {import('./remote-core-decoder.cjs').Thread} Thread */
/** @typedef {import('./remote-core-decoder.cjs').Turn} Turn */
/** @typedef {{threadId:string,turnId:string,itemId?:string,cursor?:unknown,limit?:number}} ReviewParams */
/** @typedef {{kind:'review',scope:string,offset:number}} ReviewToken */
/** @typedef {{kind:'artifact',identity:string,threadId:string,turnId:string,itemId:string,index:number,uri:string,mime:string,size:number}} ArtifactToken */
const { randomBytes, createCipheriv, createDecipheriv, createHash } = require("node:crypto");
const { reviewTurnFiles } = require("@areal/workspace-git");
const LIMITS = Object.freeze({
  reviewPageBytes: 16 * 1024,
  reviewBodyBytes: 4 * 1024 * 1024,
  artifactBytes: 16 * 1024 * 1024,
  artifactChunkBytes: 48 * 1024,
});
/** @param {string} [code] */
const failure = (code = "RESOURCE_UNAVAILABLE") =>
  Object.assign(new Error("原结果不可用，请在桌面查看"), { code });
/** @param {unknown} value @returns {value is string} */
const id = (value) =>
  typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= 128;
/** @param {unknown} value @param {string[]} keys @returns {value is Record<string,unknown>} */
const exact = (value, keys) =>
  !!value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).every((k) => keys.includes(k));
/** @param {unknown} params @returns {asserts params is ReviewParams} */
function target(params) {
  if (
    !exact(params, ["threadId", "turnId", "itemId", "cursor", "limit"]) ||
    !id(params.threadId) ||
    !id(params.turnId) ||
    (params.itemId !== undefined && !id(params.itemId)) ||
    (params.limit !== undefined &&
      (typeof params.limit !== "number" ||
        !Number.isSafeInteger(params.limit) ||
        params.limit < 1 ||
        params.limit > LIMITS.reviewPageBytes))
  )
    throw failure("INVALID_PARAMS");
}
/** @param {Turn} turn @param {string} [itemId] */
function mediaRecords(turn, itemId) {
  const records = [];
  for (const item of turn.items ?? []) {
    if (itemId !== undefined && item.id !== itemId) continue;
    const values =
      item.type === "agentMedia"
        ? [item.media]
        : item.type === "dynamicToolCall"
          ? (item.contentItems ?? []).filter((c) => c.type === "arealMedia").map((c) => c.media)
          : [];
    for (const [index, media] of values.entries()) {
      if (
        !id(item.id) ||
        !media ||
        !/^areal:\/\/blob\/[a-f0-9]{64}$/.test(media.uri) ||
        !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(media.mimeType) ||
        !Number.isSafeInteger(media.sizeBytes) ||
        media.sizeBytes < 1 ||
        media.sizeBytes > LIMITS.artifactBytes
      )
        continue;
      records.push({
        itemId: item.id,
        index,
        uri: media.uri,
        mime: media.mimeType,
        size: media.sizeBytes,
      });
    }
  }
  return records;
}
/** @param {Thread} thread @param {Pick<ReviewParams,"turnId"|"itemId">} params */
function original(thread, params) {
  const turns = thread.turns?.filter((t) => t.id === params.turnId) ?? [];
  if (turns.length !== 1) throw failure();
  const turn = turns[0];
  if (params.itemId !== undefined && turn.items?.filter((i) => i.id === params.itemId).length !== 1)
    throw failure();
  return turn;
}
class ResultReviews {
  /** @param {InstanceType<typeof import("./remote-session-observer.cjs").SessionObservers>} observers */
  constructor(observers) {
    this.observers = observers;
    this.key = randomBytes(32);
    /** @type {WeakMap<object,string>} */
    this.identities = new WeakMap();
  }
  /** @param {Connection} connection @param {string} projectId */
  authorize(connection, projectId) {
    const project = this.observers.authorize(connection, projectId);
    const grant = this.observers.remote.config.deviceGrants?.find(
      (g) => g.devicePeerId === connection.peer && g.status === "active",
    );
    if (!grant?.capabilities.includes("review")) throw failure("FORBIDDEN");
    return project;
  }
  /** @param {Connection} connection @param {Entry} entry */
  identity(connection, entry) {
    if (!this.identities.has(entry.desktop))
      this.identities.set(entry.desktop, randomBytes(16).toString("hex"));
    return createHash("sha256")
      .update(
        JSON.stringify([
          connection.peer,
          connection.connectionId,
          connection.grantRevision,
          entry.gatewayGeneration,
          entry.projectId,
          entry.serviceId,
          entry.generation,
          entry.endpoint,
          entry.token,
          this.identities.get(entry.desktop),
        ]),
      )
      .digest("hex");
  }
  /** @param {ReviewToken|ArtifactToken} value */
  seal(value) {
    const nonce = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    const body = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), body]).toString("base64url");
  }
  /** @param {unknown} token @returns {ReviewToken|ArtifactToken} */
  open(token) {
    try {
      if (typeof token !== "string" || token.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(token))
        throw failure();
      const bytes = Buffer.from(token, "base64url"),
        cipher = createDecipheriv("aes-256-gcm", this.key, bytes.subarray(0, 12));
      cipher.setAuthTag(bytes.subarray(12, 28));
      /** @type {unknown} */
      const value = JSON.parse(
        Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString(),
      );
      if (!isToken(value)) throw failure();
      return value;
    } catch {
      throw failure();
    }
  }
  /** @template T @param {Connection} connection @param {string} projectId @param {unknown} params @param {(value:unknown)=>T} publish */
  async artifact(connection, projectId, params, publish) {
    if (
      !exact(params, ["artifactRef", "offset", "length"]) ||
      typeof params.offset !== "number" ||
      !Number.isSafeInteger(params.offset) ||
      params.offset < 0 ||
      typeof params.length !== "number" ||
      !Number.isSafeInteger(params.length) ||
      params.length < 1 ||
      params.length > LIMITS.artifactChunkBytes
    )
      throw failure("INVALID_PARAMS");
    const request = {
      artifactRef: params.artifactRef,
      offset: params.offset,
      length: params.length,
    };
    this.authorize(connection, projectId);
    const ref = this.open(request.artifactRef);
    if (ref.kind !== "artifact" || params.offset >= ref.size) throw failure();
    const { rasterInfo } = await import("@areal/remote/raster");
    this.authorize(connection, projectId);
    return this.observers.reviewThread(
      connection,
      projectId,
      ref.threadId,
      async (thread, entry, check, read) => {
        const guard = () => {
          check();
          this.authorize(connection, projectId);
          if (ref.identity !== this.identity(connection, entry)) throw failure("RESYNC_REQUIRED");
        };
        /** @param {Thread} thread */
        const membership = (thread) => {
          guard();
          const turn = original(thread, ref);
          if (
            !mediaRecords(turn, ref.itemId).some(
              (m) =>
                m.itemId === ref.itemId &&
                m.index === ref.index &&
                m.uri === ref.uri &&
                m.mime === ref.mime &&
                m.size === ref.size,
            )
          )
            throw failure();
        };
        membership(thread);
        const url = new URL(entry.endpoint);
        url.protocol = url.protocol === "wss:" ? "https:" : "http:";
        url.pathname = `/areal/blobs/${ref.uri.split("/").at(-1)}`;
        url.search = "";
        url.hash = "";
        url.searchParams.set("threadId", ref.threadId);
        const controller = new AbortController();
        /** @type {ReadableStreamDefaultReader<Uint8Array>|undefined} */
        let reader;
        let timedOut = false;
        const timeout = setTimeout(() => {
          timedOut = true;
          controller.abort();
          void reader?.cancel().catch(() => {});
        }, 30000);
        const timer = setInterval(() => {
          try {
            guard();
          } catch {
            controller.abort();
            void reader?.cancel().catch(() => {});
          }
        }, 100);
        timeout.unref?.();
        timer.unref?.();
        try {
          const response = await fetch(url, {
            headers: { Authorization: `Bearer ${entry.token}` },
            redirect: "error",
            signal: controller.signal,
            cache: "no-store",
          });
          reader = response.body?.getReader();
          guard();
          if (!response.ok || !reader) throw failure();
          const length = response.headers.get("content-length");
          if (length !== null && (!/^\d+$/.test(length) || Number(length) !== ref.size))
            throw failure();
          const bytes = Buffer.alloc(ref.size);
          let total = 0;
          for (;;) {
            const chunk = await reader.read();
            guard();
            if (timedOut || controller.signal.aborted) throw failure();
            if (chunk.done) break;
            if (
              !(chunk.value instanceof Uint8Array) ||
              total + chunk.value.length > ref.size ||
              total + chunk.value.length > LIMITS.artifactBytes
            )
              throw failure();
            bytes.set(chunk.value, total);
            total += chunk.value.length;
          }
          if (
            total !== ref.size ||
            createHash("sha256").update(bytes).digest("hex") !== ref.uri.split("/").at(-1)
          )
            throw failure();
          const raster = rasterInfo(bytes, ref.mime);
          membership(await read());
          guard();
          const end = Math.min(ref.size, request.offset + request.length);
          return publish({
            projectId,
            threadId: ref.threadId,
            turnId: ref.turnId,
            itemId: ref.itemId,
            connectionId: connection.connectionId,
            gatewayGeneration: entry.gatewayGeneration,
            serviceGeneration: entry.generation,
            artifactRef: request.artifactRef,
            offset: request.offset,
            totalBytes: ref.size,
            nextOffset: end < ref.size ? end : null,
            base64: bytes.subarray(request.offset, end).toString("base64"),
            raster,
          });
        } catch (error) {
          if (
            record(error) &&
            typeof error.code === "string" &&
            ["FORBIDDEN", "GRANT_CHANGED", "RESYNC_REQUIRED"].includes(error.code)
          )
            throw error;
          throw failure();
        } finally {
          clearTimeout(timeout);
          clearInterval(timer);
          controller.abort();
          await reader?.cancel().catch(() => {});
        }
      },
    );
  }
  /** @template T @param {Connection} connection @param {string} projectId @param {unknown} params @param {(value:unknown)=>T} publish */
  async read(connection, projectId, params, publish) {
    target(params);
    this.authorize(connection, projectId);
    return this.observers.reviewThread(
      connection,
      projectId,
      params.threadId,
      (thread, entry, check) => {
        this.authorize(connection, projectId);
        const turn = original(thread, params);
        let diff;
        try {
          /** @type {unknown} */
          const rawReview = reviewTurnFiles(entry.project.root, turn, { itemId: params.itemId });
          if (
            !record(rawReview) ||
            !Array.isArray(rawReview.files) ||
            !rawReview.files.every(record)
          )
            throw failure();
          const review = {
            files: rawReview.files,
            scope: rawReview.scope,
            base: rawReview.base,
            head: rawReview.head,
            notice: rawReview.notice,
          };
          // 二进制历史不进入文本审查；仅检查原生记录重建的版本，不读取当前工作区。
          if (
            review.files.some(
              ({ beforeText, afterText }) =>
                typeof beforeText !== "string" ||
                typeof afterText !== "string" ||
                beforeText.includes("\0") ||
                afterText.includes("\0"),
            )
          )
            throw failure();
          diff = {
            state: "available",
            scope: review.scope,
            base: review.base,
            head: review.head,
            notice: review.notice,
            provenance: "verified-runtime-file-writes",
            files: review.files.map(({ path, hunks, additions, deletions }) => ({
              path,
              hunks,
              additions,
              deletions,
            })),
          };
          if (!diff.files.length)
            diff = {
              state: "unavailable",
              notice:
                "没有可重建的 Runtime 文本写入；Shell、重命名、删除、二进制及缺少写前版本的变更不可用。",
            };
        } catch {
          diff = {
            state: "unavailable",
            notice: "此 Turn/Item 无法重建完整历史版本；不会使用当前工作区替代。",
          };
        }
        const content = {
          threadId: thread.id,
          turnId: turn.id,
          itemId: params.itemId ?? null,
          turnStatus: turn.status ?? "unknown",
          error: turn.error ?? null,
          partial: turn.status !== "completed",
          taskRunStatus: null,
          notice:
            "原 Turn 输出；文本可读不代表成功。Task Run 状态需单独查看 Task，不能由此 Turn 推断。",
          result: (turn.items ?? [])
            .filter((i) => params.itemId === undefined || i.id === params.itemId)
            .filter((i) => i.type === "agentMessage" || i.type === "dynamicToolCall")
            .map((i) => ({
              itemId: i.id,
              type: i.type,
              phase: i.phase ?? null,
              status: i.status ?? null,
              success: i.success ?? null,
              executionOutcome: i.execution?.outcome ?? null,
              text:
                i.type === "agentMessage"
                  ? String(i.text ?? "")
                  : (i.contentItems ?? [])
                      .filter((c) => ["inputText", "text"].includes(c.type))
                      .map((c) => c.text ?? "")
                      .join("\n"),
            })),
          diff,
          artifactNotice:
            "最多列出 16 个具有原 Turn/Item 原生归属且不超过 16 MiB 的 PNG/JPEG/GIF/WebP；超出列表、动画或其他制品请在桌面查看。",
        };
        const body = Buffer.from(JSON.stringify(content));
        if (body.length > LIMITS.reviewBodyBytes) throw failure();
        const scope = createHash("sha256")
          .update(this.identity(connection, entry))
          .update(body)
          .digest("hex");
        /** @type {ReviewToken|ArtifactToken} */
        const cursor =
          params.cursor === undefined
            ? { kind: "review", scope, offset: 0 }
            : this.open(params.cursor);
        if (
          cursor.kind !== "review" ||
          cursor.scope !== scope ||
          !Number.isSafeInteger(cursor.offset) ||
          cursor.offset < 0 ||
          cursor.offset >= body.length
        )
          throw failure("TARGET_CHANGED");
        let end = Math.min(body.length, cursor.offset + (params.limit ?? LIMITS.reviewPageBytes));
        while (end < body.length && (body[end] & 0xc0) === 0x80) end--;
        if (end === cursor.offset) throw failure("INVALID_PARAMS");
        check();
        this.authorize(connection, projectId);
        const artifacts =
          cursor.offset === 0
            ? mediaRecords(turn, params.itemId)
                .slice(0, 16)
                .map((record) => ({
                  itemId: record.itemId,
                  mime: record.mime,
                  size: record.size,
                  artifactRef: this.seal({
                    kind: "artifact",
                    identity: this.identity(connection, entry),
                    threadId: thread.id,
                    turnId: turn.id,
                    ...record,
                  }),
                }))
            : [];
        return publish({
          artifacts,
          projectId,
          threadId: thread.id,
          turnId: turn.id,
          itemId: params.itemId ?? null,
          connectionId: connection.connectionId,
          gatewayGeneration: entry.gatewayGeneration,
          serviceGeneration: entry.generation,
          review: {
            encoding: "json-utf8",
            offset: cursor.offset,
            totalBytes: body.length,
            chunk: body.subarray(cursor.offset, end).toString("utf8"),
          },
          nextCursor: end < body.length ? this.seal({ kind: "review", scope, offset: end }) : null,
        });
      },
    );
  }
}
/** @param {unknown} value @returns {value is ReviewToken|ArtifactToken} */
function isToken(value) {
  if (!record(value)) return false;
  if (value.kind === "review")
    return (
      typeof value.scope === "string" &&
      typeof value.offset === "number" &&
      Number.isSafeInteger(value.offset) &&
      value.offset >= 0
    );
  return (
    value.kind === "artifact" &&
    typeof value.identity === "string" &&
    id(value.threadId) &&
    id(value.turnId) &&
    id(value.itemId) &&
    typeof value.index === "number" &&
    Number.isSafeInteger(value.index) &&
    value.index >= 0 &&
    typeof value.uri === "string" &&
    /^areal:\/\/blob\/[a-f0-9]{64}$/.test(value.uri) &&
    typeof value.mime === "string" &&
    ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(value.mime) &&
    typeof value.size === "number" &&
    Number.isSafeInteger(value.size) &&
    value.size > 0 &&
    value.size <= LIMITS.artifactBytes
  );
}
module.exports = { ResultReviews, LIMITS };
