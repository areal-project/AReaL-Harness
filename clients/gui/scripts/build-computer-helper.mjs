import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const gui = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
let output = join(gui, 'native/computer-helper/build/AReaL Computer Helper.app');
let fixture = false;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--output' && args[i + 1]) output = resolve(args[++i]);
  else if (args[i] === '--fixture') fixture = true;
  else throw new Error(`Unknown build option: ${args[i]}`);
}
if (process.platform !== 'darwin') {
  process.stdout.write('Computer helper build skipped. Native computer control requires macOS 14 or later.\n');
  process.exit(0);
}
if (!['arm64', 'x64'].includes(process.arch)) throw new Error('The computer helper requires a macOS arm64 or x64 build host');
if (!output.endsWith('.app')) throw new Error('--output must name an .app bundle');
const executable = fixture ? 'AReaLComputerFixture' : 'AReaLComputerHelper';
const bundleId = fixture ? 'com.areal.harness.computer-fixture' : 'com.areal.harness.computer-helper';
const displayName = fixture ? 'AReaL Computer Fixture' : 'AReaL Computer Helper';
const native = join(gui, 'native/computer-helper');
const sources = fixture ? [join(native, 'acceptance/Fixture.swift')]
  : readdirSync(join(native, 'Sources')).filter(name => name.endsWith('.swift')).sort().map(name => join(native, 'Sources', name));
const macos = join(output, 'Contents/MacOS');
mkdirSync(macos, { recursive: true });
mkdirSync(join(output, 'Contents/Resources'), { recursive: true });
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${bundleId}</string>
<key>CFBundleName</key><string>${displayName}</string>
<key>CFBundleDisplayName</key><string>${displayName}</string>
<key>CFBundleExecutable</key><string>${executable}</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundleShortVersionString</key><string>1.0</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>LSUIElement</key>${fixture ? '<false/>' : '<true/>'}
<key>NSHighResolutionCapable</key><true/>
<key>NSPrincipalClass</key><string>NSApplication</string>
<key>NSAccessibilityUsageDescription</key><string>Control the application you approve in AReaL.</string>
<key>NSScreenCaptureUsageDescription</key><string>Observe the window you select in AReaL.</string>
</dict></plist>
`;
writeFileSync(join(output, 'Contents/Info.plist'), plist);
const arch = process.arch === 'x64' ? 'x86_64' : 'arm64';
const cache = join(native, 'build/module-cache');
mkdirSync(cache, { recursive: true });
execFileSync('xcrun', ['swiftc', '-swift-version', '5', '-O', '-target', `${arch}-apple-macosx14.0`,
  '-module-cache-path', cache, ...sources, '-o', join(macos, executable),
  '-framework', 'AppKit', '-framework', 'ApplicationServices', '-framework', 'ScreenCaptureKit'], { stdio: 'inherit' });
if (!fixture) writeFileSync(join(output, 'Contents/Resources/NOTICE'), readFileSync(join(native, 'NOTICE')));
execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', bundleId, '--timestamp=none', output], { stdio: 'inherit' });
execFileSync('/usr/bin/codesign', ['--verify', '--strict', output], { stdio: 'inherit' });
process.stdout.write(`${output}\n`);
