import test from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { makeTempDir } from "./support/temp.mjs";
import {
  createFolderVisionFixture,
  folderVisionEvidence,
} from "./composer-folder-vision-acceptance.mjs";

test("folder evidence requires three original model images and bounded successful Runtime receipts", async (t) => {
  const scratch = await makeTempDir("areal-folder-vision-contract-");
  try {
    const fixture = await createFolderVisionFixture(scratch);
    const base = {
      readRoots: ["workspace://repo", "workspace://scratch/agent-test"],
      writeRoots: [],
      network: "deny",
    };
    const operation = {
      ...base,
      readRoots: [...base.readRoots, `workspace://host${fixture.directory}`],
    };
    const prepared = await Promise.all(
      fixture.images.map(async (image) =>
        Buffer.concat([
          await readFile(join(fixture.directory, image.name)),
          Buffer.from("prepared PNG"),
        ]),
      ),
    );
    const calls = ["fs_list", "image_read", "image_read", "image_read"].map((tool, index) => {
      const image = fixture.images[index - 1];
      const media = image && {
        uri: `areal://blob/${createHash("sha256")
          .update(prepared[index - 1])
          .digest("hex")}`,
      };
      return {
        id: `call-${index}`,
        type: "dynamicToolCall",
        tool,
        success: true,
        execution: {
          permissionScopes: [
            ...(index === 0
              ? [{ kind: "base", parentScopeId: "authority", permissions: base }]
              : []),
            { kind: "operation", parentScopeId: "authority", permissions: operation },
          ],
        },
        contentItems: image
          ? [
              {
                type: "inputText",
                text: JSON.stringify({
                  path: `workspace://host${join(fixture.directory, image.name)}`,
                  sourceSha256: image.sha256,
                  media,
                }),
              },
              { type: "arealMedia", modality: "image", media },
            ]
          : [],
      };
    });
    const content = prepared.map((bytes) => ({
      type: "image_url",
      image_url: { url: `data:image/png;base64,${bytes.toString("base64")}` },
    }));
    const requests = [{ messages: [{ role: "user", content }] }];
    assert.equal(folderVisionEvidence(requests, calls, fixture).visualRecognition, "not_run");
    for (const [name, mutate] of [
      ["missing image", (requests) => requests[0].messages[0].content.pop()],
      [
        "duplicate image",
        (requests) => {
          requests[0].messages[0].content[2] = requests[0].messages[0].content[0];
        },
      ],
      [
        "tool failed",
        (_requests, calls) => {
          calls[1].success = false;
        },
      ],
      [
        "missing approval",
        (_requests, calls) => {
          calls[1].execution.permissionScopes.pop();
        },
      ],
      [
        "write access",
        (_requests, calls) => {
          calls[1].execution.permissionScopes[0].permissions.writeRoots = ["workspace://repo"];
        },
      ],
      [
        "network access",
        (_requests, calls) => {
          calls[1].execution.permissionScopes[0].permissions.network = "allow";
        },
      ],
      [
        "persistent grant",
        (_requests, calls) => {
          calls[0].execution.permissionScopes[0].permissions.readRoots.push(
            `workspace://host${fixture.directory}`,
          );
        },
      ],
      [
        "missing media",
        (_requests, calls) => {
          calls[1].contentItems = [];
        },
      ],
    ])
      await t.test(name, () => {
        const alteredRequests = structuredClone(requests),
          alteredCalls = structuredClone(calls);
        mutate(alteredRequests, alteredCalls);
        assert.throws(() => folderVisionEvidence(alteredRequests, alteredCalls, fixture));
      });
  } finally {
    await rm(scratch, { recursive: true });
  }
});
