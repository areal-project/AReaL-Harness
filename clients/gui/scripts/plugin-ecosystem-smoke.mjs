import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scripts = dirname(fileURLToPath(import.meta.url));
const root = resolve(scripts, '../../..');
const args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--suite'), 'Usage: plugin-ecosystem-smoke.mjs [--suite all|browser|computer|creator]');
const suite = args[1] ?? 'all';
assert.ok(['all', 'browser', 'computer', 'creator'].includes(suite), 'Unknown ecosystem suite');
const binary = process.env.AREAL_CORE_BIN;
assert.ok(binary && isAbsolute(binary), 'Set AREAL_CORE_BIN to an explicit absolute deployed Core binary');
const sha = value => createHash('sha256').update(value).digest('hex');
const binaryHash = sha(await readFile(binary));
const scratch = await mkdtemp('/private/tmp/areal-plugin-ecosystem-');
const cases = [
  { id: 'browser', script: 'automation-core-smoke.mjs', args: ['--ecosystem', '--suite', 'browser'], marker: 'Automation Core evidence ', manifest: 'run-manifest.json' },
  { id: 'computer', script: 'automation-core-smoke.mjs', args: ['--ecosystem', '--suite', 'computer'], marker: 'Automation Core evidence ', manifest: 'run-manifest.json' },
  { id: 'creator', script: 'plugin-concepts-smoke.mjs', args: ['--creator-only'], marker: 'Evidence: ', manifest: 'manifest.json' },
].filter(item => suite === 'all' || suite === item.id);
const failureModes = [
  'Reviewed GUI installation or restart changes the selected package digest or exact Skill reference.',
  'Try starts inference or creates an execution thread before Send.',
  'A selected Skill never reaches the model request before the requested real Core tool result.',
  'A missing native host tool or disabled computer control presents available readiness or allows Try.',
  'Browser mutation does not change the controlled native DOM and reach the fixture server exactly once.',
  'Denied browser input is replayed after a read or renderer reconnect.',
  'Creator uses a copied replacement instead of the verified official builtin Skill and its Runtime scripts.',
  'Stale or UNKNOWN writes replay. This combined suite does not yet inject those failures.',
];
const results = [];
const errors = [];
const startedAt = new Date().toISOString();
console.log(`Plugin ecosystem evidence ${scratch}`);
for (const scenario of cases) {
  let stdout = '', stderr = '';
  const invocation = [process.execPath, join(scripts, scenario.script), ...scenario.args];
  console.log(`Running ${scenario.id}: ${invocation.join(' ')}`);
  const child = spawn(invocation[0], invocation.slice(1), { cwd: root, env: { ...process.env, AREAL_CORE_BIN: binary }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => { stdout += chunk; process.stdout.write(chunk); });
  child.stderr.on('data', chunk => { stderr += chunk; process.stderr.write(chunk); });
  let spawnError;
  child.on('error', error => { spawnError = error; });
  const { code, signal } = await new Promise(resolve => child.on('close', (code, signal) => resolve({ code, signal })));
  await writeFile(join(scratch, `${scenario.id}.stdout.log`), stdout);
  await writeFile(join(scratch, `${scenario.id}.stderr.log`), stderr);
  const evidence = stdout.split('\n').find(line => line.startsWith(scenario.marker))?.slice(scenario.marker.length).trim();
  const result = { id: scenario.id, invocation, code, signal, evidence, passed: false };
  results.push(result);
  let cleanupConfirmed = false;
  try {
    assert.ifError(spawnError);
    assert.ok(evidence && isAbsolute(evidence), 'child must announce its attributable evidence directory');
    result.manifest = join(evidence, scenario.manifest);
    const manifest = JSON.parse(await readFile(result.manifest, 'utf8'));
    cleanupConfirmed = scenario.id === 'creator'
      ? manifest.cleanup?.desktopStopped === true && manifest.cleanup?.coreStopped === true
      : manifest.events?.cleanup?.electronStopped === true && (manifest.events?.cleanup?.applicationStopped === true || manifest.events?.cleanup?.assistedServiceStop === true);
    assert.ok(cleanupConfirmed, 'owned Electron and application services must stop before the next child starts');
    assert.equal(code, 0, `${scenario.id} child exit must be zero`);
    assert.equal(signal, null);
    assert.equal(manifest.passed, true);
    result.checks = manifest.checks;
    result.gaps = manifest.gaps ?? [];
    if (scenario.id !== 'creator') {
      const selected = manifest.events?.ecosystem;
      assert.ok(selected?.selections?.length > 0, 'combined automation child must execute a GUI-selected package Skill');
      assert.equal(selected.pluginId, `${scenario.id}-control@areal-adapters`);
      assert.ok(manifest.events.modelCalls.some(call => call.scenario === `${scenario.id}-describe` && call.toolNames.includes(`${scenario.id}_v1`)), 'actual model catalog includes required host tool in selected Skill thread');
      assert.ok(manifest.events.histories[`${scenario.id}-describe`], 'actual Core history retains required host tool result');
      result.selection = selected.selections;
      if (scenario.id === 'browser') {
        assert.equal(manifest.siteFacts.effects.length, 1, 'selected-plugin browser path changes the controlled server exactly once');
        assert.ok(manifest.checks.includes('browser-durable-results-no-replay'));
      } else assert.ok(manifest.checks.includes('ecosystem-disabled-computer-try-blocked'));
    } else {
      assert.equal(manifest.creator?.skill?.id, 'openai-skill-creator');
      assert.ok(manifest.creator?.provenance?.contentDigest, 'Creator uses verified existing builtin provenance');
      assert.ok(manifest.checks.some(check => check.includes('official Creator init and validation through Runtime')));
    }
    result.passed = true;
  } catch (error) {
    result.error = error.stack ?? String(error);
    errors.push({ id: scenario.id, error: result.error });
  }
  if (!cleanupConfirmed) {
    errors.push({ id: scenario.id, error: 'Further children were not started because cleanup could not be verified. Retain the child evidence and isolated state for diagnosis.' });
    break;
  }
}
const coreUnchanged = await readFile(binary).then(bytes => sha(bytes) === binaryHash, error => { errors.push({ error: error.message }); return false; });
if (!coreUnchanged) errors.push({ error: 'The deployed Core binary changed during the suite.' });
const manifest = {
  passed: errors.length === 0 && results.length === cases.length && results.every(result => result.passed), suite, startedAt, endedAt: new Date().toISOString(),
  sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  diffSHA256: sha(execFileSync('git', ['diff', 'HEAD'], { cwd: root, maxBuffer: 32 * 1024 * 1024 })),
  coreBinary: binary, coreBinarySHA256: binaryHash, coreUnchanged, results, errors, failureModes,
  scope: 'Source Electron GUI installation and selection, actual Core Skill content and host tool execution, controlled native browser DOM effects, disabled native admission, existing official Creator through actual Runtime. Each child owns a different temporary home, registry and workspace. The model, local site and native path chooser are fixtures.',
  gaps: ['No combined selected-plugin stale-reference or UNKNOWN receipt-loss injection.', 'No physical native computer input, OS grant acquisition, real-provider, public-site, installed-package or signing acceptance.'],
};
await writeFile(join(scratch, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ passed: manifest.passed, evidence: scratch, suites: results.map(({ id, passed, evidence }) => ({ id, passed, evidence })), errors }, null, 2));
if (!manifest.passed) process.exitCode = 1;
