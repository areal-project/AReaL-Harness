import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { chmod, lstat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { nativeHostFixture } from "./remote-native-host-fixture.mjs";

const { GuiHostProjects } = createRequire(import.meta.url)("../app/src/core/gui-host-projects.cjs");
export const taskContractProject = "a".repeat(24);
export async function taskContractHost() {
  const cleanup = [],
    sources = [],
    cases = [];
  const fixture = await nativeHostFixture(
    { after: (fn) => cleanup.push(fn), diagnostic: console.log },
    { deferNative: true },
  );
  return {
    async register(backend, root) {
      const sourceRoot = join(fixture.evidence.root, "sources", randomUUID());
      const source = new GuiHostProjects({
        binary: fixture.evidence.binary,
        home: fixture.home,
        singletonHeld: true,
        source: {
          profile: join(sourceRoot, "profile"),
          coreHome: join(sourceRoot, "core"),
          legacyServiceHome: join(sourceRoot, "legacy"),
        },
        encryption: fixture.source.options.encryption,
      });
      sources.push(source);
      await source.init();
      await source.register(randomUUID(), { id: taskContractProject, root });
      backend.host = source;
      const journal = source.journal(taskContractProject);
      const change = journal.change.bind(journal),
        request = source.client.request.bind(source.client);
      let failure,
        blockWrite = false,
        directory;
      const faults = [];
      cases.push({
        root,
        sourceId: source.sourceId,
        projectId: source.resolve(taskContractProject).projectId,
        faults,
      });
      journal.change = (mutate) =>
        change(async (snapshot) => {
          const before = new Set(Object.keys(snapshot.outcomes));
          const next = await mutate(snapshot);
          blockWrite =
            failure === "pending" ||
            (failure === "outcome" && Object.keys(next.outcomes).some((id) => !before.has(id)));
          return next;
        });
      source.client.request = async (method, params) => {
        if (method === "journal.prepare" && blockWrite) {
          assert.equal(typeof directory, "string");
          const mode = (await lstat(directory)).mode & 0o777;
          assert.equal(mode, 0o700);
          await chmod(directory, 0o500);
          try {
            await request(method, params);
            assert.fail("the actual Host prepare must reject its read-only transfer directory");
          } catch (error) {
            const original = await request("host.operation", { requestId: params.requestId });
            faults.push({
              requestId: params.requestId,
              method,
              code: error.code,
              message: error.message,
              original,
              directory,
              mode,
            });
            assert.match(error.message, /Permission denied|permission denied/);
            throw new Error("disk full", { cause: error });
          } finally {
            await chmod(directory, mode);
            blockWrite = false;
          }
        }
        const result = await request(method, params);
        if (method === "journal.read") directory = dirname(result.snapshotPath);
        return result;
      };
      return {
        journal,
        faults,
        failJournal: (phase) => {
          failure = phase;
        },
      };
    },
    async close() {
      await writeFile(
        join(fixture.evidence.root, "task-contract-storage.json"),
        JSON.stringify({ cases }, null, 2),
      );
      for (const source of sources) source.close();
      for (const fn of cleanup.toReversed()) await fn();
    },
  };
}
