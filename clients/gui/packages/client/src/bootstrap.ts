import type { LocalWebTicketResult } from "./protocol.js";
export type HostBootstrap = LocalWebTicketResult;

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function readHostBootstrap(value: unknown): HostBootstrap {
  if (
    !record(value) ||
    value.version !== 1 ||
    typeof value.hostId !== "string" ||
    !value.hostId ||
    typeof value.generation !== "string" ||
    !value.generation ||
    typeof value.origin !== "string" ||
    typeof value.websocketUrl !== "string" ||
    typeof value.ticket !== "string" ||
    !value.ticket ||
    value.ticket.length > 1024 ||
    (value.preferredSourceId !== undefined &&
      (typeof value.preferredSourceId !== "string" || !value.preferredSourceId)) ||
    typeof value.expiresAt !== "number" ||
    !Number.isSafeInteger(value.expiresAt) ||
    value.expiresAt <= Date.now()
  )
    throw new Error("Invalid Host bootstrap");
  const endpoint = new URL(value.websocketUrl);
  if (
    endpoint.protocol !== "ws:" ||
    endpoint.hostname !== "127.0.0.1" ||
    !endpoint.port ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    (value.origin !== "areal-ui://app" && value.origin !== `http://${endpoint.host}`)
  )
    throw new Error("Invalid Host endpoint");
  return value as unknown as HostBootstrap;
}
