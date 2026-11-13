import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { nativeHostFixture, nativeCoreProject } from "./remote-native-host-fixture.mjs";
import { pushRelay, phone, until, runWithIsolatedCA } from "./remote-native-push-fixture.mjs";

if (!process.env.RC12_TLS_HOME) {
  test("native model reads use the isolated process CA", async () => {
    await runWithIsolatedCA(import.meta.filename);
  });
} else {
  test(
    "Rust Host publishes a bounded read-only Core model catalog",
    { timeout: 180000 },
    async (t) => {
      const relay = await pushRelay(t);
      const f = await nativeHostFixture(t);
      const project = await nativeCoreProject(t, f, {
        modelDisplayName: "Project model label",
      });
      const proof = { owner: "Rust Host", projectId: project.projectId, checks: [] };
      t.after(() =>
        writeFile(
          join(f.evidence.root, "native-project-models.json"),
          JSON.stringify(proof, null, 2),
        ),
      );
      await f.remote.control({
        operation: "enable",
        relay: relay.origin,
        code: relay.enrollment(),
        confirmed: true,
      });
      await until(async () => (await f.remote.refresh()).connected, "native Relay connected");
      const device = await phone(t, f.remote, project.alias, undefined, true);
      const read = (params = {}, context = { projectId: project.alias }) =>
        device.rpc("project.models", params, undefined, context);
      const description = await device.rpc("host.describe");
      assert.ok(description.result.methods.includes("project.models"));
      const beforeThreads = await project.core.call("thread/list", { limit: 100 });
      const coreModels = await project.core.call("areal/model/list", {});
      const beforeJournal = await f.client.journal(project.projectId).read();
      const first = await read();
      assert.ok(first.result, JSON.stringify(first));
      assert.equal(first.result.serviceGeneration, project.service.generation);
      assert.equal(first.result.projectId, project.alias);
      assert.equal(first.result.gatewayGeneration, device.active.gatewayGeneration);
      assert.equal(first.result.grantRevision, device.active.grantRevision);
      assert.ok(first.result.models.some((model) => model.modelId === "fixture"));
      const keys = new Set([
        "providerId",
        "modelId",
        "displayName",
        "reasoningEffortOptions",
        "available",
        "unavailableReason",
      ]);
      for (const model of first.result.models)
        assert.ok(Object.keys(model).every((key) => keys.has(key)));
      assert.deepEqual(
        first.result.models,
        coreModels.data.slice(0, 200).map((model) => ({
          ...Object.fromEntries(Object.entries(model).filter(([key]) => keys.has(key))),
          displayName: model.displayName ?? model.modelId,
        })),
      );
      assert.equal(
        first.result.models.find((model) => model.providerId === "fixture").displayName,
        "Project model label",
      );
      assert.equal((await read({ cursor: "injected" })).error.code, "INVALID_PARAMS");
      assert.equal((await read({}, { projectId: "other" })).error.code, "FORBIDDEN");
      assert.equal((await device.rpc("project.models")).error.code, "INVALID_PARAMS");
      assert.deepEqual(await project.core.call("thread/list", { limit: 100 }), beforeThreads);
      assert.deepEqual(await f.client.journal(project.projectId).read(), beforeJournal);
      assert.equal(project.modelRequests.length, 0);
      proof.checks.push(
        "project catalog and configured display names match the real Core projection",
        "scoped six-field reads do not create threads, write journal, or invoke the model",
      );

      const created = await project.core.call("areal/thread/start", {
        requestId: randomUUID(),
        cwd: project.workspace,
        agentProfile: { id: "fixture", revision: "v1" },
      });
      const threadId = created.thread.id;
      const journalBeforeOpen = await f.client.journal(project.projectId).read();
      const threadsBeforeOpen = await project.core.call("thread/list", { limit: 100 });
      const opened = await device.rpc("session.open", { threadId }, undefined, {
        projectId: project.alias,
      });
      assert.deepEqual(opened.result?.snapshot.models, first.result.models);
      const catalogChanged = await project.core.call("areal/provider/upsert", {
        provider: {
          id: "snapshot-model",
          revision: 0,
          endpoint: "http://127.0.0.1:1/private-endpoint",
          protocol: "chatCompletions",
          models: ["snapshot-model"],
          parameters: {},
        },
        expectedRevision: 0,
      });
      const configured = await project.core.call("areal/thread/configure", {
        threadId,
        expectedRevision: opened.result.snapshot.configRevision,
        model: { providerId: "fixture", modelId: "fixture" },
      });
      let updated;
      do {
        updated = await device.nextMessage();
      } while (
        updated.event !== "session.updated" ||
        updated.snapshot?.configRevision !== configured.revision
      );
      assert.equal(updated.subscriptionId, opened.result.subscriptionId);
      assert.equal(updated.connectionId, opened.result.connectionId);
      const currentModels = await read();
      assert.deepEqual(updated.snapshot.models, currentModels.result.models);
      assert.ok(updated.snapshot.models.some((model) => model.providerId === "snapshot-model"));
      assert.ok(Buffer.byteLength(JSON.stringify(updated.snapshot)) <= 192 * 1024);
      assert.deepEqual(await f.client.journal(project.projectId).read(), journalBeforeOpen);
      const threadsAfterOpen = await project.core.call("thread/list", { limit: 100 });
      assert.deepEqual(
        threadsAfterOpen.data.map((thread) => thread.id).sort(),
        threadsBeforeOpen.data.map((thread) => thread.id).sort(),
      );
      assert.equal(project.modelRequests.length, 0);
      proof.sessionModels = {
        threadId,
        subscriptionId: opened.result.subscriptionId,
        connectionId: opened.result.connectionId,
        openModels: opened.result.snapshot.models,
        updatedModels: updated.snapshot.models,
        configRevision: updated.snapshot.configRevision,
      };
      proof.checks.push(
        "session.open and session.updated retain the same scoped catalog as project.models",
        "catalog updates preserve the foreground subscription without journal or model effects",
      );
      await project.core.call("areal/provider/remove", {
        id: catalogChanged.id,
        expectedRevision: catalogChanged.revision,
      });
      await device.rpc(
        "session.close",
        { subscriptionId: opened.result.subscriptionId },
        undefined,
        {
          projectId: project.alias,
        },
      );

      const providers = [];
      const upsert = async (id, models, revision = 0) =>
        project.core.call("areal/provider/upsert", {
          provider: {
            id,
            revision,
            endpoint: "http://127.0.0.1:1/private-endpoint",
            protocol: "chatCompletions",
            models,
            parameters: {},
          },
          expectedRevision: revision,
        });
      await upsert("areal_openai", ["stale-account-model"]);
      const staleCore = await project.core.call("areal/model/list", {});
      assert.equal(
        staleCore.data.find((model) => model.providerId === "areal_openai").available,
        true,
      );
      const stale = await read();
      assert.equal(
        stale.result.models.find((model) => model.providerId === "areal_openai").available,
        false,
      );
      proof.checks.push("a Core subscription model without a Host account owner is unavailable");
      for (let index = 0; index < 4; index++) {
        const id = `bounded-${index}-${"p".repeat(118)}`;
        providers.push(
          await upsert(
            id,
            Array.from({ length: 60 }, (_, model) => `model-${model}`),
          ),
        );
      }
      const bounded = await read();
      assert.equal(bounded.result.models.length, 200);
      assert.ok(!JSON.stringify(bounded.result).includes("private-endpoint"));
      for (const provider of providers) {
        await upsert(
          provider.id,
          Array.from({ length: 60 }, (_, model) => `${"x".repeat(250)}-${model}`),
          provider.revision,
        );
      }
      assert.equal((await read()).error.code, "LIMIT_EXCEEDED");
      proof.checks.push(
        "real Core catalogs enforce 200 items, redaction, and the 128KiB response budget",
      );

      for (const provider of providers) {
        await project.core.call("areal/provider/remove", {
          id: provider.id,
          expectedRevision: provider.revision + 1,
        });
      }
      proof.passed = true;
    },
  );
}
