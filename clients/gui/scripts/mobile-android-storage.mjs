import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../../../", import.meta.url));
const serial = process.env.AREAL_ANDROID_SERIAL;
assert.ok(serial?.startsWith("emulator-"), "AREAL_ANDROID_SERIAL must select an isolated emulator");
const adb = process.env.AREAL_ANDROID_ADB ?? "adb";
const run = async (command, args) => {
  const result = await exec(command, args, { cwd: root, maxBuffer: 16 * 1024 * 1024 });
  process.stdout.write(result.stdout);
  return result.stdout;
};
await run("clients/mobile/android/gradlew", [
  "-p",
  "clients/mobile/android",
  ":app:assembleDebug",
  ":app:assembleDebugAndroidTest",
]);
await run(adb, [
  "-s",
  serial,
  "install",
  "-r",
  "clients/mobile/android/app/build/outputs/apk/debug/app-debug.apk",
]);
await run(adb, [
  "-s",
  serial,
  "install",
  "-r",
  "clients/mobile/android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk",
]);
for (const stage of ["save", "restore", "all"]) {
  await run(adb, ["-s", serial, "shell", "am", "force-stop", "com.example.arealharness.debug"]);
  const output = await run(adb, [
    "-s",
    serial,
    "shell",
    "am",
    "instrument",
    "-w",
    "-r",
    "-e",
    "class",
    "com.example.arealharness.AndroidDeviceStoreTest",
    "-e",
    "stage",
    stage,
    "com.example.arealharness.debug.test/androidx.test.runner.AndroidJUnitRunner",
  ]);
  assert.match(output, /OK \(1 test\)/, `Native encrypted storage failed at ${stage}`);
  assert.doesNotMatch(output, /FAILURES|INSTRUMENTATION_FAILED/);
}
