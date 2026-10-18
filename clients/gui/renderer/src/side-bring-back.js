// 回填只操作来源主会话的本地草稿；Side 不选择主会话的发送路径。
const draftKey = owner => `areal-gui:draft:${owner.projectId}:${owner.sourceThreadId}`;
const sameOwner = (left, right) => left.instanceId === right.instanceId && left.projectId === right.projectId &&
  left.sourceThreadId === right.sourceThreadId && left.sideThreadId === right.sideThreadId && left.paneOwner === right.paneOwner;

export function sideSourceAdvanced(source, side) {
  // Core 时间为 Unix 秒；轮次锚点补足同秒内继续执行的判断。
  if (Number.isFinite(source.updatedAt) && Number.isFinite(side.createdAt) && source.updatedAt > side.createdAt) return true;
  const origin = side.conversation?.origin;
  const turns = source.turns ?? [];
  if (!turns.length) return false;
  if (!origin?.sourceTurnId) return side.conversation?.referenceSnapshot?.turnCount === 0;
  return turns.at(-1).id !== origin.sourceTurnId || origin.boundary === "before";
}

export function makeBringBackPreview({ storage, owner, source, side, answer, insertionId }) {
  const key = draftKey(owner);
  const snapshotId = side.conversation?.referenceSnapshot?.snapshotId ?? side.conversation?.origin?.snapshotId ?? "未知快照";
  return {
    owner: { ...owner }, insertionId, draftVersion: Number(storage.getItem(`${key}:version`) ?? 0),
    draftText: storage.getItem(key) ?? "",
    stale: sideSourceAdvanced(source, side),
    text: `来自旁路讨论 ${side.preview || side.id}（来源快照 ${snapshotId}；来源会话 ${source.id}）\n\n${answer}`,
  };
}

export function insertSideAnswer({ storage, preview, current, dispatch = /** @type {(key: string) => void} */ (() => {}) }) {
  const { owner, source, side } = current;
  if (!sameOwner(preview.owner, owner)) return { status: "owner-changed" };
  if (!source || !side || source.id !== owner.sourceThreadId || side.id !== owner.sideThreadId ||
      source.desktop?.archived || side.desktop?.archived ||
      side.conversation?.kind !== "side" || side.conversation.origin?.sourceThreadId !== source.id ||
      current.connected === false) return { status: "unavailable" };
  const key = draftKey(owner);
  const insertedKey = `${key}:side-insertions`;
  let inserted;
  try { inserted = JSON.parse(storage.getItem(insertedKey) ?? "[]"); } catch { inserted = []; }
  if (!Array.isArray(inserted)) inserted = [];
  const latest = storage.getItem(key) ?? "";
  const changed = latest !== preview.draftText || Number(storage.getItem(`${key}:version`) ?? 0) !== preview.draftVersion;
  if (inserted.includes(preview.insertionId)) return { status: "duplicate", changed };
  const text = preview.text.trim();
  if (!text) return { status: "empty", changed };
  storage.setItem(key, `${latest}${latest.trim() ? "\n\n" : ""}${text}`);
  storage.setItem(`${key}:version`, String(Number(storage.getItem(`${key}:version`) ?? 0) + 1));
  storage.setItem(insertedKey, JSON.stringify([...inserted, preview.insertionId]));
  dispatch(key);
  return { status: "inserted", changed };
}
