import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import tls from "node:tls";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { certificates, relayFixture, waitFor } from "./remote-relay-fixture.mjs";
import { nativeHostFixture } from "./remote-native-host-fixture.mjs";

test("process CA trust covers Rust enrollment, WSS and saved registration across teams", async (t) => {
  const teams = [];
  for (const name of ["A", "B"]) {
    const home = await certificates(`RC12 team ${name} test CA`);
    t.after(() => rm(home, { recursive: true, force: true }));
    teams.push({ name, home, ca: await readFile(join(home, "ca.pem"), "utf8") });
  }
  await t.test("combined process CA trust accepts both the original and added roots", async (t) => {
    const tlsHome = await mkdtemp(join(tmpdir(), "rc12-combined-ca-"));
    t.after(() => rm(tlsHome, { recursive: true, force: true }));
    await writeFile(join(tlsHome, "ca.pem"), teams.map((team) => team.ca).join("\n"));
    for (const team of teams) {
      const relay = await relayFixture(t, { tlsHome: team.home });
      const f = await nativeHostFixture(t, { tlsHome });
      await f.remote.control({
        operation: "enable",
        relay: relay.origin,
        code: relay.admin("enrollment").code,
        confirmed: true,
      });
      await waitFor(async () => (await f.remote.refresh()).connected);
      assert.ok(relay.acceptedTlsConnections >= 2);
      f.evidence.tls = {
        scenario: `combined trust team ${team.name}`,
        acceptedHandshakes: relay.acceptedTlsConnections,
        connected: true,
      };
    }
  });
  for (const team of teams) {
    await t.test(`team ${team.name}`, async (t) => {
      const relay = await relayFixture(t, { tlsHome: team.home });
      const f = await nativeHostFixture(t, { tlsHome: team.home });
      await f.remote.control({
        operation: "enable",
        relay: relay.origin,
        code: relay.admin("enrollment").code,
        confirmed: true,
      });
      await waitFor(async () => (await f.remote.refresh()).connected);
      assert.ok(relay.acceptedTlsConnections >= 2);
      const saved = await f.persisted();
      await f.remote.control({ operation: "disable" });
      assert.equal((await f.remote.refresh()).connected, false);
      assert.equal(f.remote.state().enabled, false);
      const acceptedBeforeRestore = relay.acceptedTlsConnections;
      const restored = await nativeHostFixture(t, { config: saved, tlsHome: team.home });
      await waitFor(async () => (await restored.remote.refresh()).connected);
      assert.ok(relay.acceptedTlsConnections > acceptedBeforeRestore);
      const restoredConfig = await restored.persisted();
      assert.ok(restoredConfig.identity === saved.identity, "restored Noise identity matches");
      assert.ok(
        restoredConfig.room === saved.room && restoredConfig.capability === saved.capability,
        "the new Rust Host restores the original registration",
      );
      assert.notEqual(restored.evidence.hostPid, f.evidence.hostPid);
      restored.evidence.tls = {
        scenario: `saved registration team ${team.name}`,
        oldHostDisabled: true,
        sameNoiseIdentity: true,
        sameRegistration: true,
        acceptedHandshakes: relay.acceptedTlsConnections - acceptedBeforeRestore,
        connected: true,
      };
      await restored.remote.control({ operation: "disable" });

      for (const [label, tlsHome, certificate, expected] of [
        [
          "other team",
          teams.find((other) => other !== team).home,
          "server.pem",
          /UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT_LOCALLY/,
        ],
        ["wrong hostname", team.home, "wrong.pem", /ERR_TLS_CERT_ALTNAME_INVALID/],
        ["expired", team.home, "expired.pem", /CERT_HAS_EXPIRED/],
      ]) {
        await t.test(`reject ${label} for HTTPS and WSS`, async (t) => {
          const invalid = await relayFixture(t, { tlsHome, certificate });
          const address = new URL(invalid.origin);
          const probe = tls.connect({
            host: address.hostname,
            port: Number(address.port),
            ca: team.ca,
            rejectUnauthorized: true,
          });
          t.after(() => probe.destroy());
          const [probeError] = await once(probe, "error", { signal: AbortSignal.timeout(5000) });
          assert.match(probeError.code, expected);
          probe.destroy();
          await waitFor(() => invalid.tlsHandshakeErrors > 0);
          const beforeEnrollment = invalid.tlsHandshakeErrors;
          const rejected = await nativeHostFixture(t, { tlsHome: team.home });
          const beforeConfig = await rejected.client.request("remote.read", {});
          const originalReceipt = JSON.parse(
            await readFile(join(rejected.home, "host/remote-state.json"), "utf8"),
          ).receipt;
          assert.equal(originalReceipt.method, "remote.replace");
          assert.equal(originalReceipt.revision, beforeConfig.revision);
          const operations = join(rejected.home, "host/remote-operations");
          const beforeOperations = new Set(await readdir(operations));
          const isEnrollment = (operation) =>
            operation?.method === "remote.gateway.control" &&
            operation.ephemeral === true &&
            operation.sourceId === rejected.source.sourceId &&
            operation.hostId === rejected.client.hostId &&
            operation.generation === rejected.client.generation &&
            operation.previousRevision === beforeConfig.revision;
          try {
            await assert.rejects(
              rejected.remote.control({
                operation: "enable",
                relay: invalid.origin,
                code: invalid.admin("enrollment").code,
                confirmed: true,
              }),
              (error) => error.code === "enrollment-failed" && expected.test(error.message),
            );
          } catch (error) {
            try {
              const added = (await readdir(operations)).filter(
                (name) => !beforeOperations.has(name),
              );
              for (const name of added) {
                const stored = JSON.parse(await readFile(join(operations, name), "utf8"));
                if (!isEnrollment(stored)) continue;
                const { operation } = await rejected.client.operation(stored.requestId);
                if (!isEnrollment(operation) || operation.state !== "outcomeUnknown") continue;
                rejected.evidence.unresolvedEnrollment = {
                  requestId: operation.requestId,
                  state: operation.state,
                  sourceId: operation.sourceId,
                };
                const destination = join(rejected.evidence.root, "unresolved-relay-data");
                await cp(join(invalid.home, "data"), destination, { recursive: true });
                rejected.evidence.unresolvedEnrollment.relayData = destination;
              }
            } catch {
              rejected.evidence.unresolvedEnrollmentPreservationFailed = true;
            }
            throw error;
          }
          const added = (await readdir(operations)).filter((name) => !beforeOperations.has(name));
          const receipts = await Promise.all(
            added.map(async (name) => JSON.parse(await readFile(join(operations, name), "utf8"))),
          );
          const enrollments = receipts.filter(isEnrollment);
          assert.equal(enrollments.length, 1);
          for (const receipt of receipts.filter((value) => !isEnrollment(value))) {
            assert.equal(receipt.method, "remote.replace");
            assert.deepEqual(receipt, originalReceipt);
          }
          rejected.evidence.restoredConfigurationReceipt = {
            requestId: originalReceipt.requestId,
            revision: originalReceipt.revision,
            sha256: createHash("sha256").update(JSON.stringify(originalReceipt)).digest("hex"),
            materialized: receipts.some(
              (receipt) => receipt.requestId === originalReceipt.requestId,
            ),
          };
          const stored = enrollments[0];
          const { operation } = await rejected.client.operation(stored.requestId);
          assert.ok(isEnrollment(operation));
          assert.equal(operation.requestId, stored.requestId);
          assert.equal(operation.sourceId, rejected.source.sourceId);
          assert.equal(operation.method, "remote.gateway.control");
          assert.equal(operation.state, "blocked");
          assert.equal(operation.error.code, "enrollment-failed");
          assert.deepEqual(await rejected.client.request("remote.read", {}), beforeConfig);
          await waitFor(() => invalid.tlsHandshakeErrors > beforeEnrollment);
          assert.equal((await rejected.remote.refresh()).enabled, false);
          assert.equal(rejected.remote.state().connected, false);
          assert.equal(invalid.acceptedTlsConnections, 0);
          rejected.evidence.tls = {
            scenario: label,
            path: "Rust HTTPS enrollment",
            fixtureProbeError: probeError.code,
            requestId: operation.requestId,
            receiptState: operation.state,
            failedHandshakes: invalid.tlsHandshakeErrors - beforeEnrollment,
            acceptedHandshakes: 0,
            connected: false,
          };
          const beforeReconnect = invalid.tlsHandshakeErrors;
          const reconnect = await nativeHostFixture(t, {
            config: { ...saved, relay: invalid.origin },
            tlsHome: team.home,
          });
          await waitFor(() => invalid.tlsHandshakeErrors > beforeReconnect);
          assert.equal((await reconnect.remote.refresh()).connected, false);
          assert.equal(invalid.acceptedTlsConnections, 0);
          assert.deepEqual(await reconnect.persisted(), { ...saved, relay: invalid.origin });
          reconnect.evidence.tls = {
            scenario: label,
            path: "Rust saved-registration WSS in a new isolated Host",
            failedHandshakes: invalid.tlsHandshakeErrors - beforeReconnect,
            acceptedHandshakes: 0,
            connected: false,
          };
          await reconnect.remote.control({ operation: "disable" });
        });
      }
    });
  }
});
