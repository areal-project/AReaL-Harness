import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const text = value => typeof value === 'string' && value.trim().length > 0;
const statuses = ['completed', 'failed', 'blocked'];
function validateProvenance(value) {
  assert.ok(value && /^[a-f0-9]{40}$|^[a-f0-9]{64}$/.test(value.sourceHead), 'sourceHead is required');
  for (const field of ['diffSHA256', 'scriptSHA256', 'coreBinarySHA256'])
    assert.match(value[field] ?? '', /^[a-f0-9]{64}$/, `${field} is required`);
}
function validateCases(cases) {
  assert.ok(Array.isArray(cases) && cases.length > 0, 'planned cases are required');
  assert.equal(new Set(cases.map(c => c.id)).size, cases.length, 'duplicate case ID');
  for (const c of cases) assert.ok(text(c.id) && text(c.requirement), 'case ID and requirement are required');
}
function validateManifest(manifest) {
  assert.equal(manifest.schemaVersion, 1, 'legacy evidence requires explicit review; passed=true is not acceptance');
  assert.ok(['acceptance', 'diagnostic'].includes(manifest.runKind), 'invalid runKind');
  assert.ok(statuses.includes(manifest.executionStatus), 'invalid executionStatus');
  assert.ok(text(manifest.runId), 'runId is required');
  validateProvenance(manifest.provenance);
  validateCases(manifest.cases);
  for (const c of manifest.cases) {
    assert.ok(['passed', 'not_run'].includes(c.status), 'invalid case status');
    if (c.status === 'passed') {
      assert.ok(Array.isArray(c.assertions) && c.assertions.length > 0 && c.assertions.every(text), 'passed case requires assertions');
      assert.ok(c.observations && typeof c.observations === 'object', 'passed case requires observations');
    }
  }
}

// 每个断言边界复制事实；后续事件不得改写先前案例的证据。
export function createBrowserEvidence({ runKind, cases }) {
  assert.ok(['acceptance', 'diagnostic'].includes(runKind), 'explicit runKind is required');
  validateCases(cases);
  const records = cases.map(c => ({ ...structuredClone(c), status: 'not_run' }));
  const runId = randomUUID(), startedAt = new Date().toISOString();
  return {
    recordPass(id, { assertions, observations }) {
      const record = records.find(c => c.id === id);
      assert.ok(record && record.status === 'not_run', 'case must be planned and recorded only once');
      assert.ok(Array.isArray(assertions) && assertions.length > 0 && assertions.every(text), 'assertions are required');
      assert.ok(observations && typeof observations === 'object', 'observations are required');
      Object.assign(record, structuredClone({ status: 'passed', assertions, observations }));
    },
    finish({ executionStatus, provenance }) {
      const result = { schemaVersion: 1, runId, runKind, executionStatus, startedAt,
        finishedAt: new Date().toISOString(), provenance: structuredClone(provenance), cases: structuredClone(records) };
      validateManifest(result);
      result.acceptanceStatus = runKind === 'diagnostic' ? 'not_applicable'
        : executionStatus === 'completed' && records.every(c => c.status === 'passed') ? 'passed' : 'incomplete';
      return result;
    },
  };
}

// 汇总只回答调用者明确列出的案例；组合证据不等同于一次完整运行。
export function summarizeEvidence(manifests, requiredCases) {
  assert.ok(Array.isArray(requiredCases) && requiredCases.length > 0 && requiredCases.every(text), 'required case IDs are required');
  assert.equal(new Set(requiredCases).size, requiredCases.length, 'duplicate required case');
  assert.ok(manifests.length > 0, 'at least one manifest is required');
  manifests.forEach(validateManifest);
  assert.equal(new Set(manifests.map(m => m.runId)).size, manifests.length, 'duplicate run');
  const identity = m => JSON.stringify([m.provenance.sourceHead, m.provenance.diffSHA256, m.provenance.coreBinarySHA256]);
  assert.equal(new Set(manifests.map(identity)).size, 1, 'different candidates require review; cannot combine automatically');
  const supportedCases = requiredCases.filter(id => manifests.some(m => m.runKind === 'acceptance'
    && m.cases.some(c => c.id === id && c.status === 'passed')));
  const missingCases = requiredCases.filter(id => !supportedCases.includes(id));
  return { mode: manifests.length === 1 ? 'single' : 'composite', requiredCases, supportedCases, missingCases,
    evidenceComplete: missingCases.length === 0,
    cleanRun: manifests.length === 1 && manifests[0].runKind === 'acceptance'
      && manifests[0].executionStatus === 'completed' && manifests[0].cases.every(c => c.status === 'passed') && missingCases.length === 0,
    runs: manifests.map(m => ({ runId: m.runId, runKind: m.runKind, executionStatus: m.executionStatus })) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [required, ...paths] = process.argv.slice(2);
    assert.ok(required && paths.length, 'usage: node browser-evidence.mjs case-id[,case-id] manifest.json [...]');
    const result = summarizeEvidence(await Promise.all(paths.map(async path => JSON.parse(await readFile(path, 'utf8')))), required.split(','));
    console.log(JSON.stringify(result, null, 2));
    if (!result.evidenceComplete) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
