export { CoreRpcError } from "./core.js";
export const MAX_RESPONSE_BYTES: number;
export type RequestIdentity = {
  method: string;
  effect?: string;
  requestId?: string;
  target: object;
};
export function requestIdentity(
  method: string,
  params: object,
  capabilities?: import("./core.js").CoreClient["capabilities"],
): RequestIdentity;
export function requestFailure(
  message: string,
  request: RequestIdentity,
  code: string | number | undefined,
  options?: {
    cause?: unknown;
    data?: Record<string, unknown>;
    received?: boolean;
    unsent?: boolean;
  },
): import("./core.js").CoreRpcError;
export namespace requestFailure {
  function unsent(
    message: string,
    request: RequestIdentity,
    code: string,
  ): import("./core.js").CoreRpcError;
}
export function responseTooLarge(): import("./core.js").CoreRpcError;
