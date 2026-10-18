import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { SideDraftWorkspace } from '../renderer/src/side-draft-owner.js';

const require = createRequire(import.meta.url);
const { CoreBackend } = require('../app/src/core/backend.cjs');
const backend = Object.create(CoreBackend.prototype);
backend.binary = '/fixture/areal';
backend.library = { value: { projects: {} } };
backend.projectless = { snapshot: () => ({}) };
backend.providers = { catalog: () => [] };
backend.saved = [{ id: 'project', root: '/workspace' }];
backend.projects = new Map([['project', {
  model: { getSnapshot: () => ({ connected: true, threads: {} }) },
  service: { serviceId: 'instance-a', generation: 'service-generation' },
  connectionGeneration: 7, configurations: {}, pending: [], outcomes: {}, summaries: [],
}]]);
const projected = backend.snapshot().projects[0];
assert.equal(projected.core.instanceId, 'instance-a');
assert.equal(projected.core.connectionGeneration, 7);

class Storage {
  values = new Map();
  get length() { return this.values.size; }
  key(index) { return [...this.values.keys()][index] ?? null; }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}
const storage = new Storage();
let sequence = 0;
const make = instanceId => new SideDraftWorkspace(storage, {
  instanceId, projectId: projected.id, sourceThreadId: 'source', randomId: () => `draft-${++sequence}`,
});
const workspace = make(projected.core.instanceId);
const first = workspace.current();
const firstOwner = workspace.owner(first);
storage.setItem(workspace.draftKey(first), 'question for first Side');
storage.setItem(workspace.pendingKey(first), 'unknown-first-question-key');
const firstRequest = workspace.capture(projected.core.connectionGeneration);

const second = workspace.newDraft();
assert.notEqual(workspace.owner(second), firstOwner);
storage.setItem(workspace.draftKey(second), 'unrelated new question');
assert.equal(workspace.acceptCreated(firstRequest, 'side-one', 7), false, 'late first response must not replace the new discussion');
assert.deepEqual(workspace.current(), second);
assert.equal(storage.getItem(workspace.draftKey(second)), 'unrelated new question');
assert.equal(storage.getItem(workspace.pendingKey(first)), 'unknown-first-question-key', 'unknown first question retains its business key');
assert.ok(workspace.pendingDrafts().some(draft => draft.id === first.id), 'unknown discussion remains reachable');

workspace.selectDraft(first.id);
const recovery = workspace.capture(7);
assert.equal(workspace.acceptCreated(recovery, 'side-one', 7), true);
assert.deepEqual(workspace.current(), { kind: 'side', id: 'side-one' });
assert.equal(storage.getItem(workspace.pendingKey(first)), null);
storage.setItem(workspace.draftKey(workspace.current()), 'side-one follow-up');
workspace.selectSide('side-two');
storage.setItem(workspace.draftKey(workspace.current()), 'side-two follow-up');
assert.equal(storage.getItem(workspace.draftKey({ kind: 'side', id: 'side-one' })), 'side-one follow-up');
assert.equal(storage.getItem(workspace.draftKey({ kind: 'side', id: 'side-two' })), 'side-two follow-up');

const oldConnection = workspace.capture(7);
assert.equal(workspace.clearAfterSend(oldConnection, 8), false, 'old connection completion cannot clear the selected Side draft');
assert.equal(storage.getItem(workspace.draftKey(workspace.current())), 'side-two follow-up');
const replacementService = make('instance-b');
assert.notEqual(replacementService.owner(replacementService.current()), workspace.owner(workspace.current()));
assert.deepEqual(replacementService.pendingDrafts(), [], 'another Core instance cannot inherit unknown keys');
console.log('side owner state and backend projection: passed');
