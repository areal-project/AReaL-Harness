import assert from "node:assert/strict";
import { createProjectConversation, selectConversation } from "./smoke-navigation.mjs";

const textOf = message => typeof message.content === "string" ? message.content
  : (message.content ?? []).map(part => part.text ?? "").join("\n");

export function composerReferencesResponse(body, response, fixture) {
  const messages = body.messages ?? [];
  const user = messages.findLastIndex(message => message.role === "user"
    && !textOf(message).startsWith("AReaL runtime context (not a user request):"));
  const text = textOf(messages[user] ?? {});
  const results = messages.slice(user + 1).filter(message => message.role === "tool");
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  const send = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: "references", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  if (text.includes("REF_HOLD")) {
    send({ content: "REFERENCE_WAIT" });
    const finish = () => { send({}, "stop"); response.end("data: [DONE]\n\n"); };
    fixture.held.add(finish);
    response.on("close", () => fixture.held.delete(finish));
    return;
  }
  const lastResult = results.length ? JSON.parse(textOf(results.at(-1))) : null;
  if (text.includes("REF_READ") && results.length < 16 && (!lastResult || Array.isArray(lastResult.data))) {
    const selected = /\]\(#sess_([a-zA-Z0-9._-]+)\)/.exec(text)?.[1];
    const cursor = lastResult?.nextCursor;
    const threadId = !lastResult || cursor ? selected : fixture.unselectedId;
    send({ tool_calls: [{ index: 0, id: `reference-${results.length}`, type: "function", function: {
      name: "read_conversation_context", arguments: JSON.stringify({ threadId, ...(cursor ? { cursor } : {}), maxBytes: 2048 }),
    } }] });
    send({}, "tool_calls");
  } else {
    send({ content: "REFERENCES_OK" });
    send({}, "stop");
  }
  response.end("data: [DONE]\n\n");
}

export async function runComposerReferencesAcceptance({ page, pid, call, state, project, until, received, checks, shot, fixture, reopen }) {
  const input = () => page.getByTestId("chat-input");
  const button = name => page.getByRole("button", { name, exact: true });
  const activeId = () => page.getByTestId("areal-workbench").getAttribute("data-thread-id");
  const current = async () => project(await state()).state.threads[await activeId()];
  const send = async text => {
    if (text !== undefined) await input().fill(text);
    const count = received.length;
    await button("发送").click();
    await until(async () => received.length > count && (await current())?.turns.at(-1)?.status === "completed"
      && !project(await state()).pending.length, "conversation reference send completed");
    return (await current()).turns.at(-1);
  };
  await page.evaluate(({ id, root }) => localStorage.setItem(`areal-gui:worktree-selection:${id}`, JSON.stringify({ mode: "worktree", sourceRoot: root, ref: "HEAD", worktreeRoot: "", branch: "", branchPrefix: "areal" })), { id: pid, root: project(await state()).root });
  await page.reload();
  await page.getByTestId("areal-workbench").waitFor();
  await button("新会话工作区").click();
  assert.equal(await page.getByRole("switch", { name: "在新 Worktree 中工作", exact: true }).isChecked(), false, "legacy Worktree preference cannot authorize a new checkout");
  await page.keyboard.press("Escape");
  await send("REF_SOURCE_SECRET_木星_9482");
  const sourceId = await activeId();
  const title = "引用 [发布] (中文) \\ 路径";
  await call("library", { projectId: pid, threadId: sourceId, operation: "renameThread", title });
  const projectName = "workspace";
  await createProjectConversation(page, projectName);
  await send("REF_UNSELECTED_SECRET_8921");
  fixture.unselectedId = await activeId();
  await createProjectConversation(page, projectName);
  const draftKey = `areal-gui:draft:${pid}:new`;
  const chip = () => input().locator('[data-mention-category="sessions"]');
  const open = async query => {
    await button("添加功能与 Skills").click();
    await page.getByTestId("composer-catalog").waitFor();
    await page.getByRole("option").filter({ hasText: title }).scrollIntoViewIfNeeded();
    await shot("references-recent-menu");
    await page.getByTestId("composer-catalog").getByRole("textbox").fill(query);
    await page.getByRole("option").filter({ hasText: title }).waitFor();
  };
  await input().fill("前文 后文");
  await input().press("Home");
  await input().press("ArrowRight");
  await input().press("ArrowRight");
  await input().press("ArrowRight");
  await open("发布");
  await page.getByTestId("composer-catalog").getByRole("textbox").press("Enter");
  assert.equal(await chip().count(), 1, "+ inserts one reference");
  assert.equal(await chip().getAttribute("data-mention-id"), `session:${sourceId}`);
  await page.keyboard.type("继续");
  assert.match(await input().textContent(), /^前文 .*继续后文$/);
  const canonical = await page.evaluate(key => localStorage.getItem(key), draftKey);
  assert(canonical.includes(`](#sess_${sourceId})`));
  assert(canonical.includes("\\[发布\\]"));
  await shot("references-plus-draft");
  page = await reopen();
  await input().waitFor();
  await chip().waitFor();
  await input().press("End");
  await page.keyboard.type(" REOPEN_EDIT");
  assert.match(await input().textContent(), /REOPEN_EDIT$/, "restored conversation reference draft remains editable");
  await input().press("ControlOrMeta+Z");
  await shot("references-reopened-draft");
  await selectConversation(page, sourceId);
  await createProjectConversation(page, projectName);
  await chip().waitFor();
  assert.equal(await page.evaluate(key => localStorage.getItem(key), draftKey), canonical);
  await input().press("Home");
  await input().press("ArrowRight");
  await input().press("ArrowRight");
  await input().press("ArrowRight");
  await input().press("Delete");
  assert.equal(await chip().count(), 0, "Delete removes only the reference token");
  assert.match(await input().textContent(), /^前文 .*继续后文$/);
  await input().press("ControlOrMeta+A");
  await input().press("Backspace");
  assert.equal(await chip().count(), 0);
  await input().fill("保留 @发布");
  await page.getByRole("option").filter({ hasText: title }).waitFor();
  await shot("references-at-menu");
  await input().press("Enter");
  assert.equal(await chip().count(), 1, "@ inserts one reference");
  assert.match(await input().textContent(), /^保留 /);
  await page.keyboard.type(" REF_NO_READ");
  const requestStart = received.length;
  await send();
  const targetId = await activeId();
  const first = received[requestStart];
  assert(JSON.stringify(first).includes(`#sess_${sourceId}`));
  assert(!JSON.stringify(first.messages).includes("REF_SOURCE_SECRET_木星_9482"), "send keeps source history out of the initial model request");
  assert.equal(received.length, requestStart + 1, "reference alone does not force a history read");
  checks.push("new draft + and @ insert once at the caret; escaped title and stable identity survive navigation; removal clears the reference; sending stays lightweight");

  await input().fill("REF_READ @发布");
  await page.getByRole("option").filter({ hasText: title }).waitFor();
  await input().press("Enter");
  await shot("references-main-mention");
  const readStart = received.length;
  await send();
  const requests = received.slice(readStart);
  assert(requests.length >= 3 && requests.length < 17, "real Core handles paged selected reads and unselected rejection");
  const results = requests.at(-1).messages.filter(message => message.role === "tool");
  assert.equal(results.length, requests.length - 1);
  assert(results.slice(0, -1).some(result => textOf(result).includes("REF_SOURCE_SECRET_木星_9482")), "selected source returns authoritative history");
  assert(results.slice(0, -1).every(result => Array.isArray(JSON.parse(textOf(result)).data)), "selected pages succeed");
  assert(!textOf(results.at(-1)).includes("REF_UNSELECTED_SECRET_8921"), "unselected source never leaks history");
  assert.match(textOf(results.at(-1)), /unavailable/i);
  assert(!JSON.stringify(requests[0].messages).includes("REF_SOURCE_SECRET_木星_9482"));
  assert.equal(await activeId(), targetId);
  await shot("references-read-completed");
  checks.push("main Composer reference reaches the real Core tool; only selected same-workspace history is returned on demand; unselected read is rejected");

  await input().fill("REF_HOLD");
  await button("发送").click();
  await until(async () => fixture.held.size && (await current()).turns.at(-1)?.status === "inProgress", "active reference fixture stream");
  await input().fill("REF_QUEUED @发布");
  await page.getByRole("option").filter({ hasText: title }).waitFor();
  await input().press("Enter");
  await button("发送").click();
  const queue = async () => project(await state()).state.queues[targetId];
  await until(async () => (await queue()).items.find(item => item.status === "pending"
    && item.input.some(part => part.text?.startsWith("REF_QUEUED"))), "reference queued through Composer");
  const queued = (await queue()).items.find(item => item.status === "pending"
    && item.input.some(part => part.text?.startsWith("REF_QUEUED")));
  await page.locator(".composer-queue-row").filter({ hasText: "REF_QUEUED" }).getByRole("button", { name: /更多操作/ }).click();
  await page.getByRole("menuitem", { name: "编辑消息", exact: true }).click();
  await page.waitForFunction(key => JSON.parse(localStorage.getItem(`${key}:queue-edit`) ?? "null")?.phase === "editing", `areal-gui:draft:${pid}:${targetId}`);
  await chip().waitFor();
  assert.equal(await chip().getAttribute("data-mention-id"), `session:${sourceId}`);
  await input().press("End");
  await page.keyboard.type(" REF_EDITED");
  await button("保存排队消息").click();
  await until(async () => (await queue()).items.find(item => item.id === queued.id
    && item.input.some(part => part.text?.includes("REF_EDITED"))), "edited reference persisted in queue");
  const edited = (await queue()).items.find(item => item.id === queued.id);
  assert(edited.input.some(part => part.text?.includes(`](#sess_${sourceId})`)));
  await shot("references-queue-edited");
  for (const finish of fixture.held) finish();
  await until(async () => (await queue()).items.find(item => item.id === queued.id)?.status === "completed"
    && (await current()).turns.at(-1)?.status === "completed", "edited reference queue activated");
  const queuedRequest = received.findLast(body => body.messages.some(message => message.role === "user" && textOf(message).includes("REF_EDITED")));
  assert(queuedRequest && JSON.stringify(queuedRequest).includes(`#sess_${sourceId}`));
  checks.push("queue admission, restored edit chip, save and activation preserve the selected conversation ID");
}
