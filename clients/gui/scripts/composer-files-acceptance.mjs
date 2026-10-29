import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { createProjectConversation, selectConversation } from "./smoke-navigation.mjs";

const textOf = (message) =>
  typeof message.content === "string"
    ? message.content
    : (message.content ?? []).map((part) => part.text ?? "").join("\n");
export function composerFilesResponse(body, response, fixture) {
  const messages = body.messages ?? body.input ?? [];
  const last = messages.findLastIndex(
    (message) =>
      message.role === "user" &&
      !textOf(message).startsWith("AReaL runtime context (not a user request):"),
  );
  const text = textOf(messages[last] ?? {});
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  if (body.input) {
    response.end(
      [
        { type: "response.output_text.delta", delta: "FILES_OK" },
        {
          type: "response.completed",
          response: {
            status: "completed",
            output: [
              {
                type: "message",
                role: "assistant",
                id: "files-message",
                content: [{ type: "output_text", text: "FILES_OK" }],
              },
            ],
            usage: { input_tokens: 12, output_tokens: 2 },
          },
        },
      ]
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join(""),
    );
    return;
  }
  const send = (delta, finish_reason = null) =>
    response.write(
      `data: ${JSON.stringify({ id: "files", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
    );
  if (
    text.includes("FILES_LIVE_DIRECTORY") &&
    !messages.slice(last + 1).some((message) => message.role === "tool")
  ) {
    send({
      tool_calls: [
        {
          index: 0,
          id: "files-read",
          type: "function",
          function: {
            name: "fs_read",
            arguments: JSON.stringify({ path: "workspace://repo/目录/now.txt" }),
          },
        },
      ],
    });
    send({}, "tool_calls");
    response.end("data: [DONE]\n\n");
    return;
  }
  const finish = () => {
    send({ content: "FILES_OK" });
    send({}, "stop");
    response.end("data: [DONE]\n\n");
  };
  if (text.includes("FILES_HOLD")) {
    send({ content: "FILES_WAIT" });
    fixture.held.add(finish);
    response.on("close", () => fixture.held.delete(finish));
  } else finish();
}

export async function runComposerFilesAcceptance({
  app,
  page,
  pid,
  workspace,
  scratch,
  endpoint,
  call,
  state,
  project,
  until,
  received,
  checks,
  shot,
  fixture,
}) {
  const input = () => page.getByTestId("chat-input");
  const button = (name) => page.getByRole("button", { name, exact: true });
  const activeId = async () => page.getByTestId("areal-workbench").getAttribute("data-thread-id");
  const current = async () => project(await state()).state.threads[await activeId()];
  const send = async (text) => {
    if (text !== undefined) await input().fill(text);
    const count = received.length;
    await button("发送").click();
    await until(
      async () =>
        received.length > count &&
        (await current())?.turns.at(-1)?.status === "completed" &&
        !project(await state()).pending.length,
      "file input completed",
    );
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="chat-input"]')?.textContent,
    );
    return (await current()).turns.at(-1);
  };
  const users = (body) =>
    (body.messages ?? body.input)
      .filter(
        (message) =>
          message.role === "user" &&
          !textOf(message).startsWith("AReaL runtime context (not a user request):"),
      )
      .map(textOf);
  await mkdir(join(workspace, "mention-files"));
  await writeFile(join(workspace, "mention-root.txt"), "MENTION_ROOT\n");
  await writeFile(join(workspace, "mention-files/balanced(中文(bar)).ts"), "MENTION_BALANCED\n");
  await writeFile(join(workspace, "mention-files/nested.ts"), "MENTION_NESTED\n");
  await writeFile(join(workspace, "mention-files/other.ts"), "MENTION_OTHER\n");
  const fileGroup = () => page.getByRole("group", { name: "文件", exact: true });
  const fileOptions = () => fileGroup().getByRole("option");
  const rootFile = () => fileOptions().filter({ hasText: "mention-root.txt" });
  const nestedFile = () => fileOptions().filter({ hasText: "nested.ts" });
  const assertInlineFileHover = async (identifier, absolutePath, screenshot) => {
    await identifier.waitFor();
    await identifier.hover();
    const tooltip = page.getByRole("tooltip").filter({ hasText: absolutePath });
    await tooltip.waitFor();
    assert.equal(
      await tooltip.textContent(),
      absolutePath,
      "R-COMPOSERSURFACE-007 exposes the full active workspace path on hover",
    );
    if (screenshot) await shot(screenshot);
    await page.mouse.move(0, 0);
    await tooltip.waitFor({ state: "hidden" });
  };
  const assertNoReferenceAttachment = async () => {
    assert.equal(
      await page.getByTestId("composer-attachment").count(),
      0,
      "R-COMPOSERSURFACE-007 keeps project references out of attachment cards",
    );
  };
  const mentionCount = received.length;
  await input().fill("@");
  await page.getByTestId("composer-catalog").waitFor();
  assert.equal(await fileOptions().count(), 0);
  assert.equal(
    await page
      .getByTestId("composer-catalog")
      .getByRole("group", { name: "文件", exact: true })
      .count(),
    0,
  );
  assert.equal(await page.getByTestId("composer-catalog").getByRole("textbox").count(), 0);
  assert.equal(await input().textContent(), "@");
  await shot("files-at-empty-query-draft");
  await input().pressSequentially("mention-root");
  await rootFile().waitFor();
  assert.equal(await input().textContent(), "@mention-root");
  assert.equal(await input().evaluate((element) => element === document.activeElement), true);
  assert.equal(
    await page.getByTestId("composer-catalog").getByRole("group").last().getAttribute("aria-label"),
    "文件",
  );
  await input().fill("@");
  await fileGroup().waitFor({ state: "hidden" });
  assert.equal(await input().textContent(), "@");
  await input().pressSequentially("mention-root");
  await rootFile().waitFor();
  const menuBox = await page.getByTestId("composer-catalog").boundingBox();
  const editorBox = await input().boundingBox();
  assert(
    menuBox && editorBox && menuBox.y + menuBox.height <= editorBox.y + 2,
    "file popup sits above the editor",
  );
  await shot("files-at-root-draft");
  await rootFile().click();
  await input().locator('[data-mention-category="files"]').waitFor();
  assert.equal(await input().textContent(), "mention-root.txt ");
  await assertNoReferenceAttachment();
  await assertInlineFileHover(
    input().locator('[data-mention-category="files"]'),
    join(workspace, "mention-root.txt"),
    "files-inline-root-path-hover",
  );
  assert.equal(received.length, mentionCount);
  await input().fill("@mention-files/nested");
  await nestedFile().waitFor();
  assert.equal(await fileOptions().count(), 1);
  assert((await nestedFile().textContent()).includes("mention-files"));
  await input().press("Tab");
  await input().locator('[data-mention-category="files"]').waitFor();
  assert.equal(received.length, mentionCount);
  await input().fill("@this-file-does-not-exist");
  await page.getByText("未找到文件，可继续输入文件名或相对路径", { exact: true }).waitFor();
  await input().press("Enter");
  assert.equal(received.length, mentionCount);
  assert.equal(await input().textContent(), "@this-file-does-not-exist");
  await input().press("Escape");
  await page.getByTestId("composer-catalog").waitFor({ state: "hidden" });
  await input().fill("");
  checks.push(
    "new draft bare @ hides files and popup search; inline query reveals files in the last group, pointer and path-query Tab insert file chips without sending; empty and Escape preserve input",
  );
  const original = "PKG_CONFIG=中文\nexport const text = `原文 <xml> \\n`;\n";
  await page.locator("input[type=file]").setInputFiles({
    name: "中文.ts",
    mimeType: "application/typescript",
    buffer: Buffer.from(original),
  });
  await shot("files-text-card-draft");
  let turn = await send("FILES_FIRST");
  const tid = await activeId();
  const file = turn.items
    .find((item) => item.type === "userMessage")
    .content.find((part) => part.type === "file");
  assert.equal(file.name, "中文.ts");
  assert.equal(file.mime_type, "text/plain");
  assert(users(received.at(-1)).at(-1).includes(original));
  const bytes = await call("media", {
    projectId: pid,
    threadId: tid,
    operation: "read",
    uri: file.url,
  });
  assert.equal(Buffer.from(Object.values(bytes.bytes)).toString("utf8"), original);
  checks.push(
    "new-draft picker fixture transfers named UTF-8 source as original File/blob, complete text reaches Chat Completions",
  );

  await input().fill("");
  await input().pressSequentially("前缀 @mention-files/");
  await nestedFile().waitFor();
  const beforeKeyboardMention = received.length;
  await input().press("ArrowDown");
  await input().press("ArrowUp");
  const selectedFile = await fileGroup()
    .locator('[aria-selected="true"] .composer-catalog-name')
    .textContent();
  assert.equal(selectedFile, "balanced(中文(bar)).ts");
  await input().press("Enter");
  assert.equal(received.length, beforeKeyboardMention);
  assert.equal(await input().textContent(), `前缀 ${selectedFile} `);
  await assertNoReferenceAttachment();
  await assertInlineFileHover(
    input().locator('[data-mention-category="files"]'),
    join(workspace, "mention-files", selectedFile),
  );
  await createProjectConversation(page, "workspace");
  await selectConversation(page, tid);
  await input().locator('[data-mention-category="files"]').waitFor();
  assert.equal(await input().textContent(), `前缀 ${selectedFile} `);
  await assertInlineFileHover(
    input().locator('[data-mention-category="files"]'),
    join(workspace, "mention-files", selectedFile),
    "files-inline-restored-path-hover",
  );
  turn = await send();
  assert.equal(
    turn.items
      .find((item) => item.type === "userMessage")
      .content.some((part) => part.type === "file"),
    false,
  );
  const sentReference = page
    .locator(".user-message-body .markdown-file-reference")
    .filter({ hasText: selectedFile })
    .last();
  assert(
    ["inline", "inline-block", "inline-flex"].includes(
      await sentReference.evaluate((element) => getComputedStyle(element).display),
    ),
    "R-COMPOSERSURFACE-007 keeps the file identifier in inline formatting",
  );
  await assertInlineFileHover(
    sentReference,
    join(workspace, "mention-files", selectedFile),
    "files-inline-sent-path-hover",
  );
  await assertNoReferenceAttachment();
  assert(
    users(received.at(-1)).at(-1).includes(`[${selectedFile}](./mention-files/${selectedFile})`),
  );
  assert(!users(received.at(-1)).at(-1).includes(workspace));
  checks.push(
    "R-COMPOSERSURFACE-007 main chat restores and sends inline file identifiers with full absolute hover paths, no upload cards or file payload, and canonical workspace-relative Markdown",
  );

  await app.evaluate(() => {
    globalThis.filesHoldSearch = "mention-files/nested";
    globalThis.filesSearchEntered = false;
    globalThis.filesSearchCompleted = false;
  });
  await input().fill("@mention-files/nested");
  await until(
    async () => app.evaluate(() => globalThis.filesSearchEntered),
    "file search held at privileged boundary",
  );
  await input().fill("@mention-files/other");
  await fileOptions().filter({ hasText: "other.ts" }).waitFor();
  assert.equal(await nestedFile().count(), 0);
  await app.evaluate(() => globalThis.filesReleaseSearch());
  await until(
    async () => app.evaluate(() => globalThis.filesSearchCompleted),
    "old file search completed",
  );
  assert.equal(await nestedFile().count(), 0);
  assert.equal(await fileOptions().count(), 1);
  await input().press("Escape");
  await input().fill("");
  checks.push("late query response cannot replace current selectable file results");

  await app.evaluate(() => {
    globalThis.filesFailSearch = "mention-files/nested";
  });
  await input().fill("@mention-files/nested");
  await page.getByRole("alert").filter({ hasText: "无法搜索工作区文件，请重试" }).waitFor();
  assert.equal(await fileOptions().count(), 0);
  await fileGroup().getByRole("button", { name: "重试", exact: true }).click();
  await nestedFile().waitFor();
  await input().press("Escape");
  await input().fill("@" + "x".repeat(257));
  await page.getByRole("alert").filter({ hasText: "文件搜索最多支持 256 个字符" }).waitFor();
  await input().press("Escape");
  await input().fill("");
  checks.push(
    "failed file search exposes localized retry, retry recovers the matching file, and oversized queries remain editable",
  );

  await Promise.all(
    Array.from({ length: 105 }, (_, index) =>
      writeFile(
        join(workspace, `mention-files/limited-${String(index).padStart(3, "0")}.txt`),
        "LIMITED\n",
      ),
    ),
  );
  await input().fill("@mention-files/limited-");
  await page.getByText("仅显示部分文件，请缩小搜索范围", { exact: true }).waitFor();
  assert.equal(await fileOptions().count(), 100);
  await shot("files-at-bounded-results");
  await input().press("Escape");
  await input().fill("");
  checks.push(
    "workspace file picker bounds visible results to 100 and identifies incomplete results",
  );

  const injectFile = async (kind, name, mime, text) =>
    input().evaluate(
      (element, fixture) => {
        const transfer = new DataTransfer();
        transfer.items.add(new File([fixture.text], fixture.name, { type: fixture.mime }));
        const event =
          fixture.kind === "paste"
            ? new ClipboardEvent("paste", {
                clipboardData: transfer,
                bubbles: true,
                cancelable: true,
              })
            : new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true });
        element.dispatchEvent(event);
      },
      { kind, name, mime, text },
    );
  for (const [kind, name, mime, text] of [
    ["paste", "config.yaml", "application/yaml", "yaml: 中文\n"],
    ["drop", "mime-empty", "", "MZ_SOURCE=valid UTF-8\n"],
  ]) {
    await injectFile(kind, name, mime, text);
    await button(`移除附件 ${name}`).waitFor();
    turn = await send(`FILES_${kind}`);
    assert(users(received.at(-1)).at(-1).includes(text));
    assert.equal(
      turn.items
        .find((item) => item.type === "userMessage")
        .content.find((part) => part.type === "file").mime_type,
      "text/plain",
    );
  }
  checks.push(
    "clipboard file and browser byte drop share canonical MIME and exact source projection",
  );
  const formats = [
    ["data.json", "application/json", '{"中文":true}\n'],
    ["table.csv", "text/csv", "name,value\n中文,1\n"],
    ["readme.md", "text/markdown", "# 中文\n原文\n"],
  ];
  await page
    .locator("input[type=file]")
    .setInputFiles(
      formats.map(([name, mimeType, text]) => ({ name, mimeType, buffer: Buffer.from(text) })),
    );
  await send("FILES_FORMATS");
  for (const [, , text] of formats) assert(users(received.at(-1)).at(-1).includes(text));

  for (const [name, mimeType, buffer] of [
    ["nul.txt", "text/plain", Buffer.from([65, 0, 66])],
    ["bad.ts", "application/typescript", Buffer.from([0xff, 0xfe])],
    ["zip.txt", "text/plain", Buffer.from("PK\x03\x04fake archive")],
    ["fake.png", "image/png", Buffer.from("looks textual")],
    ["empty.txt", "text/plain", Buffer.alloc(0)],
  ]) {
    const count = received.length,
      turns = (await current()).turns.length;
    await input().fill("FILES_REFUSAL_DRAFT");
    await page.locator("input[type=file]").setInputFiles({ name, mimeType, buffer });
    await button("发送").click();
    await page
      .getByRole("alert")
      .filter({ hasText: /不支持|UTF-8|unsupported|binary|附件必须/ })
      .first()
      .waitFor();
    assert.equal(received.length, count);
    assert.equal((await current()).turns.length, turns);
    assert.equal(await input().textContent(), "FILES_REFUSAL_DRAFT");
    await button(`移除附件 ${name}`).click();
  }
  await input().fill("FILES_BUDGET_DRAFT");
  await page.locator("input[type=file]").setInputFiles({
    name: "limit.txt",
    mimeType: "text/plain",
    buffer: Buffer.alloc(1024 * 1024, 65),
  });
  const budgetRequests = received.length;
  await button("发送").click();
  await page.getByRole("alert").filter({ hasText: "input exceeds 1 MiB" }).first().waitFor();
  assert.equal(received.length, budgetRequests);
  assert.equal(await input().textContent(), "FILES_BUDGET_DRAFT");
  await button("移除附件 limit.txt").click();
  await input().fill("");
  checks.push(
    "UTF-8, controls, binary signature, explicit MIME mismatch, empty input and aggregate label budget refuse without consuming drafts",
  );

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
  await page.waitForFunction(() =>
    document.querySelector('[data-testid="chat-input"]')?.textContent.includes("目录"),
  );
  await shot("files-folder-reference-draft");
  await writeFile(
    join(workspace, "目录/now.txt"),
    "AFTER_DIRECTORY_REFERENCE_CURRENT_RUNTIME_BYTES\n",
  );
  await input().press("End");
  await page.keyboard.type(" FILES_LIVE_DIRECTORY");
  const liveTurn = await send();
  const read = liveTurn.items.find(
    (item) => item.type === "dynamicToolCall" && item.tool === "fs_read",
  );
  assert.equal(read?.success, true);
  assert.equal(read?.execution.backend, "runtime");
  assert(JSON.stringify(read).includes("AFTER_DIRECTORY_REFERENCE_CURRENT_RUNTIME_BYTES"));
  await shot("files-workspace-folder");
  checks.push(
    "discoverable workspace tree context action inserts a live directory reference and actual Runtime fs_read sees subsequent file changes",
  );
  const payload = {
    type: "directory",
    workspacePath: workspace,
    path: `${workspace}/目录`,
    relativePath: "目录",
    name: "目录",
  };
  const dropReference = async (value) =>
    input().evaluate((element, payload) => {
      const transfer = new DataTransfer();
      transfer.setData("application/x-areal-workspace-file", JSON.stringify(payload));
      transfer.setData("text/plain", "MUST_NOT_FALL_THROUGH");
      element.dispatchEvent(
        new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true }),
      );
    }, value);
  await dropReference(payload);
  await page.waitForFunction(() =>
    document.querySelector('[data-testid="chat-input"]')?.textContent.includes("目录"),
  );
  await input().fill("");
  for (const bad of [
    { ...payload, workspacePath: scratch },
    { ...payload, path: `${workspace}/../outside`, relativePath: "../outside", name: "outside" },
    { ...payload, path: `${workspace}/escape`, relativePath: "escape", name: "escape" },
    { ...payload, type: "file" },
    {},
  ]) {
    await dropReference(bad);
    await page
      .getByRole("alert")
      .filter({ hasText: /工作区|引用|变化/ })
      .first()
      .waitFor();
    assert.equal(await input().textContent(), "");
  }
  checks.push(
    "workspace internal drag validates identity, relative path, kind and privileged symlink containment; invalid custom payload never inserts plaintext",
  );

  await app.evaluate(() => {
    globalThis.filesHoldList = true;
    globalThis.filesListEntered = false;
    globalThis.filesListCompleted = false;
  });
  await input().fill("FILES_STALE_DRAFT");
  const beforePending = received.length;
  await dropReference(payload);
  await until(
    async () => app.evaluate(() => globalThis.filesListEntered),
    "workspace validation boundary held",
  );
  assert.equal(await button("发送").isDisabled(), true);
  await input().press("Enter");
  assert.equal(received.length, beforePending);
  await createProjectConversation(page, "workspace");
  await selectConversation(page, tid);
  await app.evaluate(() => globalThis.filesReleaseList());
  await until(
    async () => app.evaluate(() => globalThis.filesListCompleted),
    "delayed privileged workspace listing completed",
  );
  await page.getByText("正在核对工作区引用…", { exact: true }).waitFor({ state: "hidden" });
  assert.equal(await input().textContent(), "FILES_STALE_DRAFT");
  await input().fill("");
  checks.push(
    "pending workspace validation disables sending; A-to-B-to-A navigation rejects the old completion",
  );

  await input().fill("FILES_HOLD");
  await button("发送").click();
  await until(
    async () => fixture.held.size && (await current()).turns.at(-1)?.status === "inProgress",
    "active fixture stream",
  );
  await injectFile("drop", "queue.json", "application/json", '{"queue":"完整"}\n');
  await input().fill("FILES_QUEUED");
  await button("发送").click();
  const pending = () => projectSnapshotQueue();
  async function projectSnapshotQueue() {
    return project(await state()).state.queues[tid];
  }
  await until(
    async () => (await pending()).items.some((item) => item.status === "pending"),
    "text file enqueued",
  );
  const queued = (await pending()).items.find((item) => item.status === "pending");
  const originalQueueFile = queued.input.find((part) => part.type === "file");
  const editQueued = async () => {
    await page
      .locator(".composer-queue-row")
      .filter({ hasText: "FILES_QUEUED" })
      .getByRole("button", { name: /更多操作/ })
      .click();
    await page.getByRole("menuitem", { name: "编辑消息", exact: true }).click();
    await page.waitForFunction(
      (key) => JSON.parse(localStorage.getItem(`${key}:queue-edit`) ?? "null")?.phase === "editing",
      `areal-gui:draft:${pid}:${tid}`,
    );
  };
  await input().fill("FILES_NORMAL_DRAFT");
  await editQueued();
  await app.evaluate(() => {
    globalThis.filesHoldList = true;
    globalThis.filesListEntered = false;
    globalThis.filesListCompleted = false;
  });
  await dropReference(payload);
  await until(
    async () => app.evaluate(() => globalThis.filesListEntered),
    "queue reference validation held",
  );
  await button("取消").click();
  await page.waitForFunction(
    (key) => !localStorage.getItem(`${key}:queue-edit`),
    `areal-gui:draft:${pid}:${tid}`,
  );
  await app.evaluate(() => globalThis.filesReleaseList());
  await until(
    async () => app.evaluate(() => globalThis.filesListCompleted),
    "delayed privileged workspace listing completed",
  );
  await page.getByText("正在核对工作区引用…", { exact: true }).waitFor({ state: "hidden" });
  assert.equal(await input().textContent(), "FILES_NORMAL_DRAFT");
  checks.push(
    "canceling queue edit invalidates its pending directory reference and preserves the restored normal draft",
  );
  await editQueued();
  await injectFile("paste", "edit.yaml", "application/yaml", "edited: 完整\n");
  await input().fill("FILES_QUEUE_EDITED");
  await button("保存").click();
  await until(
    async () =>
      (await pending()).items.some(
        (item) =>
          item.id === queued.id && item.input.some((part) => part.text === "FILES_QUEUE_EDITED"),
      ),
    "queued file edit accepted",
  );
  const edited = (await pending()).items.find((item) => item.id === queued.id);
  assert(edited.input.some((part) => part.type === "file" && part.url === originalQueueFile.url));
  assert(edited.input.some((part) => part.name === "edit.yaml"));
  const active = (await current()).turns.at(-1);
  await call("steer", {
    projectId: pid,
    threadId: tid,
    expectedTurnId: active.id,
    text: "FILES_STEER",
    attachments: [{ type: "file", url: file.url, name: file.name, mimeType: "application/pdf" }],
  });
  for (const finish of fixture.held) finish();
  await until(
    async () =>
      (await pending()).items.find((item) => item.id === queued.id)?.status === "completed" &&
      (await current()).turns.at(-1)?.status === "completed" &&
      !project(await state()).pending.length,
    "queue activation completed",
  );
  const queuedRequest = received.findLast((body) =>
    users(body).some((text) => text.includes("FILES_QUEUE_EDITED")),
  );
  assert(queuedRequest && JSON.stringify(queuedRequest).includes("edited: 完整"));
  assert(users(queuedRequest).some((text) => text.includes('{"queue":"完整"}')));
  assert(
    received.some((body) =>
      users(body).some((text) => text.includes("FILES_STEER") && text.includes(original)),
    ),
  );
  checks.push(
    "send, steer, queue admission, edit with retained and new files, and activation share text projection and authoritative MIME",
  );

  const source = await current();
  const fork = await call("fork", {
    projectId: pid,
    sourceThreadId: tid,
    anchor: { turnId: source.turns.at(-1).id, boundary: "after" },
    workspaceMode: "sharedCurrent",
  });
  await selectConversation(page, fork.threadId);
  await send("FILES_FORK_REPLAY");
  assert(users(received.at(-1)).some((text) => text.includes(original)));
  const crossThread = await page.evaluate(
    async (params) => window.arealDesktop.command("send", params),
    {
      projectId: pid,
      threadId: fork.threadId,
      text: "FILES_CROSS_THREAD",
      attachments: [{ type: "file", url: file.url, name: file.name, mimeType: "text/plain" }],
    },
  );
  assert.equal(crossThread.ok, false);
  assert.match(crossThread.error.message, /belong|upload/);
  checks.push(
    "frozen fork replays text File without File capability; submitting another thread's upload still fails",
  );
  await selectConversation(page, tid);
  const providers = await call("manage", { projectId: pid, operation: "providers" });
  const responsesProviderRevision =
    providers.data.find((provider) => provider.id === "files-responses")?.revision ?? 0;
  assert(Number.isSafeInteger(responsesProviderRevision));
  await call("manage", {
    projectId: pid,
    operation: "providerSave",
    expectedRevision: responsesProviderRevision,
    provider: {
      id: "files-responses",
      revision: responsesProviderRevision,
      protocol: "responses",
      endpoint: endpoint.replace("chat/completions", "responses"),
      models: ["files-responses"],
      parameters: {},
    },
  });
  await until(
    (s) => project(s).models.some((model) => model.providerId === "files-responses"),
    "Responses model catalog",
  );
  const configureModel = async (model) => {
    const expectedRevision = project(await state()).configurations[tid].revision;
    assert(Number.isSafeInteger(expectedRevision));
    await call("configure", { projectId: pid, threadId: tid, expectedRevision, model });
  };
  await configureModel({ providerId: "files-responses", modelId: "files-responses" });
  await page.locator("input[type=file]").setInputFiles({
    name: "response.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("# Responses 中文\nALL_BYTES\n"),
  });
  await send("FILES_RESPONSES");
  const responseRequest = received.at(-1);
  assert(Array.isArray(responseRequest.input));
  assert(users(responseRequest).at(-1).includes("# Responses 中文\nALL_BYTES\n"));
  assert(users(responseRequest).some((text) => text.includes(original)));
  assert.equal(
    responseRequest.input
      .flatMap((message) => message.content ?? [])
      .some((part) => part.type === "input_file"),
    false,
  );
  await configureModel({ providerId: "fixture-provider", modelId: "fixture" });
  await send("FILES_BACK_TO_CHAT");
  assert(users(received.at(-1)).some((text) => text.includes("# Responses 中文\nALL_BYTES\n")));
  checks.push(
    "Responses receives exact input_text with original history retained, and switching back to text-only Chat Completions replays it",
  );
  const { threadId: worktreeThreadId } = await call("create", {
    projectId: pid,
    requestId: randomUUID(),
    worktree: { mode: "worktree", ref: "main" },
    profile: { id: "standard", revision: "v1" },
    options: { permissionPreset: "fullAccess" },
  });
  await selectConversation(page, worktreeThreadId);
  const worktreeDirectory = (await current()).worktree?.directory;
  assert(
    worktreeDirectory && worktreeDirectory !== workspace,
    "new conversation owns a real separate Git worktree",
  );
  await mkdir(join(workspace, "mention-route-main"));
  await mkdir(join(worktreeDirectory, "mention-route-worktree"));
  await writeFile(join(workspace, "mention-route-main/shared.ts"), "MAIN_TREE_ONLY\n");
  await writeFile(join(worktreeDirectory, "mention-route-worktree/shared.ts"), "WORKTREE_ONLY\n");
  await input().fill("@mention-route-");
  await fileOptions().filter({ hasText: "mention-route-worktree" }).waitFor();
  assert.equal(await fileOptions().filter({ hasText: "mention-route-main" }).count(), 0);
  await shot("files-at-real-worktree");
  await input().press("Enter");
  await assertNoReferenceAttachment();
  await assertInlineFileHover(
    input().locator('[data-mention-category="files"]'),
    join(worktreeDirectory, "mention-route-worktree/shared.ts"),
    "files-inline-worktree-input-path-hover",
  );
  await send();
  await assertInlineFileHover(
    page
      .locator(".user-message-body .markdown-file-reference")
      .filter({ hasText: "shared.ts" })
      .last(),
    join(worktreeDirectory, "mention-route-worktree/shared.ts"),
    "files-inline-worktree-sent-path-hover",
  );
  assert(users(received.at(-1)).at(-1).includes("[shared.ts](./mention-route-worktree/shared.ts)"));
  await app.evaluate(() => {
    globalThis.filesHoldSearch = "mention-route-";
    globalThis.filesSearchEntered = false;
    globalThis.filesSearchCompleted = false;
  });
  await input().fill("@mention-route-");
  await until(
    async () => app.evaluate(() => globalThis.filesSearchEntered),
    "worktree search held before switching threads",
  );
  await selectConversation(page, tid);
  await input().fill("@mention-route-");
  await fileOptions().filter({ hasText: "mention-route-main" }).waitFor();
  assert.equal(await fileOptions().filter({ hasText: "mention-route-worktree" }).count(), 0);
  await app.evaluate(() => globalThis.filesReleaseSearch());
  await until(
    async () => app.evaluate(() => globalThis.filesSearchCompleted),
    "old worktree search completed after switching",
  );
  assert.equal(await fileOptions().filter({ hasText: "mention-route-worktree" }).count(), 0);
  assert.equal(await fileOptions().count(), 1);
  await input().press("Escape");
  await input().fill("");
  await selectConversation(page, worktreeThreadId);
  await input().fill("");
  await selectConversation(page, tid);
  checks.push(
    "real Git worktree file search uses the active thread root, distinguishes same-name files by parent path, sends the selected relative path, and rejects old-worktree responses after switching",
  );
  await shot("files-complete");
}
