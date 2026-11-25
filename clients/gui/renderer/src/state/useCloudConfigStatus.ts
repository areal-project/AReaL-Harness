import { useEffect, useRef, useState } from "react";
import { currentErrorText } from "../errors/currentErrorText.js";
import type { Action } from "../services.js";

export type CloudConfigStatus = {
  state: "idle" | "loading" | "ready" | "error";
  configured: boolean;
  baseURL: string;
  error?: string;
};

const IDLE_STATUS: CloudConfigStatus = {
  state: "idle",
  configured: false,
  baseURL: "",
};

/**
 * 读取当前来源的 Cloud 后端配置状态（只读，不触发远端连接或沙箱启动）。
 * 在设置页保存后监听 `areal-cloud-config` 事件自动刷新。
 */
export function useCloudConfigStatus(action: Action, enabled: boolean): CloudConfigStatus {
  const request = useRef(action);
  request.current = action;
  const sequence = useRef(0);
  const [status, setStatus] = useState<CloudConfigStatus>(IDLE_STATUS);

  useEffect(() => {
    if (!enabled) {
      sequence.current += 1;
      setStatus(IDLE_STATUS);
      return;
    }
    let active = true;
    const refresh = () => {
      const current = ++sequence.current;
      setStatus((previous) =>
        previous.state === "idle" ? { ...previous, state: "loading" } : previous,
      );
      void request.current("cloud", { operation: "status" }).then(
        (value) => {
          if (!active || sequence.current !== current) return;
          const baseURL = typeof value?.baseURL === "string" ? value.baseURL : "";
          const configured = Boolean(baseURL && value?.tokenConfigured === true);
          setStatus({
            state: "ready",
            configured,
            baseURL,
          });
        },
        (cause) => {
          if (!active || sequence.current !== current) return;
          setStatus({
            state: "error",
            configured: false,
            baseURL: "",
            error: currentErrorText(cause),
          });
        },
      );
    };
    refresh();
    window.addEventListener("areal-cloud-config", refresh);
    return () => {
      active = false;
      window.removeEventListener("areal-cloud-config", refresh);
    };
  }, [enabled]);

  return status;
}
