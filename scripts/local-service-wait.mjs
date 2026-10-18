// 仅用于强杀故障后的收敛检查；普通服务查询仍须直接暴露所有错误。
function isConnectionRefused(message) {
  if (typeof message !== "string") return false;
  if (
    message === "Connection refused (os error 61)" ||
    message === "Connection refused (os error 111)"
  ) {
    return true;
  }
  // 控制 socket 仍可返回 Ready，但 Core 已退出时，probe 会返回此 reqwest 错误链。
  // 只接受真实 probe 的 loopback 地址和固定路径，不匹配任意 URL 或附加错误。
  const wrapped =
    /^error sending request for url \(([^)]+)\): client error \(Connect\): tcp connect error: Connection refused \(os error (?:61|111)\)$/.exec(
      message,
    );
  if (!wrapped || wrapped[0] !== message) return false;
  const endpoint = /^http:\/\/(?:127\.0\.0\.1|\[::1\]):([1-9]\d{0,4})\/areal\/service$/.exec(
    wrapped[1],
  );
  return endpoint !== null && endpoint[0] === wrapped[1] && Number(endpoint[1]) <= 65535;
}

export async function waitForFaultStatus(
  query,
  expectedState,
  { timeoutMs = 20000, onRefused = () => {} } = {},
) {
  const end = Date.now() + timeoutMs;
  let lastRefused;
  while (Date.now() < end) {
    try {
      const service = await query(Math.max(1, end - Date.now()));
      if (service.state === expectedState && Date.now() < end) return service;
    } catch (error) {
      let response;
      try {
        response = JSON.parse(error.stderr);
      } catch {
        throw error;
      }
      // 宿主或 Core 可能先关闭 listener，再等待持锁的 launcher 清理。只接受 CLI
      // 明确报告的这一过渡，不吞协议、权限、超时或其他服务故障。
      if (
        error.code !== 1 ||
        error.killed ||
        error.signal != null ||
        error.stdout?.trim() ||
        response?.error?.code !== "localServiceError" ||
        !isConnectionRefused(response?.error?.message)
      ) {
        throw error;
      }
      lastRefused = error;
      onRefused();
    }
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(50, Math.max(0, end - Date.now()))),
    );
  }
  throw new Error(`service did not reach ${expectedState} within ${timeoutMs} ms`, {
    cause: lastRefused,
  });
}
