import assert from "node:assert/strict";

// 当前写入格式由正在测试的 Core 宣告；历史迁移夹具仍显式保留旧版本。
export async function assertCurrentStateVersion(record, readStatus) {
  const status = await readStatus();
  assert(Number.isSafeInteger(status?.stateVersion) && status.stateVersion > 0);
  assert.equal(record.version, status.stateVersion);
}
