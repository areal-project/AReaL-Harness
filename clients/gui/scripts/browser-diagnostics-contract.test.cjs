'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validToolInput } = require('../app/src/core/browser-tool.cjs');

test('browser_v1 exposes a bounded diagnostics read without script or unbounded options', () => {
  const pageId = '12345678-1234-1234-1234-123456789abc';
  assert.equal(validToolInput({ operation: 'diagnostics', parameters: { pageId, kind: 'console', limit: 50 } }), true);
  assert.equal(validToolInput({ operation: 'diagnostics', parameters: { pageId, kind: 'network', cursor: 2, limit: 200 } }), true);
  for (const parameters of [
    { pageId, kind: 'network', limit: 201 },
    { pageId, kind: 'network', cursor: -1 },
    { pageId, kind: 'network', script: 'fetch("/private")' },
    { pageId, kind: 'headers' },
  ]) assert.equal(validToolInput({ operation: 'diagnostics', parameters }), false);
});

// 纯控制契约使用最小依赖替身；原生输入行为由桌面验收覆盖。
const Module = require('node:module');
const load = Module._load;
let CorePreview;
try {
  Module._load = function (id, ...args) {
    if (id === '@areal/workbench/desktop-contract') return { validatePreview() {} };
    return load.call(this, id, ...args);
  };
  ({ CorePreview } = require('../app/src/core/preview.cjs'));
} finally { Module._load = load; }

test('direct human input fences before drain and delivers only after convergence', async () => {
  const log = [];
  let finish;
  const drained = new Promise(resolve => { finish = resolve; });
  const c = { isDestroyed: () => false, sendInputEvent: input => log.push(input.type), focus() {} };
  const page = { id: 'page', coreInstanceId: 'core', projectId: 'project', threadId: 'thread',
    control: 'agent', controlEpoch: 2, pageGeneration: 1, documentGeneration: 1,
    requestedVisible: true, view: { webContents: c, getBounds: () => ({ width: 500, height: 300 }) } };
  const preview = Object.create(CorePreview.prototype);
  Object.assign(preview, { page: () => page, pageStillOwned: () => true,
    profile: { status: () => ({ busy: false }) },
    owner: JSON.stringify(['core', 'project', 'thread', 'page']),
    selected: new Map([[JSON.stringify(['core', 'project', 'thread']), 'page']]),
    window: { isVisible: () => true, isMinimized: () => false, isFocused: () => true },
    revoke: () => { log.push('fence'); page.control = 'transferring'; page.controlEpoch++; },
    convergeInput: async () => { await drained; page.control = 'human'; }, state: () => ({}) });
  const pending = preview.humanInput('project', 'thread', 'page', { type: 'mouseDown', x: 10, y: 12, button: 'left' });
  assert.deepEqual(log, ['fence']);
  preview.revoke = () => {};
  const up = preview.humanInput('project', 'thread', 'page', { type: 'mouseUp', x: 10, y: 12, button: 'left' });
  finish(); await Promise.all([pending, up]);
  assert.deepEqual(log, ['fence', 'mouseDown', 'mouseUp']);
});

test('human input never delivers to a replacement document while draining', async () => {
  let finish;
  const page = { id: 'page', coreInstanceId: 'core', projectId: 'project', threadId: 'thread',
    control: 'agent', controlEpoch: 1, pageGeneration: 1, documentGeneration: 1, requestedVisible: true,
    view: { webContents: { isDestroyed: () => false, sendInputEvent: () => assert.fail('stale input delivered') },
      getBounds: () => ({ width: 500, height: 300 }) } };
  const preview = Object.create(CorePreview.prototype);
  Object.assign(preview, { page: () => page, pageStillOwned: () => true,
    profile: { status: () => ({ busy: false }) },
    owner: JSON.stringify(['core', 'project', 'thread', 'page']),
    selected: new Map([[JSON.stringify(['core', 'project', 'thread']), 'page']]),
    window: { isVisible: () => true, isMinimized: () => false, isFocused: () => true },
    revoke: () => { page.control = 'transferring'; page.controlEpoch++; },
    convergeInput: () => new Promise(resolve => { finish = () => { page.control = 'human'; resolve(); }; }), state: () => ({}) });
  const pending = preview.humanInput('project', 'thread', 'page', { type: 'keyDown', keyCode: 'A' });
  await new Promise(resolve => setImmediate(resolve));
  page.documentGeneration++; finish();
  await assert.rejects(pending, /页面|input/);
});

test('keyDown and character are queued ahead of a physical keyUp during drain', async () => {
  const log = [];
  let finish;
  const drained = new Promise(resolve => { finish = resolve; });
  const preview = Object.create(CorePreview.prototype);
  preview.humanInput = async (_project, _thread, _page, input) => { log.push(input.type); await drained; };
  const page = { projectId: 'project', threadId: 'thread', id: 'page' };
  const down = preview.humanKey(page, { type: 'keyDown', key: 'a' });
  const up = preview.humanKey(page, { type: 'keyUp', key: 'a' });
  assert.deepEqual(log, ['keyDown', 'char', 'keyUp']);
  finish(); await Promise.all([down, up]);
});

test('takeover drains prior native receipts before releasing held key and mouse', async () => {
  const log = [];
  let finish;
  const receipt = new Promise(resolve => { finish = resolve; });
  const page = { control: 'transferring', controlEpoch: 3, requestedVisible: true,
    coreInstanceId: 'core', projectId: 'project', threadId: 'thread', id: 'page',
    heldKeys: new Map([['a', { key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 }]]),
    heldButtons: new Map([['left', { x: 10, y: 12 }]]), inputPending: new Set([receipt]) };
  receipt.then(() => page.inputPending.delete(receipt));
  page.view = { setVisible() {}, webContents: { isDestroyed: () => false,
    debugger: { isAttached: () => true, sendCommand: async (method, params) => { log.push([method, params.type]); },
      detach: () => log.push(['detach']) } } };
  const preview = Object.create(CorePreview.prototype);
  Object.assign(preview, { pageStillOwned: () => true, changed() {},
    owner: JSON.stringify(['core', 'project', 'thread', 'page']) });
  const pending = preview.convergeInput(page);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(log, []); assert.equal(page.control, 'transferring');
  finish(); await pending;
  assert.deepEqual(log, [['Input.dispatchKeyEvent', 'keyUp'], ['Input.dispatchMouseEvent', 'mouseReleased'], ['detach']]);
  assert.equal(page.control, 'human');
  assert.equal(page.heldKeys.size + page.heldButtons.size + page.inputPending.size, 0);
});

test('a queued physical release outside the page completes its owned gesture', async () => {
  const log = [];
  let finish;
  const drain = new Promise(resolve => { finish = resolve; });
  const page = { id: 'page', coreInstanceId: 'core', projectId: 'project', threadId: 'thread',
    control: 'agent', controlEpoch: 1, pageGeneration: 1, documentGeneration: 1, requestedVisible: true,
    view: { getBounds: () => ({ width: 500, height: 300 }), webContents: { isDestroyed: () => false,
      focus() {}, sendInputEvent: input => log.push(input.type) } } };
  const preview = Object.create(CorePreview.prototype);
  Object.assign(preview, { page: () => page, pageStillOwned: () => true,
    profile: { status: () => ({ busy: false }) },
    owner: JSON.stringify(['core', 'project', 'thread', 'page']),
    selected: new Map([[JSON.stringify(['core', 'project', 'thread']), 'page']]),
    window: { isVisible: () => true, isMinimized: () => false, isFocused: () => true }, state: () => ({}),
    revoke: () => { if (page.control === 'agent') { page.control = 'transferring'; page.controlEpoch++; } },
    convergeInput: async () => { await drain; page.control = 'human'; } });
  const down = preview.humanInput('project', 'thread', 'page', { type: 'mouseDown', x: 5, y: 10, button: 'left' });
  const up = preview.humanInput('project', 'thread', 'page', { type: 'mouseUp', x: -10, y: 400, button: 'left' });
  finish(); await Promise.all([down, up]);
  assert.deepEqual(log, ['mouseDown', 'mouseUp']);
});

test('public search approval includes exact successful form values and refuses unknown payloads', async () => {
  const preview = Object.create(CorePreview.prototype);
  let fields = [['q', 'AI Agent'], ['hl', 'en']];
  const c = { debugger: { sendCommand: async method => method === 'Page.getFrameTree' ? { frameTree: { frame: { id: 'main' } } }
    : method === 'Page.createIsolatedWorld' ? { executionContextId: 7 }
    : method === 'DOM.resolveNode' ? { object: { objectId: 'query' } }
    : method === 'Runtime.callFunctionOn' ? { result: { value: { field: true, search: true, method: 'get',
      destination: 'https://search.example/search', submittedFields: fields, query: fields?.[0]?.[1], queryName: 'q' } } } : {} } };
  const page = { networkPolicy: { canAuthorize: () => true } };
  const action = { kind: 'press', key: 'Enter' }, target = { backendNodeId: 1 };
  const approved = await preview.publicActionSemantics(page, c, target, action);
  assert.equal(approved.query, 'AI Agent');
  assert.deepEqual(approved.submittedFields, fields);
  fields = [['q', 'changed'], ['hl', 'en']];
  assert.notDeepEqual(await preview.publicActionSemantics(page, c, target, action), approved);
  fields = null;
  await assert.rejects(preview.publicActionSemantics(page, c, target, action), /human_takeover_required/);
});

test('hidden Agent view ignores pointer motion and release without an owned gesture', () => {
  const { EventEmitter } = require('node:events');
  const window = new EventEmitter(); window.webContents = new EventEmitter(); window.isFocused = () => true;
  const preview = new CorePreview(window, null, () => true);
  const page = { id: 'page', control: 'agent', requestedVisible: true, pageGeneration: 1, documentGeneration: 1,
    view: { getBounds: () => ({ x: 10, y: 20, width: 100, height: 100 }), getVisible: () => false } };
  preview.owner = 'owner'; preview.pages.set('owner', page);
  let delivered = 0;
  preview.humanInput = async () => { delivered++; };
  for (const type of ['mouseMove', 'mouseUp']) window.webContents.emit('before-mouse-event',
    { preventDefault: () => assert.fail('unowned event intercepted') }, { type, x: 30, y: 40, button: 'left' });
  assert.equal(delivered, 0);
});

test('rejected terminal release clears a stale gesture without injecting into a new document', async () => {
  const preview = Object.create(CorePreview.prototype);
  const page = { id: 'page', coreInstanceId: 'core', projectId: 'project', threadId: 'thread',
    pageGeneration: 1, documentGeneration: 2, control: 'human', controlEpoch: 1, requestedVisible: true,
    view: { getBounds: () => ({ width: 100, height: 100 }), webContents: { isDestroyed: () => false,
      sendInputEvent: () => assert.fail('release injected into replacement document') } } };
  Object.assign(preview, { page: () => page, pageStillOwned: () => true,
    profile: { status: () => ({ busy: false }) },
    owner: JSON.stringify(['core', 'project', 'thread', 'page']),
    selected: new Map([[JSON.stringify(['core', 'project', 'thread']), 'page']]),
    window: { isVisible: () => true, isMinimized: () => false, isFocused: () => true },
    humanMouseGesture: { page, generation: 1, document: 1, button: 'left', delivered: true } });
  await assert.rejects(preview.humanInput('project', 'thread', 'page',
    { type: 'mouseUp', x: -10, y: 400, button: 'left' }));
  assert.equal(preview.humanMouseGesture, null);
});

test('public search ignores empty unnamed file helpers but still refuses sensitive controls', async () => {
  const preview = Object.create(CorePreview.prototype);
  const control = (tagName, type, name, label, value = '') => ({ tagName, type, name, value, id: '', autocomplete: '',
    getAttribute: key => key === 'aria-label' ? label : null, hasAttribute: () => false,
    matches: () => false, closest: () => null });
  const query = control('TEXTAREA', 'textarea', 'q', 'Search', 'AI Agent');
  const uploadButton = control('BUTTON', 'button', '', 'Add files and tools');
  const file = { ...control('INPUT', 'file', '', null), files: [] };
  const form = { elements: [uploadButton, file, query], method: 'get', action: 'https://search.example/search',
    getAttribute: key => key === 'role' ? 'search' : null };
  query.form = form; uploadButton.form = form;
  let element = query;
  const c = { debugger: { sendCommand: async (method, params) => method === 'Page.getFrameTree' ? { frameTree: { frame: { id: 'main' } } }
    : method === 'Page.createIsolatedWorld' ? { executionContextId: 7 }
    : method === 'DOM.resolveNode' ? { object: { objectId: 'target' } }
    : method === 'Runtime.callFunctionOn' ? { result: { value: require('node:vm').runInNewContext(
      '(' + params.functionDeclaration + ')', { document: { characterSet: 'UTF-8' }, TextEncoder })
      .apply(element, params.arguments.map(argument => argument.value)) } } : {} } };
  const page = { networkPolicy: { canAuthorize: () => true } }, target = { backendNodeId: 1 };
  const fill = { kind: 'fill', value: 'AI Agent' }, press = { kind: 'press', key: 'Enter' };
  assert.equal((await preview.publicActionSemantics(page, c, target, fill)).kind, 'edit_field');
  assert.equal((await preview.publicActionSemantics(page, c, target, press)).encodedQuery, 'q=AI+Agent');
  file.files = [{}];
  await assert.rejects(preview.publicActionSemantics(page, c, target, press), /human_takeover_required/);
  file.files = []; file.name = 'attachment';
  await assert.rejects(preview.publicActionSemantics(page, c, target, fill), /human_takeover_required/);
  file.name = '';
  const submit = control('INPUT', 'submit', 'search', null); submit.form = form;
  form.elements.unshift(submit);
  assert.equal((await preview.publicActionSemantics(page, c, target, press)).query, 'AI Agent');
  form.elements.push(control('INPUT', 'password', 'password', 'Password'));
  await assert.rejects(preview.publicActionSemantics(page, c, target, fill), /human_takeover_required/);
  form.elements.pop(); element = uploadButton;
  await assert.rejects(preview.publicActionSemantics(page, c, target, { kind: 'click' }), /human_takeover_required/);
});

// 先复现真实搜索的二次同路径跳转；反例覆盖查询篡改、重复参数、超时及人工换代。
test('approved public search retains a bounded exact-query navigation chain', () => {
  const preview = Object.create(CorePreview.prototype);
  const intent = { kind: 'public_search', controlEpoch: 3, pageGeneration: 1, expiresAt: Date.now() + 30000,
    targetOrigin: 'https://search.example', targetPath: '/search', queryName: 'q',
    submittedFields: [['search', ''], ['q', 'AI Agent'], ['form', 'QBLH']] };
  const page = () => ({ control: 'agent', controlEpoch: 3, pageGeneration: 1, approvedActionNavigation: structuredClone(intent) });
  const live = page();
  assert.equal(preview.acceptActionNavigation(live, 'https://search.example/search?q=AI+Agent&form=QBLH'), true);
  const expiresAt = live.approvedActionNavigation.expiresAt;
  assert.equal(preview.acceptActionNavigation(live, 'https://search.example/search?q=AI+Agent&form=QBLH&rdr=1'), true);
  assert.equal(live.approvedActionNavigation.expiresAt, expiresAt, 'redirects cannot renew the deadline');
  const rewritten = page();
  rewritten.approvedActionNavigation.submittedFields = [['go', 'Search'], ['q', 'AI Agent'], ['qs', 'ds'], ['form', 'QBRE']];
  assert.equal(preview.acceptActionNavigation(rewritten, 'https://search.example/search?q=AI+Agent&qs=n&form=QBRE&sp=-1'), true, 'site JavaScript can omit submitter and rewrite auxiliary fields');
  assert.equal(preview.acceptActionNavigation(rewritten, 'https://search.example/search?q=AI+Agent'), true);
  assert.equal(preview.acceptActionNavigation(rewritten, 'https://search.example/search?q=AI+Agent&q=AI+Agent'), false, 'query multiplicity stays exact');
  for (const url of [
    'https://other.example/search?q=AI+Agent&form=QBLH',
    'https://search.example/other?q=AI+Agent&form=QBLH',
    'https://search.example/search?q=changed&form=QBLH',
    'https://search.example/search?q=AI+Agent&q=changed&form=QBLH',
    'https://search.example/search?form=QBLH',
    'https://user:secret@search.example/search?q=AI+Agent&form=QBLH',
  ]) { const p = page(); assert.equal(preview.acceptActionNavigation(p, url), false); assert.equal(p.approvedActionNavigation, null); }
  const expired = page(); expired.approvedActionNavigation.expiresAt = Date.now() - 1;
  assert.equal(preview.acceptActionNavigation(expired, 'https://search.example/search?q=AI+Agent&form=QBLH'), false);
  const revoked = page(); revoked.controlEpoch++;
  assert.equal(preview.acceptActionNavigation(revoked, 'https://search.example/search?q=AI+Agent&form=QBLH'), false);
  const replaced = page(); replaced.pageGeneration++;
  assert.equal(preview.acceptActionNavigation(replaced, 'https://search.example/search?q=AI+Agent&form=QBLH'), false);
  const empty = page(); empty.approvedActionNavigation.submittedFields = [['q', ''], ['search', '']];
  assert.equal(preview.acceptActionNavigation(empty, 'https://search.example/search?q='), true);
  assert.equal(preview.acceptActionNavigation(empty, 'https://search.example/search'), false, 'empty query cannot disappear');
  const human = page(); human.control = 'human';
  assert.equal(preview.acceptActionNavigation(human, 'https://search.example/search?q=AI+Agent&form=QBLH'), false);
  const link = page(); link.approvedActionNavigation = { kind: 'link_navigation', controlEpoch: 3,
    targetOrigin: 'https://search.example', targetPath: '/article', targetUrl: 'https://search.example/article?id=1' };
  assert.equal(preview.acceptActionNavigation(link, 'https://search.example/article?id=1'), true);
  assert.equal(preview.acceptActionNavigation(link, 'https://search.example/article?id=1'), false, 'link approval remains single-use');
});

// 真实首页加载触发多次同 URL replaceState；读取仍失效，控制权不能因此被误撤销。
test('same-document unchanged URL invalidates observations without revoking current control', () => {
  const { EventEmitter } = require('node:events');
  function setup(control = 'agent') {
    const c = new EventEmitter(); c.debugger = new EventEmitter(); c.session = new EventEmitter();
    c.session.setPermissionRequestHandler = c.session.setPermissionCheckHandler = () => {};
    c.setWindowOpenHandler = () => {};
    class View { constructor() { this.webContents = c; } setVisible() {} }
    const window = new EventEmitter(); window.webContents = new EventEmitter();
    window.contentView = { addChildView() {} };
    const preview = new CorePreview(window, View, () => true, () => ({}), () => 'core');
    preview.profile = { assertAvailable() {}, partition: 'fixture', session: c.session, registerPage: () => () => {} };
    preview.reservePageSlot = preview.changed = () => {};
    preview.ensureWorkspaceContext = () => ({});
    preview.convergeInput = async () => {};
    const page = preview.create(JSON.stringify(['core', 'project', 'thread', 'page']), 'project', 'thread', { id: 'page' });
    let readsCancelled = 0, actionsCancelled = 0;
    Object.assign(page, { control, controlEpoch: 3, url: 'https://search.example/', committedUrl: 'https://search.example/',
      activeRead: { cancel() { readsCancelled++; } },
      activeAction: control === 'agent' ? { cancel() { actionsCancelled++; } } : null });
    return { page, c, counts: () => ({ readsCancelled, actionsCancelled }) };
  }
  const live = setup();
  for (let i = 1; i <= 3; i++) {
    live.page.refs.set('old', 'r1'); live.page.plans.set('old', { plan: { operation: 'act' } }); live.page.needsObservation = false;
    live.c.emit('did-start-navigation', {}, 'https://search.example/', true, true);
    assert.equal(live.page.control, 'agent'); assert.equal(live.page.controlEpoch, 3);
    assert.equal(live.page.documentGeneration, i); assert.equal(live.page.activeAction.navigationDocument, i);
    assert.equal(live.page.refs.size, 0); assert.equal(live.page.plans.size, 0); assert.equal(live.page.needsObservation, true);
  }
  assert.deepEqual(live.counts(), { readsCancelled: 3, actionsCancelled: 0 });
  const pending = setup();
  const intent = { kind: 'public_search', targetOrigin: 'https://search.example', targetPath: '/search',
    controlEpoch: 3, pageGeneration: 1, queryName: 'q', submittedFields: [['q', 'query']], expiresAt: Date.now() + 30000 };
  pending.page.approvedActionNavigation = intent; pending.page.approvedNavigation = 'https://search.example/search?q=query';
  pending.c.emit('did-start-navigation', {}, 'https://search.example/', true, true);
  assert.equal(pending.page.approvedActionNavigation, intent, 'history event cannot consume pending search intent');
  assert.equal(pending.page.approvedNavigation, 'https://search.example/search?q=query');
  const provisional = setup(); provisional.page.url = 'https://search.example/pending';
  provisional.c.emit('did-start-navigation', {}, provisional.page.url, true, true);
  assert.equal(provisional.page.control, 'transferring', 'provisional URL is not a committed document');

  for (const [url, inPlace] of [['https://search.example/?q=changed', true], ['https://search.example/#other', true],
    ['https://search.example/other', true], ['https://search.example/', false]]) {
    const changed = setup(); changed.c.emit('did-start-navigation', {}, url, inPlace, true);
    assert.equal(changed.page.control, 'transferring'); assert.equal(changed.page.controlEpoch, 4);
    assert.equal(changed.counts().actionsCancelled, 1);
  }
  const human = setup('human'); human.c.emit('did-start-navigation', {}, 'https://search.example/', true, true);
  assert.equal(human.page.control, 'human'); assert.equal(human.page.controlEpoch, 3);
});
