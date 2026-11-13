import { record } from "./bootstrap.js";
import { identity, type MediaSource, type SessionRead } from "./read-state.js";

const OWNER_FIELDS = [
  "connectionId",
  "gatewayGeneration",
  "subscriptionId",
  "projectId",
  "serviceGeneration",
  "threadId",
] as const;

/** 校验一块 artifact.read 结果属于当前订阅、当前媒体且与前面的块一致，返回解码后的字节。 */
export function mediaChunk(
  value: unknown,
  owner: SessionRead,
  source: MediaSource,
  offset: number,
  totalBytes: number | undefined,
  mime: string | undefined,
) {
  if (
    !identity(value) ||
    OWNER_FIELDS.some((key) => value[key] !== owner[key]) ||
    value.view !== "conversation" ||
    value.sequence < owner.sequence ||
    value.sourceThreadId !== (source.sourceThreadId ?? owner.threadId) ||
    value.turnId !== source.turnId ||
    value.itemId !== source.itemId ||
    value.uri !== source.uri ||
    value.offset !== offset ||
    !Number.isSafeInteger(value.totalBytes) ||
    Number(value.totalBytes) < 0 ||
    Number(value.totalBytes) > 16 * 1024 * 1024 ||
    typeof value.mimeType !== "string" ||
    !value.mimeType ||
    value.mimeType.length > 256 ||
    /[\r\n\0]/.test(value.mimeType) ||
    (value.raster !== undefined &&
      (!record(value.raster) ||
        value.raster.mime !== value.mimeType ||
        !Number.isSafeInteger(value.raster.width) ||
        Number(value.raster.width) <= 0 ||
        !Number.isSafeInteger(value.raster.height) ||
        Number(value.raster.height) <= 0)) ||
    typeof value.base64 !== "string" ||
    value.base64.length > 87384 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.base64)
  )
    throw new Error("Invalid conversation media chunk");
  if (totalBytes !== undefined && (value.totalBytes !== totalBytes || value.mimeType !== mime))
    throw new Error("Media identity changed");
  const total = Number(value.totalBytes);
  const bytes = Uint8Array.from(atob(value.base64), (char) => char.charCodeAt(0));
  if (
    (!bytes.length && total !== 0) ||
    bytes.length > 65536 ||
    offset + bytes.length > total ||
    value.nextOffset !== (offset + bytes.length === total ? null : offset + bytes.length)
  )
    throw new Error("Invalid conversation media range");
  return { totalBytes: total, mime: String(value.mimeType), bytes };
}

export function joinChunks(parts: readonly Uint8Array[], totalBytes: number) {
  const bytes = new Uint8Array(totalBytes);
  let position = 0;
  for (const part of parts) {
    bytes.set(part, position);
    position += part.length;
  }
  return bytes;
}
