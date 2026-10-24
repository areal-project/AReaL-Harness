import assert from "node:assert/strict";
import { mkdir, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { createProjectConversation, selectConversation } from "./smoke-navigation.mjs";

const textOf = message => typeof message.content === "string" ? message.content
  : (message.content ?? []).map(part => part.text ?? "").join("\n");
export function composerFilesResponse(body, response, fixture) {
  const messages = body.messages ?? body.input ?? [];
  const last = messages.findLastIndex(message => message.role === "user"
    && !textOf(message).startsWith("AReaL runtime context (not a user request):"));
  const text = textOf(messages[last] ?? {});
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  if (body.input) {
    response.end([
      { type: "response.output_text.delta", delta: "FILES_OK" },
      { type: "response.completed", response: { status: "completed", output: [{ type: "message", role: "assistant", id: "files-message", content: [{ type: "output_text", text: "FILES_OK" }] }], usage: { input_tokens: 12, output_tokens: 2 } } },
    ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(""));
    return;
  }
  const send = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: "files", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  if (text.includes("FILES_LIVE_DIRECTORY") && !messages.slice(last + 1).some(message => message.role === "tool")) {
    send({ tool_calls: [{ index: 0, id: "files-read", type: "function", function: { name: "fs_read", arguments: JSON.stringify({ path: "workspace://repo/目录/now.txt" }) } }] });
    send({}, "tool_calls");
    response.end("data: [DONE]\n\n");
    return;
  }
  const finish = () => { send({ content: "FILES_OK" }); send({}, "stop"); response.end("data: [DONE]\n\n"); };
  if (text.includes("FILES_HOLD")) {
    send({ content: "FILES_WAIT" });
    fixture.held.add(finish);
    response.on("close", () => fixture.held.delete(finish));
  } else finish();
}

export async function runComposerFilesAcceptance({ app, page, pid, workspace, scratch, endpoint, desktop, call, state, project, until, received, checks, shot, fixture }) {
  const input = () => page.getByTestId("chat-input");
  const button = name => page.getByRole("button", { name, exact: true });
  const activeId = async () => page.getByTestId("areal-workbench").getAttribute("data-thread-id");
  const current = async () => project(await state()).state.threads[await activeId()];
  const send = async text => {
    if (text !== undefined) await input().fill(text);
    const count = received.length;
    await button("发送").click();
    await until(async () => received.length > count && (await current())?.turns.at(-1)?.status === "completed"
      && !project(await state()).pending.length, "file input completed");
    await page.waitForFunction(() => !document.querySelector('[data-testid="chat-input"]')?.textContent);
    return (await current()).turns.at(-1);
  };
  const users = body => (body.messages ?? body.input).filter(message => message.role === "user"
    && !textOf(message).startsWith("AReaL runtime context (not a user request):")).map(textOf);
  const original = "PKG_CONFIG=中文\nexport const text = `原文 <xml> \\n`;\n";
  await page.locator("input[type=file]").setInputFiles({ name: "中文.ts", mimeType: "application/typescript", buffer: Buffer.from(original) });
  await shot("files-text-card-draft");
  let turn = await send("FILES_FIRST");
  const tid = await activeId();
  const file = turn.items.find(item => item.type === "userMessage").content.find(part => part.type === "file");
  assert.equal(file.name, "中文.ts"); assert.equal(file.mime_type, "text/plain");
  assert(users(received.at(-1)).at(-1).includes(original));
  const bytes = await call("media", { projectId: pid, threadId: tid, operation: "read", uri: file.url });
  assert.equal(Buffer.from(Object.values(bytes.bytes)).toString("utf8"), original);
  checks.push("new-draft picker fixture transfers named UTF-8 source as original File/blob, complete text reaches Chat Completions");

  const injectFile = async (kind, name, mime, text) => input().evaluate((element, fixture) => {
    const transfer = new DataTransfer(); transfer.items.add(new File([fixture.text], fixture.name, { type: fixture.mime }));
    const event = fixture.kind === "paste" ? new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true })
      : new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true });
    element.dispatchEvent(event);
  }, { kind, name, mime, text });
  for (const [kind, name, mime, text] of [
    ["paste", "config.yaml", "application/yaml", "yaml: 中文\n"],
    ["drop", "mime-empty", "", "MZ_SOURCE=valid UTF-8\n"],
  ]) {
    await injectFile(kind, name, mime, text);
    await button(`移除附件 ${name}`).waitFor();
    turn = await send(`FILES_${kind}`);
    assert(users(received.at(-1)).at(-1).includes(text));
    assert.equal(turn.items.find(item => item.type === "userMessage").content.find(part => part.type === "file").mime_type, "text/plain");
  }
  checks.push("clipboard file and browser byte drop share canonical MIME and exact source projection");
  const formats = [["data.json", "application/json", '{"中文":true}\n'], ["table.csv", "text/csv", "name,value\n中文,1\n"], ["readme.md", "text/markdown", "# 中文\n原文\n"]];
  await page.locator("input[type=file]").setInputFiles(formats.map(([name, mimeType, text]) => ({ name, mimeType, buffer: Buffer.from(text) })));
  await send("FILES_FORMATS");
  for (const [, , text] of formats) assert(users(received.at(-1)).at(-1).includes(text));

  for (const [name, mimeType, buffer] of [
    ["nul.txt", "text/plain", Buffer.from([65, 0, 66])], ["bad.ts", "application/typescript", Buffer.from([0xff, 0xfe])],
    ["zip.txt", "text/plain", Buffer.from("PK\x03\x04fake archive")], ["fake.png", "image/png", Buffer.from("looks textual")],
    ["empty.txt", "text/plain", Buffer.alloc(0)],
  ]) {
    const count = received.length, turns = (await current()).turns.length;
    await input().fill("FILES_REFUSAL_DRAFT");
    await page.locator("input[type=file]").setInputFiles({ name, mimeType, buffer });
    await button("发送").click();
    await page.getByRole("alert").filter({ hasText: /不支持|UTF-8|unsupported|binary|附件必须/ }).first().waitFor();
    assert.equal(received.length, count); assert.equal((await current()).turns.length, turns);
    assert.equal(await input().textContent(), "FILES_REFUSAL_DRAFT");
    await button(`移除附件 ${name}`).click();
  }
  await input().fill("FILES_BUDGET_DRAFT");
  await page.locator("input[type=file]").setInputFiles({ name: "limit.txt", mimeType: "text/plain", buffer: Buffer.alloc(1024 * 1024, 65) });
  const budgetRequests = received.length;
  await button("发送").click();
  await page.getByRole("alert").filter({ hasText: "input exceeds 1 MiB" }).first().waitFor();
  assert.equal(received.length, budgetRequests); assert.equal(await input().textContent(), "FILES_BUDGET_DRAFT");
  await button("移除附件 limit.txt").click(); await input().fill("");
  checks.push("UTF-8, controls, binary signature, explicit MIME mismatch, empty input and aggregate label budget refuse without consuming drafts");

  await mkdir(join(workspace, "目录"));
  await writeFile(join(workspace, "目录/now.txt"), "BEFORE_DIRECTORY_REFERENCE\n");
  await writeFile(join(scratch, "outside.txt"), "OUTSIDE");
  await symlink(scratch, join(workspace, "escape"));
  await button("添加功能与 Skills").click();
  await page.getByRole("option").filter({ hasText: "工作区文件与文件夹" }).click();
  const folder = page.getByRole("treeitem", { name: "目录", exact: true });
  await folder.waitFor();
  await folder.click({ button: "right" });
  await page.getByRole("menuitem", { name: "添加到对话", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="chat-input"]')?.textContent.includes("目录"));
  await shot("files-folder-reference-draft");
  await writeFile(join(workspace, "目录/now.txt"), "AFTER_DIRECTORY_REFERENCE_CURRENT_RUNTIME_BYTES\n");
  await input().press("End"); await page.keyboard.type(" FILES_LIVE_DIRECTORY");
  const liveTurn = await send();
  const read = liveTurn.items.find(item => item.type === "dynamicToolCall" && item.tool === "fs_read");
  assert.equal(read?.success, true); assert.equal(read?.execution.backend, "runtime");
  assert(JSON.stringify(read).includes("AFTER_DIRECTORY_REFERENCE_CURRENT_RUNTIME_BYTES"));
  await shot("files-workspace-folder");
  checks.push("discoverable workspace tree context action inserts a live directory reference and actual Runtime fs_read sees subsequent file changes");
  const payload = { type: "directory", workspacePath: workspace, path: `${workspace}/目录`, relativePath: "目录", name: "目录" };
  const dropReference = async value => input().evaluate((element, payload) => {
    const transfer = new DataTransfer();
    transfer.setData("application/x-areal-workspace-file", JSON.stringify(payload));
    transfer.setData("text/plain", "MUST_NOT_FALL_THROUGH");
    element.dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true }));
  }, value);
  await dropReference(payload);
  await page.waitForFunction(() => document.querySelector('[data-testid="chat-input"]')?.textContent.includes("目录"));
  await input().fill("");
  for (const bad of [{ ...payload, workspacePath: scratch }, { ...payload, path: `${workspace}/../outside`, relativePath: "../outside", name: "outside" },
    { ...payload, path: `${workspace}/escape`, relativePath: "escape", name: "escape" }, { ...payload, type: "file" }, {}]) {
    await dropReference(bad);
    await page.getByRole("alert").filter({ hasText: /工作区|引用|变化/ }).first().waitFor();
    assert.equal(await input().textContent(), "");
  }
  checks.push("workspace internal drag validates identity, relative path, kind and privileged symlink containment; invalid custom payload never inserts plaintext");

  await app.evaluate(() => { globalThis.filesHoldList = true; globalThis.filesListEntered = false; globalThis.filesListCompleted = false; });
  await input().fill("FILES_STALE_DRAFT");
  const beforePending = received.length;
  await dropReference(payload);
  await until(async () => app.evaluate(() => globalThis.filesListEntered), "workspace validation boundary held");
  assert.equal(await button("发送").isDisabled(), true);
  await input().press("Enter"); assert.equal(received.length, beforePending);
  await createProjectConversation(page, "workspace");
  await selectConversation(page, tid);
  await app.evaluate(() => globalThis.filesReleaseList());
  await until(async () => app.evaluate(() => globalThis.filesListCompleted), "delayed privileged workspace listing completed");
  await page.getByText("正在核对工作区引用…", { exact: true }).waitFor({ state: "hidden" });
  assert.equal(await input().textContent(), "FILES_STALE_DRAFT");
  await input().fill("");
  checks.push("pending workspace validation disables sending; A-to-B-to-A navigation rejects the old completion");

  await input().fill("FILES_HOLD"); await button("发送").click();
  await until(async () => fixture.held.size && (await current()).turns.at(-1)?.status === "inProgress", "active fixture stream");
  await injectFile("drop", "queue.json", "application/json", '{"queue":"完整"}\n');
  await input().fill("FILES_QUEUED"); await button("发送").click();
  const pending = () => projectSnapshotQueue();
  async function projectSnapshotQueue() { return project(await state()).state.queues[tid]; }
  await until(async () => (await pending()).items.some(item => item.status === "pending"), "text file enqueued");
  const queued = (await pending()).items.find(item => item.status === "pending");
  const originalQueueFile = queued.input.find(part => part.type === "file");
  const editQueued = async () => {
    await page.locator(".composer-queue-row").filter({ hasText: "FILES_QUEUED" }).getByRole("button", { name: /更多操作/ }).click();
    await page.getByRole("menuitem", { name: "编辑消息", exact: true }).click();
    await page.waitForFunction(key => JSON.parse(localStorage.getItem(`${key}:queue-edit`) ?? "null")?.phase === "editing", `areal-gui:draft:${pid}:${tid}`);
  };
  await input().fill("FILES_NORMAL_DRAFT");
  await editQueued();
  await app.evaluate(() => { globalThis.filesHoldList = true; globalThis.filesListEntered = false; globalThis.filesListCompleted = false; });
  await dropReference(payload);
  await until(async () => app.evaluate(() => globalThis.filesListEntered), "queue reference validation held");
  await button("取消").click();
  await page.waitForFunction(key => !localStorage.getItem(`${key}:queue-edit`), `areal-gui:draft:${pid}:${tid}`);
  await app.evaluate(() => globalThis.filesReleaseList());
  await until(async () => app.evaluate(() => globalThis.filesListCompleted), "delayed privileged workspace listing completed");
  await page.getByText("正在核对工作区引用…", { exact: true }).waitFor({ state: "hidden" });
  assert.equal(await input().textContent(), "FILES_NORMAL_DRAFT");
  checks.push("canceling queue edit invalidates its pending directory reference and preserves the restored normal draft");
  await editQueued();
  await injectFile("paste", "edit.yaml", "application/yaml", "edited: 完整\n");
  await input().fill("FILES_QUEUE_EDITED"); await button("保存").click();
  await until(async () => (await pending()).items.some(item => item.id === queued.id && item.input.some(part => part.text === "FILES_QUEUE_EDITED")), "queued file edit accepted");
  const edited = (await pending()).items.find(item => item.id === queued.id);
  assert(edited.input.some(part => part.type === "file" && part.url === originalQueueFile.url));
  assert(edited.input.some(part => part.name === "edit.yaml"));
  const active = (await current()).turns.at(-1);
  await call("steer", { projectId: pid, threadId: tid, expectedTurnId: active.id, text: "FILES_STEER", attachments: [{ type: "file", url: file.url, name: file.name, mimeType: "application/pdf" }] });
  for (const finish of fixture.held) finish();
  await until(async () => (await pending()).items.find(item => item.id === queued.id)?.status === "completed"
    && (await current()).turns.at(-1)?.status === "completed" && !project(await state()).pending.length, "queue activation completed");
  const queuedRequest = received.findLast(body => users(body).some(text => text.includes("FILES_QUEUE_EDITED")));
  assert(queuedRequest && JSON.stringify(queuedRequest).includes("edited: 完整"));
  assert(users(queuedRequest).some(text => text.includes('{"queue":"完整"}')));
  assert(received.some(body => users(body).some(text => text.includes("FILES_STEER") && text.includes(original))));
  checks.push("send, steer, queue admission, edit with retained and new files, and activation share text projection and authoritative MIME");

  const source = await current();
  const fork = await call("fork", { projectId: pid, sourceThreadId: tid, anchor: { turnId: source.turns.at(-1).id, boundary: "after" }, workspaceMode: "sharedCurrent" });
  await selectConversation(page, fork.threadId);
  await send("FILES_FORK_REPLAY");
  assert(users(received.at(-1)).some(text => text.includes(original)));
  const crossThread = await page.evaluate(async params => window.arealDesktop.command("send", params), { projectId: pid, threadId: fork.threadId, text: "FILES_CROSS_THREAD", attachments: [{ type: "file", url: file.url, name: file.name, mimeType: "text/plain" }] });
  assert.equal(crossThread.ok, false); assert.match(crossThread.error.message, /belong|upload/);
  checks.push("frozen fork replays text File without File capability; submitting another thread's upload still fails");
  await selectConversation(page, tid);
  const providers = await call("manage", { projectId: pid, operation: "providers" });
  const responsesProviderRevision = providers.data.find(provider => provider.id === "files-responses")?.revision ?? 0;
  assert(Number.isSafeInteger(responsesProviderRevision));
  await call("manage", { projectId: pid, operation: "providerSave", expectedRevision: responsesProviderRevision,
    provider: { id: "files-responses", revision: responsesProviderRevision, protocol: "responses", endpoint: endpoint.replace("chat/completions", "responses"), models: ["files-responses"], parameters: {} } });
  await until(s => project(s).models.some(model => model.providerId === "files-responses"), "Responses model catalog");
  const configureModel = async model => {
    const expectedRevision = project(await state()).configurations[tid].revision;
    assert(Number.isSafeInteger(expectedRevision));
    await call("configure", { projectId: pid, threadId: tid, expectedRevision, model });
  };
  await configureModel({ providerId: "files-responses", modelId: "files-responses" });
  await page.locator("input[type=file]").setInputFiles({ name: "response.md", mimeType: "text/markdown", buffer: Buffer.from("# Responses 中文\nALL_BYTES\n") });
  await send("FILES_RESPONSES");
  const responseRequest = received.at(-1);
  assert(Array.isArray(responseRequest.input));
  assert(users(responseRequest).at(-1).includes("# Responses 中文\nALL_BYTES\n"));
  assert(users(responseRequest).some(text => text.includes(original)));
  assert.equal(responseRequest.input.flatMap(message => message.content ?? []).some(part => part.type === "input_file"), false);
  await configureModel({ providerId: "fixture-provider", modelId: "fixture" });
  await send("FILES_BACK_TO_CHAT");
  assert(users(received.at(-1)).some(text => text.includes("# Responses 中文\nALL_BYTES\n")));
  checks.push("Responses receives exact input_text with original history retained, and switching back to text-only Chat Completions replays it");
  await shot("files-complete");

}
