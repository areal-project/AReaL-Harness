import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const textOf = (message) =>
  typeof message.content === "string"
    ? message.content
    : (message.content ?? []).map((part) => part.text ?? "").join("\n");
const collect = (value, predicate) =>
  !value || typeof value !== "object"
    ? []
    : [
        ...(predicate(value) ? [value] : []),
        ...Object.values(value).flatMap((child) => collect(child, predicate)),
      ];

export async function createFolderVisionFixture(scratch) {
  const directory = join(scratch, "外部 目录 (v2)#1");
  await mkdir(directory);
  const images = await Promise.all(
    ["a.png", "b.png", "c.png"].map(async (name) => {
      const bytes = await readFile(new URL(`./fixtures/folder-vision/${name}`, import.meta.url));
      await writeFile(join(directory, name), bytes);
      return { name, sha256: hash(bytes) };
    }),
  );
  return { directory, images, negative: false };
}

export function composerFolderVisionResponse(body, response, fixture) {
  const messages = body.messages;
  const results = messages.filter(
    (message) =>
      message.role === "tool" && message.tool_call_id?.startsWith(`folder-${fixture.negative}-`),
  );
  const permissionRequest = {
    readRoots: [fixture.directory],
    justification: "Read the selected directory and its three images.",
  };
  const sequence = fixture.negative
    ? [["fs_list", { path: fixture.directory }]]
    : [
        ["fs_list", { path: fixture.directory, permissionRequest }],
        ...fixture.images.map((image) => [
          "image_read",
          { path: join(fixture.directory, image.name), permissionRequest },
        ]),
      ];
  const next = sequence[results.length];
  const delta = next
    ? {
        tool_calls: [
          {
            index: 0,
            id: `folder-${fixture.negative}-${results.length}`,
            type: "function",
            function: { name: next[0], arguments: JSON.stringify(next[1]) },
          },
        ],
      }
    : { content: fixture.negative ? "FOLDER_READ_DENIED_OK" : "FOLDER_IMAGE_PAYLOADS_OK" };
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const [item, finish_reason] of [
    [delta, null],
    [{}, next ? "tool_calls" : "stop"],
  ])
    response.write(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: item, finish_reason }] })}\n\n`,
    );
  response.end("data: [DONE]\n\n");
}

export function folderVisionEvidence(requests, snapshot, fixture) {
  const final = requests.at(-1);
  const parts = collect(final.messages, (value) => value.type === "image_url");
  const payloadHashes = parts.map((part) => {
    assert.match(part.image_url.url, /^data:image\/png;base64,/);
    return hash(Buffer.from(part.image_url.url.split(",")[1], "base64"));
  });
  const calls = [
    ...new Map(
      collect(
        snapshot,
        (value) =>
          value.type === "dynamicToolCall" && ["fs_list", "image_read"].includes(value.tool),
      ).map((item) => [item.id, item]),
    ).values(),
  ];
  assert.deepEqual(calls.map((item) => item.tool).toSorted(), [
    "fs_list",
    "image_read",
    "image_read",
    "image_read",
  ]);
  const bases = calls.flatMap((item) =>
    item.execution.permissionScopes.filter((scope) => scope.kind === "base"),
  );
  assert.ok(bases.length, "The turn records its authoritative base scope");
  const base = bases[0].permissions;
  for (const scope of bases) assert.deepEqual(scope.permissions, base);
  const scopes = calls.map((item) => {
    assert.equal(item.success, true, `${item.tool} must succeed through Runtime`);
    const record = item.execution.permissionScopes.find((scope) => scope.kind === "operation");
    assert.ok(record, "Each read requires its approved operation scope");
    assert.equal(
      record.parentScopeId,
      bases[0].parentScopeId,
      "Operation and base share the same authority",
    );
    const operation = record.permissions;
    assert.ok(!base.readRoots.includes(`workspace://host${fixture.directory}`));
    assert.deepEqual(
      operation.readRoots.toSorted(),
      [...base.readRoots, `workspace://host${fixture.directory}`].toSorted(),
    );
    assert.deepEqual(operation.writeRoots, []);
    assert.equal(operation.network, "deny");
    if (item.tool === "image_read")
      assert.ok(
        item.contentItems.some((part) => part.type === "arealMedia" && part.modality === "image"),
      );
    return { tool: item.tool, base, operation };
  });
  const mappings = calls
    .filter((item) => item.tool === "image_read")
    .map((item) => {
      const metadata = JSON.parse(item.contentItems.find((part) => part.type === "inputText").text);
      const image = fixture.images.find(
        (image) => metadata.path === `workspace://host${join(fixture.directory, image.name)}`,
      );
      assert.ok(image, "Image receipt belongs to a selected original file");
      assert.equal(metadata.sourceSha256, image.sha256, "Runtime read the original image bytes");
      const media = item.contentItems.find(
        (part) => part.type === "arealMedia" && part.modality === "image",
      ).media;
      assert.equal(metadata.media.uri, media.uri, "Source metadata and returned media agree");
      assert.match(media.uri, /^areal:\/\/blob\/[a-f0-9]{64}$/);
      return {
        name: image.name,
        sourceSha256: image.sha256,
        modelPayloadSha256: media.uri.split("/").at(-1),
      };
    });
  assert.deepEqual(
    mappings.map((item) => item.name).toSorted(),
    fixture.images.map((image) => image.name).toSorted(),
  );
  assert.equal(new Set(payloadHashes).size, 3, "Three distinct prepared images reach the model");
  assert.deepEqual(
    payloadHashes.toSorted(),
    mappings.map((item) => item.modelPayloadSha256).toSorted(),
    "All three Core media payloads must reach the model request",
  );
  return { images: fixture.images, mappings, payloadHashes, scopes, visualRecognition: "not_run" };
}

export async function runComposerFolderVisionAcceptance({
  page,
  pid,
  state,
  project,
  until,
  received,
  checks,
  shot,
  scratch,
  fixture,
}) {
  const input = page.getByTestId("chat-view").getByTestId("chat-input");
  const current = async () =>
    project(await state()).state.threads[
      await page.getByTestId("areal-workbench").getAttribute("data-thread-id")
    ];
  await page.getByRole("button", { name: "更改权限", exact: true }).click();
  await page.getByRole("menuitemradio", { name: /^请求审批/ }).click();
  await input.fill("请逐张识别这个文件夹中的三张图片： ");
  const cdp = await page.context().newCDPSession(page);
  try {
    const box = await input.boundingBox();
    for (const type of ["dragEnter", "dragOver", "drop"])
      await cdp.send("Input.dispatchDragEvent", {
        type,
        x: box.x + box.width / 2,
        y: box.y + box.height / 2,
        data: { items: [], files: [fixture.directory], dragOperationsMask: 1 },
      });
  } finally {
    await cdp.detach();
  }
  await input.locator('[data-mention-category="files"]').waitFor();
  await shot("folder-vision-reference");
  const before = received.length;
  await page.getByRole("button", { name: "发送", exact: true }).click();
  for (let index = 0; index < 4; index++) {
    const approval = page.getByRole("region", { name: "工具审批", exact: true });
    await approval.waitFor({ timeout: 30000 });
    await shot(`folder-vision-approval-${index + 1}`);
    await approval.getByRole("button", { name: "允许一次", exact: true }).click();
    await until(() => received.length > before + index + 1, "approved tool result reaches model");
  }
  await until(
    async () => (await current())?.turns.at(-1)?.status === "completed",
    "folder media turn completed",
  );
  await page.getByText("FOLDER_IMAGE_PAYLOADS_OK", { exact: true }).waitFor();
  const requests = received.slice(before);
  const user = requests[0].messages.findLast(
    (message) =>
      message.role === "user" &&
      !textOf(message).startsWith("AReaL runtime context (not a user request):"),
  );
  assert.ok(
    [...textOf(user).matchAll(/\]\(<([^>]+)>\)/g)].some(
      (match) => decodeURIComponent(match[1]) === fixture.directory + "/",
    ),
    "Composer preserves the selected external directory",
  );
  const evidence = folderVisionEvidence(requests, project(await state()), fixture);
  assert.equal(evidence.scopes.length, 4);
  await shot("folder-vision-payloads-completed");
  checks.push(
    "External folder drop → four one-operation approvals → real Runtime reads → all three original model image payloads",
  );
  fixture.negative = true;
  const negativeStart = received.length;
  await input.fill("再次读取之前的目录，不增加权限。");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await page.getByText("FOLDER_READ_DENIED_OK", { exact: true }).waitFor({ timeout: 30000 });
  const denied = received
    .slice(negativeStart)
    .at(-1)
    .messages.filter((message) => message.role === "tool")
    .at(-1);
  assert.match(textOf(denied), /PERMISSION_DENIED|permission.denied|access.denied/i);
  checks.push(
    "Later unapproved read is denied; the operation grant does not change the conversation base scope",
  );
  await writeFile(
    join(scratch, "folder-vision-evidence.json"),
    JSON.stringify(
      {
        projectId: pid,
        ...evidence,
        approvals: 4,
        laterReadDenied: true,
        stages: {
          directoryReceived: true,
          runtimeRead: true,
          originalModelPayloads: true,
          visualRecognition: "not_run",
        },
        modelRequests: "model-requests.json",
        authoritativeHistory: "authoritative-history.json",
      },
      null,
      2,
    ),
  );
}
