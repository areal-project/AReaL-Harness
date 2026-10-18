"""故障收敛只接受连接拒绝，不能放宽真实终态或隐藏普通状态查询错误。"""

import subprocess
import unittest
from pathlib import Path


HELPER = (Path(__file__).resolve().parents[1] / "local-service-wait.mjs").as_uri()


class LocalServiceWaitTests(unittest.TestCase):
    def run_node(self, body):
        result = subprocess.run(
            [
                "node",
                "--input-type=module",
                "-e",
                f"""import assert from 'node:assert/strict';
import {{ waitForFaultStatus }} from {HELPER!r};
function refused(errno = 61) {{
  return Object.assign(new Error('controlled refusal'), {{
    code: 1, killed: false, signal: null, stdout: '',
    stderr: JSON.stringify({{error: {{code: 'localServiceError',
      message: `Connection refused (os error ${{errno}})`}}}}),
  }});
}}
{body}
""",
            ],
            capture_output=True,
            text=True,
            timeout=10,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_refused_during_cleanup_must_reach_expected_state(self):
        self.run_node("""
const remaining = [];
let calls = 0, refusals = 0;
const result = await waitForFaultStatus(async (budget) => {
  remaining.push(budget);
  calls++;
  if (calls < 3) throw refused(calls === 1 ? 61 : 111);
  return { state: calls === 3 ? 'stopping' : 'stopped', generation: 'same' };
}, 'stopped', { timeoutMs: 2000, onRefused: () => refusals++ });
assert.deepEqual(result, {state: 'stopped', generation: 'same'});
assert.equal(calls, 4);
assert.equal(refusals, 2);
assert(remaining.every((value) => value > 0 && value <= 2000));
assert(remaining[3] < remaining[0]);
""")

    def test_unrecognized_errors_fail_immediately_without_retry(self):
        self.run_node("""
const cases = [
  {stderr: 'Connection refused (os error 61)'},
  {stderr: JSON.stringify({error: {code: 'other', message: 'Connection refused (os error 61)'}})},
  {stderr: JSON.stringify({error: {code: 'localServiceError', message: 'Permission denied (os error 13)'}})},
  {stderr: JSON.stringify({error: {code: 'localServiceError', message: 'invalid service record'}})},
  {code: 2}, {killed: true}, {signal: 'SIGTERM'}, {stdout: 'unexpected output'},
];
for (const fields of cases) {
  const error = Object.assign(refused(), fields);
  let calls = 0, refusals = 0;
  await assert.rejects(waitForFaultStatus(async () => {
    calls++; throw error;
  }, 'stopped', {onRefused: () => refusals++}), (actual) => actual === error);
  assert.equal(calls, 1);
  assert.equal(refusals, 0);
}
""")

    def test_exact_loopback_probe_refusal_reaches_expected_state(self):
        self.run_node("""
for (const url of [
  'http://127.0.0.1:49412/areal/service',
  'http://[::1]:1/areal/service',
  'http://127.0.0.1:65535/areal/service',
]) {
  for (const errno of [61, 111]) {
    let calls = 0, refusals = 0;
    const error = refused(errno);
    error.stderr = JSON.stringify({error: {code: 'localServiceError',
      message: `error sending request for url (${url}): client error (Connect): tcp connect error: Connection refused (os error ${errno})`}});
    const result = await waitForFaultStatus(async () => {
      if (++calls === 1) throw error;
      return {state: 'stopped'};
    }, 'stopped', {onRefused: () => refusals++});
    assert.equal(result.state, 'stopped');
    assert.equal(calls, 2);
    assert.equal(refusals, 1);
  }
}
""")

    def test_probe_wrapper_rejects_other_urls_errors_and_suffixes(self):
        self.run_node("""
const wrap = (url) => `error sending request for url (${url}): client error (Connect): tcp connect error: Connection refused (os error 61)`;
const valid = wrap('http://127.0.0.1:49412/areal/service');
const messages = [
  ...[
    'http://example.invalid:49412/areal/service',
    'http://127.0.0.1.example.invalid:49412/areal/service',
    'http://127.0.0.2:49412/areal/service',
    'http://localhost:49412/areal/service',
    'https://127.0.0.1:49412/areal/service',
    'http://127.0.0.1:49412/areal/auth/bootstrap',
    'http://127.0.0.1:49412/areal/service/extra',
    'http://127.0.0.1:49412/areal/service?token=fixture',
    'http://127.0.0.1:49412/areal/service#fragment',
    'http://fixture@127.0.0.1:49412/areal/service',
    'http://127.0.0.1:0/areal/service',
    'http://127.0.0.1:65536/areal/service',
    'http://127.0.0.1:049412/areal/service',
    'http://127.0.0.1/areal/service',
    'http://127.0.0.1:49412/areal/service\\n',
  ].map(wrap),
  valid + ': unrelated error', valid + '\\n',
  valid.replace('(Connect)', '(Request)'),
  valid.replace('Connection refused (os error 61)', 'operation timed out'),
  valid.replace('os error 61', 'os error 13'),
  'HTTP status client error (401 Unauthorized) for url (http://127.0.0.1:49412/areal/service)',
  'Connection refused (os error 61)\\n',
];
for (const message of messages) {
  const error = refused();
  error.stderr = JSON.stringify({error: {code: 'localServiceError', message}});
  let calls = 0;
  await assert.rejects(waitForFaultStatus(async () => {
    calls++; throw error;
  }, 'stopped'), (actual) => actual === error);
  assert.equal(calls, 1);
}
""")

    def test_permanent_refusal_wrong_state_and_late_success_fail(self):
        self.run_node("""
for (const query of [
  async () => { throw refused(); },
  async () => ({state: 'unavailable'}),
  async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    return {state: 'stopped'};
  },
]) {
  await assert.rejects(
    waitForFaultStatus(query, 'stopped', {timeoutMs: 10}),
    /service did not reach stopped within 10 ms/,
  );
}
""")
