import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') throw new Error('Native monitor denial acceptance requires macOS; unsupported is not a pass');
const local = dirname(fileURLToPath(import.meta.url));
const native = resolve(local, '..');
const output = resolve(process.argv[2] || join(native, 'build/monitor-denied'));
mkdirSync(output, { recursive: true });
const binary = join(output, 'MonitorDenied');
const sources = readdirSync(join(native, 'Sources')).filter(name => name.endsWith('.swift') && name !== 'main.swift').sort().map(name => join(native, 'Sources', name));
execFileSync('xcrun', ['swiftc', '-swift-version', '5', '-O', '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macosx14.0`,
  '-module-cache-path', join(native, 'build/module-cache'), ...sources, join(local, 'MonitorDenied.swift'), '-o', binary,
  '-framework', 'AppKit', '-framework', 'ApplicationServices', '-framework', 'ScreenCaptureKit'], { stdio: 'inherit' });
const result = JSON.parse(execFileSync(binary, [], { encoding: 'utf8' }));
assert.equal(result.passed, true);
assert.equal(result.mutations.length, 9);
writeFileSync(join(output, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`PASS all 9 native mutations deny an unavailable monitor without app lookup or input\n${output}\n`);
