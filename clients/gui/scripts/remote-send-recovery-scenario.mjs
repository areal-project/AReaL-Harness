import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export async function recoverSentEffect({
  a,
  threadId,
  control,
  settled,
  workspace,
  afterUnknown,
}) {
  const effect = randomUUID(),
    sendId = randomUUID(),
    params = { threadId, expectedConfigRevision: 1, text: `RC05_EFFECT:${effect}` };
  await control("fault", "lost-native-response");
  assert.equal((await a.rpc("session.send", params, sendId)).result.admissionState, "unknown");
  if (afterUnknown) await afterUnknown({ effect, sendId, params });
  const receipt = (await a.rpc("command.read", { commandId: sendId })).result;
  assert.equal(receipt.admissionState, "accepted");
  assert.equal((await a.rpc("session.send", params, sendId)).result.turnId, receipt.turnId);
  await settled(threadId);
  assert.equal(await readFile(join(workspace, "effects", effect), "utf8"), "x");
  assert.equal(
    (await a.rpc("session.send", { ...params, text: "changed" }, sendId)).error.code,
    "COMMAND_CONFLICT",
  );
  return { effect, sendId, params, receipt };
}
