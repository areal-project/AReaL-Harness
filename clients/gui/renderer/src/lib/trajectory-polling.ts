export type TrajectoryOperation = "status" | "retry" | "enable" | "disable";

type Clock = {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
};
type Listener<T> = {
  intervalMs: number;
  onResult(value: T, operation: TrajectoryOperation): void;
  onError(error: unknown, operation: TrajectoryOperation): void;
  onBusy?(operation: TrajectoryOperation | null): void;
};

const browserClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

// 页面和 App 共用一个请求；慢读取、重试与重新连接都不能产生并发 CLI 子进程。
export function createTrajectoryPoller<T>(
  request: (operation: TrajectoryOperation) => Promise<T>,
  clock: Clock = browserClock,
) {
  const listeners = new Set<Listener<T> & { nextAt: number }>();
  let timer: unknown;
  let running: TrajectoryOperation | null = null;
  const clearTimer = () => {
    if (timer !== undefined) clock.clearTimeout(timer);
    timer = undefined;
  };
  const schedule = () => {
    clearTimer();
    if (running || !listeners.size) return;
    const nextAt = Math.min(...Array.from(listeners, (listener) => listener.nextAt));
    timer = clock.setTimeout(
      () => {
        timer = undefined;
        void execute("status");
      },
      Math.max(0, nextAt - clock.now()),
    );
  };
  const execute = async (operation: TrajectoryOperation) => {
    if (running || !listeners.size) return;
    clearTimer();
    running = operation;
    const captured = [...listeners];
    for (const listener of captured) listener.onBusy?.(operation);
    try {
      const value = await request(operation);
      for (const listener of captured) {
        if (listeners.has(listener)) listener.onResult(value, operation);
      }
    } catch (error) {
      for (const listener of captured) {
        if (listeners.has(listener)) listener.onError(error, operation);
      }
    } finally {
      running = null;
      for (const listener of captured) {
        if (listeners.has(listener)) listener.nextAt = clock.now() + listener.intervalMs;
      }
      // 新页面或新连接不接收旧请求结果，但等旧请求结束后才启动新的读取。
      for (const listener of listeners) listener.onBusy?.(null);
      schedule();
    }
  };
  return {
    watch(options: Listener<T>) {
      const listener = { ...options, nextAt: clock.now() };
      listeners.add(listener);
      listener.onBusy?.(running);
      schedule();
      return {
        stop() {
          listeners.delete(listener);
          schedule();
        },
        refresh(operation: TrajectoryOperation = "status") {
          if (!listeners.has(listener) || running) return false;
          void execute(operation);
          return true;
        },
      };
    },
  };
}
