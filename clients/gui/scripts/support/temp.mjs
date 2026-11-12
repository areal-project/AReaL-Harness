import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { trackedMkdtemp } from "./host-cleanup.cjs";

export async function makeTempDir(prefix) {
  return realpath(await trackedMkdtemp(join(tmpdir(), prefix)));
}
