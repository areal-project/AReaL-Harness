const reported = new WeakSet<object>();

/** 同一次失败只提示一次：全局操作入口提示过的错误，组件不再各自显示。 */
export function markReported(cause: unknown) {
  if (cause && typeof cause === "object") reported.add(cause);
}

export function wasReported(cause: unknown) {
  return !!cause && typeof cause === "object" && reported.has(cause);
}
