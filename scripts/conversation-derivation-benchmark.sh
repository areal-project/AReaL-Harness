#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
python3 - "${1:-.scratch/scf-evidence/SCF14-performance.md}" <<'PY'
import datetime, hashlib, json, pathlib, platform, resource, subprocess, sys, time
report = pathlib.Path(sys.argv[1]).resolve()
report.parent.mkdir(parents=True, exist_ok=True)
log = report.with_suffix('.log')
def command(args):
    return subprocess.run(args, capture_output=True, text=True).stdout.strip()
fixture = pathlib.Path('core/app-server/tests/fork.rs')
manifest = {
    'utc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'sourceCommit': command(['git', 'rev-parse', 'HEAD']),
    'trackedDiffSha256': hashlib.sha256(subprocess.check_output(['git', 'diff', '--binary', 'HEAD'])).hexdigest(),
    'benchmarkSha256': hashlib.sha256(pathlib.Path('scripts/conversation-derivation-benchmark.sh').read_bytes()).hexdigest(),
    'sourceDirty': bool(command(['git', 'status', '--porcelain'])),
    'fixtureSha256': hashlib.sha256(fixture.read_bytes()).hexdigest(),
    'lockSha256': hashlib.sha256(pathlib.Path('Cargo.lock').read_bytes()).hexdigest(),
    'machine': platform.platform(), 'architecture': platform.machine(),
    'rust': command(['rustc', '--version']),
    'memoryScope': 'getrusage RUSAGE_CHILDREN maximum RSS covers terminated children of this wrapper, including environment commands and cargo/test compilation; it does not attribute memory to each fork',
    'fixture': 'real Engine/Store/WebSocket RPC with deterministic in-process text model; no HTTP/provider/native Runtime/Electron measurement',
    'nativeRuntime': 'not attached; native tool progress and process resources not measured',
}
if sys.platform == 'darwin':
    manifest['physicalMemoryBytes'] = command(['sysctl', '-n', 'hw.memsize']) or 'unavailable in sandbox'
else:
    manifest['physicalMemory'] = command(['getconf', '_PHYS_PAGES']) + ' pages of ' + command(['getconf', 'PAGE_SIZE']) + ' bytes'
args = ['cargo', 'test', '--locked', '-p', 'areal-app-server', '--test', 'fork', 'conversation_derivation_capacity_benchmark', '--', '--ignored', '--nocapture', '--test-threads=1']
manifest['command'] = args
with log.open('w') as output:
    output.write('AC77_MANIFEST ' + json.dumps(manifest) + '\n')
    output.flush()
    started = time.monotonic()
    result = subprocess.run(args, stdout=output, stderr=subprocess.STDOUT)
    measurement = {'wallSeconds': time.monotonic() - started, 'maximumChildRssBytes': resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss * (1 if sys.platform == 'darwin' else 1024)}
    output.write('AC77_WRAPPER_RESOURCES ' + json.dumps(measurement) + '\n')
text = log.read_text()
samples = [json.loads(line.split('AC77_SAMPLE ', 1)[1]) for line in text.splitlines() if 'AC77_SAMPLE ' in line]
capacity = [json.loads(line.split(' ', 1)[1]) for line in text.splitlines() if line.startswith('AC77_CAPACITY ')]
reclaim = [json.loads(line.split(' ', 1)[1]) for line in text.splitlines() if line.startswith('AC77_RECLAIM ')]
sample_counts = {name: len([s for s in samples if s['size'] == name]) for name in ['small', 'medium', 'near_limit']}
if result.returncode == 0 and (any(count != 5 for count in sample_counts.values()) or len(capacity) != 3 or len(reclaim) != 1):
    raise RuntimeError('incomplete benchmark evidence: ' + repr(sample_counts))
body = ['# SCF14 AC77 measured capacity', '', f'Exit code: {result.returncode}. Raw log: `{log}`.', '', '```json', json.dumps(manifest, indent=2), '```', '', 'Maximum child RSS (whole wrapper scope): ' + str(measurement['maximumChildRssBytes']) + ' bytes. Wall duration: ' + str(measurement['wallSeconds']) + ' seconds.', '', '| Fixture | Prefix bytes | Items | Creation microseconds (five raw samples) |', '| --- | ---: | ---: | --- |']
for name in ['small', 'medium', 'near_limit']:
    rows = [s for s in samples if s['size'] == name]
    if rows:
        body.append(f"| {name} | {rows[0]['prefixBytes']} | {rows[0]['prefixItems']} | {', '.join(str(s['creationMicros']) for s in rows)} |")
body += ['', 'Side admission / source release measurements:', '', '```json', json.dumps(capacity, indent=2), '```', '', 'Rejected target / snapshot reclaim:', '', '```json', json.dumps(reclaim, indent=2), '```', '', 'These raw samples establish fixture behavior and measured durations only. No p95 or production SLA is inferred. Source progress measures a deterministic model barrier release, not a native tool. Snapshot-size rejection beyond the configured history byte limit is not exercised here; the public source turn admission uses that same limit. Target-capacity rejection after staging and Side-slot rejection/reclaim are measured.']
report.write_text('\n'.join(body) + '\n')
print(report)
print(log)
sys.exit(result.returncode)
PY
