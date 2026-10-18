// 来源、服务实例和目标共同决定旁路编辑状态；连接代际只约束迟到结果。
export class SideDraftWorkspace {
  constructor(storage, { instanceId, projectId, sourceThreadId, randomId }) {
    this.storage = storage;
    this.prefix = `areal-gui:side:v2:${instanceId}:${projectId}:${sourceThreadId}`;
    this.randomId = randomId;
    this.selectionKey = `${this.prefix}:selected`;
    this.draftsKey = `${this.prefix}:drafts`;
  }

  drafts() {
    try {
      const ids = JSON.parse(this.storage.getItem(this.draftsKey) ?? '[]');
      return Array.isArray(ids) ? ids.filter(id => typeof id === 'string' && id) : [];
    } catch { return []; }
  }

  rememberDraft(id) {
    const ids = this.drafts();
    if (!ids.includes(id)) this.storage.setItem(this.draftsKey, JSON.stringify([...ids, id]));
  }

  current() {
    const saved = this.storage.getItem(this.selectionKey);
    if (saved?.startsWith('side:') && saved.length > 5) return { kind: 'side', id: saved.slice(5) };
    if (saved?.startsWith('draft:') && saved.length > 6) {
      const id = saved.slice(6);
      this.rememberDraft(id);
      return { kind: 'draft', id };
    }
    return this.newDraft();
  }

  newDraft() {
    const id = this.randomId();
    this.rememberDraft(id);
    this.storage.setItem(this.selectionKey, `draft:${id}`);
    return { kind: 'draft', id };
  }

  selectDraft(id) {
    if (!this.drafts().includes(id)) throw new Error('旁路草稿不存在');
    this.storage.setItem(this.selectionKey, `draft:${id}`);
    return { kind: 'draft', id };
  }

  selectSide(id) {
    this.storage.setItem(this.selectionKey, `side:${id}`);
    return { kind: 'side', id };
  }

  owner(selection) { return `${this.prefix}:${selection.kind}:${selection.id}`; }
  draftKey(selection) { return `${this.owner(selection)}:draft`; }
  pendingKey(selection) { return `${this.owner(selection)}:pending`; }
  bringBackKey(selection) { return `${this.owner(selection)}:bring-back`; }
  bringBack(selection) {
    try {
      const preview = JSON.parse(this.storage.getItem(this.bringBackKey(selection)) ?? 'null');
      return preview?.owner?.paneOwner === this.owner(selection) && typeof preview.text === 'string' &&
        typeof preview.insertionId === 'string' ? preview : null;
    } catch { return null; }
  }
  saveBringBack(selection, preview) {
    if (!preview) { this.storage.removeItem(this.bringBackKey(selection)); return; }
    if (preview.owner.paneOwner !== this.owner(selection)) throw new Error('带回预览的旁路归属已变化');
    this.storage.setItem(this.bringBackKey(selection), JSON.stringify(preview));
  }

  pendingDrafts() { return this.drafts().filter(id => this.storage.getItem(this.pendingKey({ kind: 'draft', id }))).map(id => ({ kind: 'draft', id })); }
  availableDrafts() { return this.drafts().filter(id => {
    const draft = { kind: 'draft', id };
    return this.storage.getItem(this.draftKey(draft)) || this.storage.getItem(this.pendingKey(draft));
  }).map(id => ({ kind: 'draft', id })); }

  capture(connectionGeneration) {
    const selection = this.current();
    return { selection, owner: this.owner(selection), connectionGeneration };
  }

  isCurrent(token, connectionGeneration) {
    return token.connectionGeneration === connectionGeneration && token.owner === this.owner(this.current());
  }

  acceptCreated(token, sideId, connectionGeneration) {
    if (!this.isCurrent(token, connectionGeneration)) return false;
    this.storage.removeItem(this.pendingKey(token.selection));
    this.storage.removeItem(this.draftKey(token.selection));
    this.storage.setItem(this.draftsKey, JSON.stringify(this.drafts().filter(id => id !== token.selection.id)));
    this.selectSide(sideId);
    return true;
  }

  clearAfterSend(token, connectionGeneration) {
    if (!this.isCurrent(token, connectionGeneration)) return false;
    this.storage.removeItem(this.draftKey(token.selection));
    return true;
  }
}
