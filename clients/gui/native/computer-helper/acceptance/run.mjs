import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID, createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const local = dirname(fileURLToPath(import.meta.url));
const gui = resolve(local, '../../..');
const require = createRequire(import.meta.url);
const { ComputerControl } = require(join(gui, 'app/src/core/computer-control.cjs'));
const options = { actions: false, helper: join(local, '../build/AReaL Computer Helper.app'), fixture: null,
  output: `/tmp/areal-computer-acceptance-${Date.now()}` };
for (let i = 2; i < process.argv.length; i += 1) {
  const option = process.argv[i];
  if (option === '--actions') options.actions = true;
  else if (['--helper', '--fixture', '--output'].includes(option) && process.argv[i + 1]) options[option.slice(2)] = resolve(process.argv[++i]);
  else throw new Error(`Unknown option: ${option}`);
}
await mkdir(options.output, { recursive: true });
let enabled = true;
const events = [];
const host = new ComputerControl({ helperPath: options.helper, getEnabled: () => enabled, onActivity: status => events.push(status) });
const owner = { coreInstanceId: randomUUID(), coreGeneration: randomUUID(), projectId: randomUUID(), threadId: randomUUID(), turnId: randomUUID(), toolHostGeneration: randomUUID() };
const evidence = { mode: options.actions ? 'native-actions' : 'passive', checks: [], gaps: [], status: null };
let fixture;
let fixtureStderr = '';
const request = (operation, parameters = {}, extra = {}) => ({ ...owner, callId: randomUUID(), arguments: { operation, parameters }, ...extra });
const pass = name => { evidence.checks.push(name); process.stdout.write(`PASS ${name}\n`); };
async function prepare(operation, parameters = {}, extra = {}) {
  if (fixture && ['left_click', 'left_click_drag', 'scroll', 'type', 'key', 'paste'].includes(operation) && parameters.strategy !== 'a11y') {
    const before = await truth();
    if (!before.frontmost) {
      const nonce = randomUUID();
      await writeFile(join(options.output, 'fixture.json.activate'), nonce);
      await until(async () => { const value = await truth(); return value.activationRequest === nonce && value.frontmost; }, 'Dedicated fixture did not establish the event-test foreground precondition');
      (evidence.fixtureFocusPreparations ??= []).push({ operation, previousForegroundPID: before.frontmostPID });
    }
  }
  const call = request(operation, parameters, extra);
  const plan = await host.prepare({ ...call, phase: 'prepare' });
  return { ...call, phase: 'execute', computerApproval: { plan } };
}
async function invoke(operation, parameters = {}, extra = {}) {
  const result = await host.execute(await prepare(operation, parameters, extra));
  assert.notEqual(result.isError, true, JSON.stringify(result.structuredContent));
  return result;
}
async function truth() { return JSON.parse(await readFile(join(options.output, 'fixture.json'), 'utf8')); }
async function until(predicate, message) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try { if (await predicate()) return; } catch {}
    await delay(50);
  }
  throw new Error(message);
}
try {
  const status = await host.status(); evidence.status = status;
  assert.equal(status.available, true, JSON.stringify(status));
  assert.equal((await host.status()).helperGeneration, status.helperGeneration);
  for (const key of ['accessibility', 'screenRecording', 'inputMonitoring']) assert.ok(['granted', 'denied', 'unknown'].includes(status[key]));
  pass('stable helper identity and passive permission status');
  const description = await invoke('describe');
  assert.equal(description.structuredContent.methods.length, 15);
  const access = await invoke('request_access');
  assert.equal(access.structuredContent.accessibility, status.accessibility);
  pass('model describe and request_access are passive');
  const reused = await prepare('describe');
  const foreign = await host.execute({ ...reused, projectId: randomUUID() });
  assert.equal(foreign.isError, true); assert.equal(foreign.structuredContent.dispatch_status, 'not_sent');
  const changed = await host.execute({ ...reused, arguments: { operation: 'list_apps', parameters: {} } });
  assert.equal(changed.isError, true); assert.equal(changed.structuredContent.dispatch_status, 'not_sent');
  assert.notEqual((await host.execute(reused)).isError, true);
  assert.equal((await host.execute(reused)).isError, true);
  pass('owner, exact argument and one-use approval binding');
  const revoked = await prepare('describe');
  await host.stop('Acceptance revocation');
  await assert.rejects(() => host.execute(revoked), error => error.code === 'human_control' && error.actionSent === false);
  await assert.rejects(() => host.prepare(request('get_app_state', { app_ref: { bundle_id: 'com.areal.harness.computer-fixture' } })), error => error.code === 'human_control');
  pass('Stop revokes pending approvals and fences old-turn observation');
  enabled = false;
  await assert.rejects(async () => host.prepare(request('describe')), error => error.code === 'not_authorized' && error.actionSent === false);
  assert.equal((await host.status()).enabled, false);
  await host.stop('Disabled acceptance');
  assert.equal((await invoke('stop_computer_control', { reason: 'Model Stop remains available while disabled' })).structuredContent.stopped, true);
  enabled = true;
  await assert.rejects(() => host.prepare(request('describe')), error => error.code === 'human_control');
  owner.turnId = randomUUID();
  pass('disabled host denies reads while status and Stop remain available');
  if (status.accessibility !== 'granted') {
    await assert.rejects(() => host.prepare(request('get_app_state', { app_ref: { bundle_id: 'com.areal.harness.computer-fixture' } })), error => error.code === 'permission_denied' && error.dispatch_status === 'not_sent');
    pass('AX permission denial sends no action');
  }
  const previous = (await host.status()).helperGeneration;
  const beforeRestart = request('describe');
  await host.prepare(beforeRestart);
  assert.notEqual((await host.restart()).helperGeneration, previous);
  await assert.rejects(() => host.prepare(beforeRestart), error => error.code === 'human_control');
  owner.turnId = randomUUID();
  await invoke('describe');
  pass('restart changes helper generation while preserving old-turn fencing');
  if (!options.actions) {
    evidence.gaps.push('Real AX actions, screenshots, event input, physical takeover, and packaged Core delivery require separate acceptance.');
  } else {
    assert.ok(options.fixture, '--actions requires --fixture pointing to the harmless fixture .app');
    assert.equal(status.accessibility, 'granted', 'Grant helper Accessibility through Settings before this run');
    assert.equal(status.screenRecording, 'granted', 'Grant helper Screen Recording through Settings before this run');
    const fixtureBinary = join(options.fixture, 'Contents/MacOS/AReaLComputerFixture');
    fixture = spawn(fixtureBinary, [join(options.output, 'fixture.json')], { stdio: ['ignore', 'ignore', 'pipe'] });
    fixture.stderr.on('data', chunk => { fixtureStderr = (fixtureStderr + chunk.toString('utf8')).slice(-64 * 1024); });
    await until(async () => (await truth()).frontmost, 'Fixture did not become ready');
    const app_ref = { bundle_id: 'com.areal.harness.computer-fixture', pid: (await truth()).pid };
    const listedApps = JSON.parse((await invoke('list_apps')).content[0].text);
    assert.ok(listedApps.some(app => app.pid === app_ref.pid));
    await until(async () => JSON.parse((await invoke('list_windows', { app_ref })).content[0].text).length > 0, 'Fixture AX window registration did not become ready');
    pass('real running application and AX window inventory');
    const state = async (screenshot = false) => (await invoke('get_app_state', { app_ref, include_screenshot: screenshot })).structuredContent;
    const find = (snapshot, identifier) => {
      const row = snapshot.elements.find(element => element.identifier === identifier);
      assert.ok(row, `Fixture AX element ${identifier} is absent`);
      return { type: 'element', index: row.index };
    };
    async function elementAction(operation, identifier, parameters = {}) {
      const snapshot = await state();
      return invoke(operation, { app_ref, state_id: snapshot.state_id, target: find(snapshot, identifier), ...parameters });
    }
    let initial;
    let screenshot;
    await until(async () => {
      screenshot = await invoke('get_app_state', { app_ref, include_screenshot: true });
      initial = screenshot.structuredContent;
      return initial.elements.some(element => element.identifier === 'fixture-editor');
    }, 'Fixture AX tree and capture did not become ready');
    assert.ok(initial.frame_id); assert.ok(initial.frame.pixel_width > 0);
    const png = screenshot.content.find(item => item.type === 'image');
    assert.ok(png); await writeFile(join(options.output, 'fixture.png'), Buffer.from(png.data, 'base64'));
    pass('real AX observation and exact raster metadata');
    await elementAction('left_click', 'fixture-press', { strategy: 'a11y' });
    await until(async () => (await truth()).presses === 1, 'AXPress did not increment fixture truth');
    await elementAction('perform_action', 'fixture-press', { action: 'AXPress' });
    await until(async () => (await truth()).presses === 2, 'Named AX action did not increment fixture truth');
    await elementAction('set_value', 'fixture-editor', { value: 'A😀BC' });
    await until(async () => (await truth()).text === 'A😀BC', 'AXValue did not change fixture text');
    await elementAction('select_text', 'fixture-editor', { text_range: [1, 2] });
    await until(async () => JSON.stringify((await truth()).selection) === '[1,2]', 'UTF-16 selection did not select the emoji');
    await elementAction('type', 'fixture-editor', { text: '替', strategy: 'a11y' });
    await until(async () => (await truth()).text === 'A替BC', 'AX insertion did not replace the selected text');
    pass('AX press, named action, value, UTF-16 selection and insertion');
    initial = await state();
    const oldAction = { app_ref, state_id: initial.state_id, target: find(initial, 'fixture-press'), strategy: 'a11y' };
    await state();
    await assert.rejects(() => host.prepare(request('left_click', oldAction)), error => error.actionSent === false);
    await assert.rejects(() => host.prepare(request('left_click', { ...oldAction, state_id: randomUUID() }, { projectId: randomUUID() })), error => error.actionSent === false);
    pass('superseded and foreign observations cannot act');
    if (status.inputMonitoring !== 'granted') {
      evidence.gaps.push('Event cases require explicit Input Monitoring permission. AX cases completed.');
      process.exitCode = 2;
    } else {
      async function padTarget(identifier = 'fixture-pad') {
        const snapshot = await state(true);
        const row = snapshot.elements.find(element => element.identifier === identifier);
        const [x, y, width, height] = row.bounds;
        const [left, top, captureWidth, captureHeight] = snapshot.frame.capture_bounds;
        return { state_id: snapshot.state_id, target: { type: 'coordinate', frame_id: snapshot.frame_id,
          x: Math.floor((x + width / 2 - left) * snapshot.frame.pixel_width / captureWidth),
          y: Math.floor((y + height / 2 - top) * snapshot.frame.pixel_height / captureHeight) } };
      }
      for (const mouse_button of ['left', 'right', 'middle']) {
        await invoke('left_click', { app_ref, ...await padTarget(), mouse_button, click_count: mouse_button === 'left' ? 2 : 1, modifiers: 'shift', strategy: 'event' });
      }
      await until(async () => { const value = await truth(); return ['mouseDown', 'rightMouseDown', 'otherMouseDown'].every(type => value.events.some(event => event.type === type)); }, 'Click variants did not reach the fixture');
      const beforeDrag = (await truth()).events.length;
      const pad = await padTarget();
      await invoke('left_click_drag', { app_ref, state_id: pad.state_id, from_target: pad.target, to: { ...pad.target, x: pad.target.x + 40 }, modifiers: 'shift' });
      await until(async () => (await truth()).events.slice(beforeDrag).some(event => event.type === 'mouseDragged'), 'Drag did not reach the fixture');
      await invoke('scroll', { app_ref, ...await padTarget(), scroll_direction: 'down', scroll_amount: 0.5, strategy: 'event' });
      await until(async () => (await truth()).events.some(event => event.type === 'scrollWheel' && event.deltaY !== 0), 'Scroll did not reach the fixture');
      await invoke('type', { app_ref, text: '中😀', strategy: 'event' });
      await invoke('key', { app_ref, text: 'shift+a', repeat: 3, hold_seconds: 0.03 });
      await until(async () => (await truth()).events.filter(event => event.type === 'keyDown' && event.keyCode === 0).length >= 3, 'Keyboard events did not reach the fixture');
      pass('raster clicks, click variants, modifiers, drag, scroll, Unicode and repeated keys');
      await elementAction('set_value', 'fixture-editor', { value: '' });
      await invoke('type', { app_ref, ...await padTarget('fixture-editor'), text: '坐标😀', strategy: 'event' });
      await until(async () => (await truth()).text === '坐标😀', 'Coordinate-targeted Unicode typing did not reach the editor');
      pass('coordinate-targeted Unicode typing changes the intended editor');
      await elementAction('left_click', 'fixture-editor', { strategy: 'event' });
      for (const [format, text] of [['text', 'plain paste'], ['md', '*markdown*'], ['html', '<b>HTML paste</b>']]) {
        await invoke('key', { app_ref, text: 'cmd+a' });
        await until(async () => { const value = await truth(); return value.selection[0] === 0 && value.selection[1] === value.text.length && (await state()).window.focused === true; }, 'Select All did not settle on the fixture editor');
        await invoke('paste', { app_ref, text, format });
        await until(async () => (await truth()).pasteboardTypes.includes(format === 'html' ? 'public.html' : 'public.utf8-plain-text'), `Pasteboard ${format} representation is absent`);
        await until(async () => (await truth()).text === (format === 'html' ? 'HTML paste' : text), `${format} paste did not change the editor`);
      }
      pass('text, Markdown and HTML paste effects and pasteboard representations');
      await invoke('left_click', { app_ref, ...await padTarget(), strategy: 'event' });
      const hold = await prepare('key', { app_ref, text: 'shift+a', hold_seconds: 10 });
      const holdEvents = (await truth()).events.length;
      const executing = host.execute(hold);
      await until(async () => (await host.status()).heldKeys > 0, 'Held key was not observable');
      await assert.rejects(() => host.prepare(request('key', { app_ref, text: 'b' }, { projectId: randomUUID(), threadId: randomUUID() })), error => error.code === 'controller_busy' && error.actionSent === false);
      const start = Date.now();
      const stopReceipt = await invoke('stop_computer_control', { reason: 'Acceptance stops a held key' });
      assert.ok(Date.now() - start < 1_000, 'Stop was blocked behind the action queue');
      assert.equal(stopReceipt.structuredContent.stopped, true);
      const stopped = await host.status();
      assert.equal(stopped.heldKeys, 0); assert.equal(stopped.heldButtons, 0);
      const cancelled = await executing;
      assert.equal(cancelled.structuredContent.dispatch_status, 'possibly_sent');
      await until(async () => { const received = (await truth()).events.slice(holdEvents); return received.some(event => event.type === 'keyUp' && event.keyCode === 0) && received.some(event => event.type === 'flagsChanged' && event.keyCode === 56 && event.modifiers === 0); }, 'Fixture did not receive key and modifier release after Stop');
      await assert.rejects(() => host.prepare(request('get_app_state', { app_ref })), error => error.code === 'human_control');
      owner.turnId = randomUUID();
      const dragPad = await padTarget();
      const interruptedDrag = await prepare('left_click_drag', { app_ref, state_id: dragPad.state_id, from_target: dragPad.target, to: { ...dragPad.target, x: dragPad.target.x + 60 } });
      const dragEvents = (await truth()).events.length;
      const dragging = host.execute(interruptedDrag);
      await until(async () => (await host.status()).heldButtons > 0, 'Drag never held its button');
      assert.equal((await host.stop('Acceptance stops drag')).heldButtons, 0);
      assert.equal((await dragging).structuredContent.dispatch_status, 'possibly_sent');
      await until(async () => (await truth()).events.slice(dragEvents).some(event => event.type === 'mouseUp'), 'Fixture did not receive mouse release after Stop');
      await assert.rejects(() => host.prepare(request('get_app_state', { app_ref })), error => error.code === 'human_control');
      owner.turnId = randomUUID();
      await state();
      pass('competing project is excluded and both Stop paths release held inputs, fence old turns, and admit new turns');
      evidence.gaps.push('Physical hardware takeover and SIGKILL cleanup require a separate operator run.');
    }
  }
} catch (error) {
  evidence.error = error.stack; process.exitCode = 1;
  process.stderr.write(`${error.stack}\n`);
  if (fixture?.pid) {
    try { execFileSync('/usr/bin/sample', [String(fixture.pid), '1', '-file', join(options.output, 'fixture-failure-sample.txt')], { stdio: 'ignore' }); } catch {}
  }
} finally {
  await host.close();
  if (fixture) fixture.kill('SIGTERM');
  evidence.activity = events;
  if (fixtureStderr) await writeFile(join(options.output, 'fixture-stderr.log'), fixtureStderr);
  evidence.revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: gui, encoding: 'utf8' }).trim();
  const sources = (await readdir(join(local, '../Sources'))).filter(name => name.endsWith('.swift')).sort();
  const hash = createHash('sha256');
  for (const name of sources) hash.update(await readFile(join(local, '../Sources', name)));
  hash.update(await readFile(join(gui, 'app/src/core/computer-control.cjs')));
  evidence.sourceDigest = hash.digest('hex');
  await writeFile(join(options.output, 'result.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`${options.output}\n`);
}
