import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

// 显示投影可以省略成功工具的原文；验收事实必须显式读取同一 Turn 的详情。
// 只展开该 Turn 的工具占位项，沿用 Desktop 的预算、版本及归属校验。
export async function readTurnToolDetails({ command, readThread, projectId, threadId, turnId }) {
  const originalThread = await readThread();
  assert.equal(originalThread?.id, threadId, "the tool read must retain its original Thread");
  const original = originalThread.turns.find((item) => item.id === turnId);
  assert.ok(original, "the original Turn must exist before the detail read");
  const isToolDetail = (item) =>
    item.type === "historyDeferred" && item.originalType === "dynamicToolCall";
  // 完整历史的旧 Core 与已加载投影无需额外读取；不改变负面场景的终态。
  if (!original.items.some(isToolDetail)) return original;
  const history = { projectId, threadId, viewId: randomUUID() };
  let failure;
  let current;
  try {
    const acquired = await command("history", { ...history, operation: "acquire" });
    assert.equal(acquired.supported, true, "bounded history must support the tool detail read");
    const observedThread = await readThread();
    assert.equal(observedThread?.id, threadId, "history acquisition retains its original Thread");
    const turn = observedThread.turns.find((item) => item.id === turnId);
    assert.ok(turn, "the original Turn remains present after history acquisition");
    const deferred = turn.items.filter(isToolDetail);
    for (const item of deferred) {
      const loaded = await command("history", {
        ...history,
        operation: "loadItem",
        itemId: item.id,
      });
      assert.equal(loaded.loaded, true, "the requested tool detail was loaded");
      assert.equal(loaded.itemId, item.id, "the tool detail retains its original identity");
    }
    // IPC 返回的是副本，加载后必须重新读取；不能继续使用旧的 turn.items。
    const currentThread = await readThread();
    assert.equal(currentThread?.id, threadId, "detail loading retains its original Thread");
    current = currentThread.turns.find((item) => item.id === turnId);
    assert.ok(current, "the original Turn remains present after detail loading");
    for (const item of deferred)
      assert.equal(
        current.items.find((value) => value.id === item.id)?.type,
        "dynamicToolCall",
        "the original tool record must be complete after loading",
      );
  } catch (error) {
    failure = { error };
  }
  try {
    const released = await command("history", { ...history, operation: "release" });
    assert.equal(released.released, true, "the temporary history view was released");
  } catch (error) {
    if (failure)
      throw new AggregateError([failure.error, error], "tool detail read and release failed");
    throw error;
  }
  if (failure) throw failure.error;
  return current;
}
