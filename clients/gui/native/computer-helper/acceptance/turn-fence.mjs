import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const local = dirname(fileURLToPath(import.meta.url));
const { ComputerControl } = createRequire(import.meta.url)(join(local, '../../../app/src/core/computer-control.cjs'));
const output = process.argv[2] ? resolve(process.argv[2]) : await mkdtemp(join(tmpdir(), 'areal-computer-turn-fence-'));
await import('node:fs/promises').then(fs => fs.mkdir(output, { recursive: true }));
const trigger = join(output, 'trigger.json');
const audit = join(output, 'transport.jsonl');
const helper = join(output, 'protocol-fixture');
function protocolFixture(trigger, audit) {
  const fs = require('node:fs');
  const readline = require('node:readline');
  let epoch = 1;
  const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
  const status = () => ({ available: true, ready: true, controlEpoch: epoch, helperGeneration: String(process.pid), active: false });
  const stop = () => { epoch += 1; send({ event: 'activity', status: { ...status(), lastStopReason: 'Protocol fixture Stop' } }); };
  readline.createInterface({ input: process.stdin }).on('line', line => {
    const { id, method, params } = JSON.parse(line);
    fs.appendFileSync(audit, `${JSON.stringify({ method, params })}\n`);
    let instruction;
    try { instruction = JSON.parse(fs.readFileSync(trigger, 'utf8')); fs.unlinkSync(trigger); } catch {}
    if (instruction?.takeover) stop();
    if (method === 'stop') stop();
    if (instruction?.hold) return;
    if (['prepare', 'execute'].includes(method) && params.arguments.operation !== 'stop_computer_control' && params.admissionEpoch !== epoch) {
      send({ id, ok: false, error: { code: 'human_control', message: 'Stale native admission epoch', action_sent: false, dispatch_status: 'not_sent' } });
      return;
    }
    let result = status();
    if (method === 'prepare') result = { preparedActionId: id, operation: params.arguments.operation, controlEpoch: epoch };
    if (method === 'execute') {
      if (params.arguments.operation === 'stop_computer_control') stop();
      result = { structuredContent: { stopped: true, action_sent: false, dispatch_status: 'not_sent' } };
    }
    send({ id, ok: true, result });
  });
}
await writeFile(helper, `#!${process.execPath}\n(${protocolFixture.toString()})(${JSON.stringify(trigger)},${JSON.stringify(audit)});\n`);
await chmod(helper, 0o700);
let enabled = true;
const host = new ComputerControl({ helperPath: helper, getEnabled: () => enabled });
const identity = { coreInstanceId: randomUUID(), coreGeneration: randomUUID(), projectId: randomUUID(), threadId: randomUUID(), toolHostGeneration: randomUUID() };
const request = (turnId, operation = 'get_app_state', extra = {}) => ({ ...identity, turnId, callId: randomUUID(), arguments: { operation, parameters: {} }, ...extra });
const checks = [];
const pass = name => { checks.push(name); process.stdout.write(`PASS ${name}\n`); };
const denied = call => assert.rejects(async () => host.prepare(call), error => error.code === 'human_control' && error.dispatch_status === 'not_sent');
try {
  const first = request(randomUUID());
  await host.prepare(first);
  await host.stop('UI Stop');
  await denied(first);
  await denied({ ...first, callId: randomUUID(), toolHostGeneration: randomUUID() });
  assert.equal((await host.status()).available, true);
  await host.prepare(request(first.turnId, 'stop_computer_control'));
  pass('UI Stop fences a turn across calls and tool host generations; status and Stop remain available');
  const second = request(randomUUID());
  await host.prepare(second);
  const modelStop = request(second.turnId, 'stop_computer_control');
  const stopPlan = await host.prepare(modelStop);
  await host.execute({ ...modelStop, computerApproval: { plan: stopPlan } });
  await denied(second);
  pass('model Stop fences the old turn and a fresh trusted turn can enter');
  const disabled = request(randomUUID());
  enabled = false;
  await assert.rejects(async () => host.prepare(disabled), error => error.code === 'not_authorized');
  enabled = true;
  await denied(disabled);
  const restarting = request(randomUUID());
  await host.prepare(restarting);
  await host.restart();
  await denied(restarting);
  await denied(first);
  pass('disable and helper restart preserve the Main turn fence');
  const observed = request(randomUUID());
  await host.prepare(observed);
  await writeFile(trigger, JSON.stringify({ takeover: true }));
  await denied(observed);
  await denied(observed);
  await host.prepare(request(randomUUID()));
  pass('native takeover fences the observed turn and racing stale epoch before fresh admission');
  const cancelled = request(randomUUID());
  const controller = new AbortController();
  await writeFile(trigger, JSON.stringify({ hold: true }));
  const waiting = host.prepare({ ...cancelled, signal: controller.signal });
  const cancellation = assert.rejects(waiting, error => ['control_stopped', 'human_control'].includes(error.code));
  setTimeout(() => controller.abort(), 25);
  await cancellation;
  await denied(cancelled);
  pass('Core cancellation fences its turn while the independent control lane remains responsive');
  for (const reason of ['window_closed', 'ui_crashed']) {
    const owner = request(randomUUID());
    await host.prepare(owner); await host.stop(reason); await denied(owner);
  }
  pass('window and renderer loss fence previously admitted turns');
  let capacity;
  for (let i = 0; i < 4097; i += 1) {
    try { await host.prepare(request(randomUUID())); }
    catch (error) { if (error.code !== 'owner_capacity') throw error; capacity = error; break; }
  }
  assert.ok(capacity);
  assert.equal(capacity.action_sent, false);
  assert.equal((await host.status()).ownerFence.capacityReached, true);
  await denied(first);
  await host.stop('Capacity acceptance complete');
  await assert.rejects(async () => host.prepare(request(randomUUID())), error => error.code === 'owner_capacity');
  pass('bounded owner history fails closed without evicting revoked turns');
  const lines = (await readFile(audit, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.ok(lines.filter(line => line.method === 'prepare' && line.params.arguments.operation !== 'stop_computer_control').every(line => Number.isInteger(line.params.admissionEpoch)));
  await writeFile(join(output, 'result.json'), `${JSON.stringify({ passed: true, checks, transportRequests: lines.length, scope: 'Node host with private JSON-line protocol fixture; no OS input or permissions used' }, null, 2)}\n`);
} finally { await host.close(); }
process.stdout.write(`${output}\n`);
