import assert from 'node:assert/strict';
import { SideDraftWorkspace } from '../renderer/src/side-draft-owner.js';
import { makeBringBackPreview, insertSideAnswer } from '../renderer/src/side-bring-back.js';

class Storage {
  values = new Map();
  getItem(key) { return this.values.get(key) ?? null; }
  removeItem(key) { this.values.delete(key); }
  setItem(key, value) { this.values.set(key, String(value)); }
}
const storage = new Storage();
const owner = { instanceId: 'service-a', projectId: 'project-a', sourceThreadId: 'main-a', sideThreadId: 'side-a', paneOwner: 'service-a:project-a:main-a:side:side-a' };
const source = { id: 'main-a', updatedAt: 1791686759, turns: [{ id: 'turn-one', items: [{ id: 'answer-one' }] }] };
const side = { id: 'side-a', createdAt: 1791686756, desktop: {}, conversation: { kind: 'side', origin: { sourceThreadId: 'main-a', sourceTurnId: 'turn-one', boundary: 'after' }, referenceSnapshot: { snapshotId: 'snapshot-one', turnCount: 1, itemCount: 1 } } };
const key = 'areal-gui:draft:project-a:main-a';
storage.setItem(key, '已有正文');
storage.setItem(`${key}:version`, '3');
const preview = makeBringBackPreview({ storage, owner, source, side, answer: '选中的重点', selection: '重点', insertionId: 'insert-one' });
assert.match(preview.text, /选中的重点/);
assert.match(preview.text, /snapshot-one/);
assert.equal(preview.stale, true);
const sameSecond = { ...source, updatedAt: side.createdAt };
const stalePreview = source => makeBringBackPreview({ storage, owner, source, side, answer: '回复', insertionId: 'status-only' }).stale;
assert.equal(stalePreview(sameSecond), false);
assert.equal(stalePreview({ ...sameSecond, turns: [...source.turns, { id: 'turn-two', items: [] }] }), true);

storage.setItem(key, '并发修改后的正文');
storage.setItem(`${key}:version`, '4');
const events = [];
const current = { owner, source, side };
assert.deepEqual(insertSideAnswer({ storage, preview, current, dispatch: key => events.push(key) }), { status: 'inserted', changed: true });
assert.match(storage.getItem(key), /^并发修改后的正文\n\n/);
assert.match(storage.getItem(key), /选中的重点/);
assert.equal(storage.getItem(`${key}:version`), '5');
assert.deepEqual(events, [key]);
assert.deepEqual(insertSideAnswer({ storage, preview, current, dispatch: key => events.push(key) }), { status: 'duplicate', changed: true });
assert.deepEqual(events, [key]);

const whole = makeBringBackPreview({ storage, owner, source, side, answer: '完整回复', insertionId: 'insert-whole' });
assert.match(whole.text, /完整回复/);
assert.equal(insertSideAnswer({ storage, preview: whole, current: { ...current, owner: { ...owner, projectId: 'project-b' } } }).status, 'owner-changed');
assert.equal(insertSideAnswer({ storage, preview: whole, current: { ...current, owner: { ...owner, sideThreadId: 'side-b' } } }).status, 'owner-changed');
assert.equal(insertSideAnswer({ storage, preview: whole, current: { ...current, side: { ...side, desktop: { archived: true } } } }).status, 'unavailable');
assert.equal(storage.getItem('areal-gui:draft:project-b:main-a'), null);
assert.equal(storage.getItem(key).includes('完整回复'), false);
console.log('side bring-back public draft state: passed');

const workspace = new SideDraftWorkspace(storage, { instanceId: owner.instanceId, projectId: owner.projectId,
  sourceThreadId: owner.sourceThreadId, randomId: () => 'draft-a' });
const selected = workspace.selectSide('side-a');
const retained = { ...whole, owner: { ...owner, paneOwner: workspace.owner(selected) }, text: '编辑后保留的文本' };
workspace.saveBringBack(selected, retained);
workspace.selectSide('side-b');
assert.equal(workspace.bringBack(workspace.current()), null);
const restoredWorkspace = new SideDraftWorkspace(storage, { instanceId: owner.instanceId, projectId: owner.projectId,
  sourceThreadId: owner.sourceThreadId, randomId: () => 'draft-b' });
assert.deepEqual(restoredWorkspace.bringBack(restoredWorkspace.selectSide('side-a')), retained);
assert.equal(insertSideAnswer({ storage, preview: retained, current: { ...current, owner: { ...retained.owner, projectId: 'project-b' } } }).status, 'owner-changed');
assert.equal(storage.getItem('areal-gui:draft:project-b:main-a'), null);
assert.throws(() => workspace.saveBringBack({ kind: 'side', id: 'side-b' }, retained), /归属已变化/);
workspace.saveBringBack(selected, null);
assert.equal(workspace.bringBack(selected), null);
console.log('side bring-back retained owner state: passed');
