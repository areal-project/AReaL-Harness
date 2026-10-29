// 开发身份只留在当前页面内存；刷新后重新配对，不模拟 Keychain 持久性。
let value: string | null = null;
export const keychain = {
  async load() {
    return { value };
  },
  async save(record: { value: string }) {
    value = record.value;
  },
  async clear() {
    value = null;
  },
  async deviceName() {
    return { name: "Browser development" };
  },
};

export async function scanPairingLink(): Promise<string | null> {
  throw new Error("Use the paste-link path in browser development");
}

export async function observeLifecycle(onState: (active: boolean) => void) {
  const update = () => onState(document.visibilityState === "visible");
  document.addEventListener("visibilitychange", update);
  update();
  return () => document.removeEventListener("visibilitychange", update);
}
