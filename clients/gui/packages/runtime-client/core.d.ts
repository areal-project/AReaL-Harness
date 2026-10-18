export class CoreRpcError extends Error {
  code?: string | number;
  method?: string;
  data?: { reason?: string; requestId?: string; retryable?: boolean; [key: string]: unknown };
  reason?: string;
  requestId?: string;
  submissionUnknown: boolean;
}
export interface CoreSocket {
  readonly readyState: number;
  addEventListener(type: string, listener: (event: any) => void, options?: { once?: boolean }): void;
  send(data: string): void;
  close(): void;
}
export class CoreClient {
  constructor(options: { createSocket: () => CoreSocket; timeoutMs?: number; onServerRequest?: (method: string, params: unknown, context: { requestId: string; signal: AbortSignal }) => Promise<unknown> });
  ready: boolean;
  capabilities: { apiVersion?: string; methods: string[]; [key: string]: unknown };
  connect(): Promise<CoreClient['capabilities']>;
  request<T = unknown>(method: string, params?: object, options?: { onResult?: (result: T) => void; timeoutMs?: number }): Promise<T>;
  onNotification(listener: (method: string, params: any) => void): () => void;
  onClose(listener: () => void): () => void;
  close(): void;
}
