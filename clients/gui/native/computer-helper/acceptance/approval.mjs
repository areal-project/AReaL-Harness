import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';

const local = dirname(fileURLToPath(import.meta.url));
const native = resolve(local, '..');
const gui = resolve(native, '../..');
const options = { actions: false, buildOnly: false, helper: join(native, 'build/AReaL Computer Helper.app'), output: `/tmp/areal-computer-approval-${Date.now()}` };
for (let i = 2; i < process.argv.length; i += 1) {
  if (process.argv[i] === '--actions') options.actions = true;
  else if (process.argv[i] === '--build-only') options.buildOnly = true;
  else if (['--helper', '--output'].includes(process.argv[i])) options[process.argv[i].slice(2)] = resolve(process.argv[++i]);
  else throw new Error(`Unknown option ${process.argv[i]}`);
}
assert.equal(process.platform, 'darwin');
assert.ok(options.actions || options.buildOnly, 'Pass --actions to run dedicated fixture input, or --build-only to compile without desktop interaction');
await mkdir(options.output, { recursive: true });
const targetApp = join(options.output, 'AReaL Computer Fixture.app');
const hostApp = join(options.output, 'AReaL Approval Host.app');
execFileSync(process.execPath, [join(gui, 'scripts/build-computer-helper.mjs'), '--fixture', '--output', targetApp], { stdio: 'inherit' });
await mkdir(join(hostApp, 'Contents/MacOS'), { recursive: true });
const plist = (await readFile(join(targetApp, 'Contents/Info.plist'), 'utf8')).replaceAll('com.areal.harness.computer-fixture', 'com.areal.harness.approval-fixture').replaceAll('AReaLComputerFixture', 'ApprovalHost').replaceAll('AReaL Computer Fixture', 'AReaL Approval Host');
await writeFile(join(hostApp, 'Contents/Info.plist'), plist);
const hostBinary = join(hostApp, 'Contents/MacOS/ApprovalHost');
execFileSync('xcrun', ['swiftc', '-swift-version', '5', '-O', '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macosx14.0`, '-module-cache-path', join(native, 'build/module-cache'), join(local, 'ApprovalHost.swift'), '-o', hostBinary, '-framework', 'AppKit', '-framework', 'ApplicationServices'], { stdio: 'inherit' });
execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', 'com.areal.harness.approval-fixture', '--timestamp=none', hostApp], { stdio: 'inherit' });
if (options.buildOnly) { process.stdout.write(`Built approval fixtures without launching apps\n${options.output}\n`); process.exit(0); }

const helperBinary = join(options.helper, 'Contents/MacOS/AReaLComputerHelper');
const children = [];
const pending = new Map();
const activity = [];
const checks = [];
const evidence = { checks, activity, helperSHA256: createHash('sha256').update(await readFile(helperBinary)).digest('hex'), scope: 'Real helper with direct-parent AppKit approval host and dedicated target apps. Untagged synthetic HID clicks exercise OS routing; no personal applications or permission prompts.' };
const launch = (binary, args) => { const child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'] }); children.push(child); child.stderr.on('data', chunk => process.stderr.write(chunk)); return child; };
const host = launch(hostBinary, [helperBinary]);
const lines = createInterface({ input: host.stdout });
lines.on('line', line => {
  const value = JSON.parse(line);
  if (value.event) { activity.push(value); return; }
  const waiter = pending.get(value.id);
  if (!waiter) return;
  pending.delete(value.id); clearTimeout(waiter.timer);
  if (value.ok) waiter.resolve(value.result); else waiter.reject(Object.assign(new Error(value.error.message), value.error));
});
function rpc(method, params = {}) {
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out ${method}`)); }, 10_000);
    pending.set(id, { resolve, reject, timer });
    host.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
}
async function until(predicate, message) {
  for (const deadline = Date.now() + 5_000; Date.now() < deadline;) {
    if (await predicate()) return;
    await delay(30);
  }
  throw new Error(message);
}
const pass = text => { checks.push(text); process.stdout.write(`PASS ${text}\n`); };
const owner = { coreInstanceId: randomUUID(), coreGeneration: randomUUID(), projectId: randomUUID(), threadId: randomUUID(), turnId: randomUUID(), toolHostGeneration: randomUUID() };
let epoch;
const request = (operation, parameters) => ({ ...owner, callId: randomUUID(), admissionEpoch: epoch, arguments: { operation, parameters } });
async function prepare(operation, parameters) {
  const call = request(operation, parameters);
  return { ...call, computerApproval: { plan: await rpc('prepare', call) } };
}
async function execute(call) { return rpc('execute', call); }
async function success(operation, parameters) {
  const result = await execute(await prepare(operation, parameters));
  assert.notEqual(result.isError, true, JSON.stringify(result));
  return result.structuredContent;
}
async function click(x, y) { await rpc('fixture_click', { x, y }); await delay(100); }
async function freshTurn() { owner.turnId = randomUUID(); epoch = (await rpc('status')).controlEpoch; }
const truth = async name => JSON.parse(await readFile(join(options.output, `${name}.json`), 'utf8'));
try {
  const status = await rpc('status'); evidence.status = status;
  assert.equal(status.ready, true, 'Existing helper Accessibility, Screen Recording, and Input Monitoring grants required; acceptance never prompts');
  const hostStatus = await rpc('fixture_status'); evidence.host = hostStatus;
  assert.equal(hostStatus.postAccess, true, 'Existing host event-post access required; acceptance never prompts');
  await rm(join(options.output, 'target.json.focus-on-activation'), { force: true });
  const target = launch(join(targetApp, 'Contents/MacOS/AReaLComputerFixture'), [join(options.output, 'target.json')]);
  await until(async () => { try { const value = await truth('target'); return value.pid === target.pid && value.frontmost; } catch { return false; } }, 'Target fixture did not become ready');
  const app_ref = { pid: target.pid };
  await freshTurn();
  let snapshot;
  await until(async () => {
    try { snapshot = await success('get_app_state', { app_ref }); return snapshot.elements.some(row => row.identifier === 'fixture-pad'); } catch { return false; }
  }, 'Target AX observation unavailable');
  const pad = snapshot.elements.find(row => row.identifier === 'fixture-pad');
  const clickParameters = { app_ref, state_id: snapshot.state_id, target: { type: 'element', index: pad.index }, strategy: 'event', return_state: 'none' };
  const approved = await prepare('left_click', clickParameters);
  const exactPlan = JSON.stringify(approved.computerApproval.plan);
  await click(...hostStatus.button);
  if ((await rpc('fixture_status')).approvals === 0) await click(...hostStatus.button);
  assert.equal((await rpc('fixture_status')).approvals, 1, 'Untagged host click must reach the Allow once button');
  assert.equal((await rpc('status')).controlEpoch, epoch, 'Idle host input must preserve admission');
  const result = await execute(approved);
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.equal(result.structuredContent.dispatch_status, 'sent');
  assert.equal(JSON.stringify(approved.computerApproval.plan), exactPlan);
  await until(async () => (await truth('target')).events.some(event => event.type === 'mouseUp'), 'Approved event did not reach pinned target');
  assert.equal((await truth('target')).frontmost, true);
  pass('real untagged Allow once click preserves exact plan and epoch, then activates and clicks the pinned target');

  await click(...hostStatus.button);
  await until(async () => (await rpc('fixture_status')).frontmostPID === hostStatus.pid, 'Approval host did not become foreground');
  const fromHost = await prepare('key', { app_ref, text: 'a', return_state: 'none' });
  assert.notEqual((await execute(fromHost)).isError, true);
  await until(async () => (await truth('target')).events.some(event => event.type === 'keyDown'), 'Host-prepared keyboard action missing');
  pass('preparation from trusted host foreground retains external target and executes approved key');

  evidence.beforeHold = await rpc('fixture_status');
  await click(...hostStatus.button);
  const held = await prepare('key', { app_ref, text: 'shift+a', hold_seconds: 3, return_state: 'none' });
  const running = execute(held);
  await until(async () => (await rpc('status')).heldKeys > 0, 'Held key action did not start');
  await click(...hostStatus.button);
  const interrupted = await running;
  assert.equal(interrupted.isError, true);
  assert.equal(interrupted.structuredContent.dispatch_status, 'possibly_sent');
  const released = await rpc('status');
  assert.equal(released.active, false); assert.equal(released.heldKeys, 0); assert.equal(released.heldButtons, 0); assert.ok(released.controlEpoch > epoch);
  await assert.rejects(() => rpc('prepare', request('describe', {})), error => error.code === 'human_control');
  pass('untagged host input during active mutation revokes the owner and releases held keys');

  await click(pad.bounds[0] + 30, pad.bounds[1] + 40); await freshTurn();
  const dragState = await success('get_app_state', { app_ref });
  const dragPad = dragState.elements.find(row => row.identifier === 'fixture-pad');
  const dragTarget = { type: 'element', index: dragPad.index };
  const dragging = execute(await prepare('left_click_drag', { app_ref, state_id: dragState.state_id, from_target: dragTarget, to: dragTarget, modifiers: 'shift', return_state: 'none' }));
  await until(async () => { const value = await rpc('status'); return value.heldKeys > 0 && value.heldButtons > 0; }, 'Drag did not hold modifier and mouse button');
  await click(...hostStatus.button);
  const dragResult = await dragging;
  assert.equal(dragResult.isError, true); assert.equal(dragResult.structuredContent.dispatch_status, 'possibly_sent');
  const dragRelease = await rpc('status');
  assert.equal(dragRelease.active, false); assert.equal(dragRelease.heldKeys, 0); assert.equal(dragRelease.heldButtons, 0);
  assert.ok(dragRelease.controlEpoch > epoch);
  pass('untagged host input during drag releases both held modifier and mouse button');

  await click(pad.bounds[0] + 30, pad.bounds[1] + 40); await freshTurn();
  const pendingKey = await prepare('key', { app_ref, text: 'b', return_state: 'none' });
  const externalPoint = [pad.bounds[0] + 30, pad.bounds[1] + 40];
  await click(...externalPoint);
  assert.ok((await rpc('status')).controlEpoch > epoch);
  await assert.rejects(() => execute(pendingKey), error => error.code === 'human_control');
  pass('untagged external-target input revokes a pending plan and rejects the stale owner');

  await freshTurn();
  const thirdPartyPlan = await prepare('key', { app_ref, text: 'c', return_state: 'none' });
  const third = launch(join(targetApp, 'Contents/MacOS/AReaLComputerFixture'), [join(options.output, 'third.json')]);
  await until(async () => { try { const value = await truth('third'); return value.pid === third.pid && value.frontmost; } catch { return false; } }, 'Third fixture did not become foreground');
  const denied = await execute(thirdPartyPlan);
  assert.equal(denied.isError, true); assert.equal(denied.structuredContent.code, 'foreground_required');
  assert.equal(denied.structuredContent.dispatch_status, 'not_sent');
  assert.equal((await truth('third')).frontmost, true);
  assert.equal((await truth('third')).events.length, 0);
  pass('third-party foreground blocks retained plan without activation or injected input');

  third.kill('SIGTERM');
  await delay(150);
  await click(pad.bounds[0] + 30, pad.bounds[1] + 40); await freshTurn();
  const focusPlan = await prepare('key', { app_ref, text: 'z', return_state: 'none' });
  await click(...hostStatus.button);
  const beforeFocusChange = await truth('target');
  await writeFile(join(options.output, 'target.json.focus-on-activation'), 'change focused control');
  const focusChanged = await execute(focusPlan);
  assert.equal(focusChanged.isError, true, JSON.stringify(focusChanged));
  assert.equal(focusChanged.structuredContent.code, 'element_unavailable');
  assert.equal(focusChanged.structuredContent.dispatch_status, 'possibly_sent');
  await delay(150);
  const afterFocusChange = await truth('target');
  assert.equal(afterFocusChange.text, beforeFocusChange.text);
  assert.equal(afterFocusChange.events.length, beforeFocusChange.events.length);
  pass('activation that changes the retained focused control sends no key and reports uncertain activation');
  evidence.passed = true;
} catch (error) {
  evidence.passed = false; evidence.failure = { message: error.message, stack: error.stack }; throw error;
} finally {
  if (host.exitCode === null) host.stdin.write(`${JSON.stringify({ id: randomUUID(), method: 'close' })}\n`);
  await delay(150);
  for (const child of children.reverse()) { if (child.exitCode === null) child.kill('SIGTERM'); }
  lines.close();
  for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('Acceptance ended')); }
  pending.clear();
  await writeFile(join(options.output, 'result.json'), `${JSON.stringify(evidence, null, 2)}\n`);
}
process.stdout.write(`${options.output}\n`);
