import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBrowserEvidence, summarizeEvidence } from './browser-evidence.mjs';

const provenance = { sourceHead: 'a'.repeat(40), diffSHA256: 'b'.repeat(64),
  scriptSHA256: 'c'.repeat(64), coreBinarySHA256: 'd'.repeat(64) };
const cases = [{ id: 'B-04.same-page', requirement: 'B-04' },
  { id: 'B-05.forged-receipt', requirement: 'B-05' }];
const proof = { assertions: ['wrong socket cannot settle the actual in-flight ID'],
  observations: { requestId: 42, posts: 0 } };
function run(kind = 'acceptance', ids = cases.map(c => c.id), status = 'completed') {
  const recorder = createBrowserEvidence({ runKind: kind, cases });
  ids.forEach(id => recorder.recordPass(id, proof));
  return recorder.finish({ executionStatus: status, provenance });
}

test('a completed diagnostic never counts as acceptance', () => {
  const manifest = run('diagnostic');
  assert.equal(manifest.acceptanceStatus, 'not_applicable');
  const result = summarizeEvidence([manifest], cases.map(c => c.id));
  assert.deepEqual(result.supportedCases, []);
  assert.equal(result.evidenceComplete, false);
});

test('case facts are copied at the assertion boundary', () => {
  const recorder = createBrowserEvidence({ runKind: 'acceptance', cases });
  const facts = structuredClone(proof);
  recorder.recordPass(cases[0].id, facts);
  facts.observations.posts = 3;
  const result = recorder.finish({ executionStatus: 'failed', provenance });
  assert.equal(result.cases[0].observations.posts, 0);
  assert.equal(result.cases[1].status, 'not_run');
  assert.equal(result.acceptanceStatus, 'incomplete');
});

test('requires unique planned case IDs, assertions and source identity', () => {
  assert.throws(() => createBrowserEvidence({ runKind: 'acceptance', cases: [cases[0], cases[0]] }));
  const recorder = createBrowserEvidence({ runKind: 'acceptance', cases });
  assert.throws(() => recorder.recordPass('unplanned', proof));
  assert.throws(() => recorder.recordPass(cases[0].id, { observations: {} }));
  recorder.recordPass(cases[0].id, proof);
  assert.throws(() => recorder.recordPass(cases[0].id, proof));
  assert.throws(() => recorder.finish({ executionStatus: 'completed', provenance: {} }));
});

test('legacy passed=true and missing cases fail closed', () => {
  assert.throws(() => summarizeEvidence([{ passed: true, checks: ['B-11 focused diagnostic'] }], ['B-11.reload']));
  const result = summarizeEvidence([run('acceptance', [cases[0].id])], cases.map(c => c.id));
  assert.equal(result.evidenceComplete, false);
  assert.deepEqual(result.missingCases, [cases[1].id]);
});

test('composite evidence retains failed runs and does not become a clean full run', () => {
  const manifests = [run('acceptance', [cases[0].id], 'failed'), run('acceptance', [cases[1].id])];
  const result = summarizeEvidence(manifests, cases.map(c => c.id));
  assert.equal(result.evidenceComplete, true);
  assert.equal(result.mode, 'composite');
  assert.equal(result.cleanRun, false);
  assert.deepEqual(result.runs.map(r => r.executionStatus), ['failed', 'completed']);
});

test('different candidates cannot silently combine and diagnostics cannot supply missing cases', () => {
  const left = run('acceptance', [cases[0].id]);
  const right = run('acceptance', [cases[1].id]);
  right.provenance.sourceHead = 'e'.repeat(40);
  assert.throws(() => summarizeEvidence([left, right], cases.map(c => c.id)));
  assert.equal(summarizeEvidence([left, run('diagnostic')], cases.map(c => c.id)).evidenceComplete, false);
});

test('a complete single acceptance run is identified only for its requested cases', () => {
  const result = summarizeEvidence([run()], cases.map(c => c.id));
  assert.equal(result.evidenceComplete, true);
  assert.equal(result.cleanRun, true);
  assert.deepEqual(result.requiredCases, cases.map(c => c.id));
  assert.throws(() => summarizeEvidence([run()], []));
});
