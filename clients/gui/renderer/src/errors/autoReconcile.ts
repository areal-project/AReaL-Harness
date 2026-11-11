import { useEffect, useRef } from "react";

// 没收到答复时由界面自己用原编号去查，不让人点“核对”。几次都查不出来就停下，交给调用方收尾。
export const RECONCILE_DELAYS = [400, 1500, 4000, 10000, 20000];

export function scheduleReconcile(
  run: () => unknown,
  giveUp: () => void,
  delays: readonly number[] = RECONCILE_DELAYS,
) {
  let attempt = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const next = () => {
    timer = setTimeout(
      async () => {
        if (stopped) return;
        if (attempt === delays.length) return giveUp();
        attempt += 1;
        try {
          await run();
        } catch {}
        if (!stopped) next();
      },
      delays[attempt] ?? delays[delays.length - 1],
    );
  };
  next();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

export function useAutoReconcile(
  requestId: string | null | undefined,
  enabled: boolean,
  run: () => unknown,
  giveUp: () => void,
) {
  const latest = useRef({ run, giveUp });
  latest.current = { run, giveUp };
  useEffect(() => {
    if (!requestId || !enabled) return;
    return scheduleReconcile(
      () => latest.current.run(),
      () => latest.current.giveUp(),
    );
  }, [requestId, enabled]);
}
