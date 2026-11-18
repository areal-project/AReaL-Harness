import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(new URL("../../app/package.json", import.meta.url));
const { GuiSourceSession } = require("@areal/client/gui-source");

export async function attachPublishedGuiSource(client, { binary, home, source, user, config }) {
  const session = new GuiSourceSession({ binary, home, source, singletonHeld: true });
  try {
    await session.publish({ deferCredentials: true });
    assert.equal(session.client.hostId, client.hostId);
    assert.equal(session.client.generation, client.generation);
    const launch = await session.prepareNative(
      {
        binary,
        home: source.coreHome,
        guiProfile: source.profile,
        hostHome: home,
        harnessHome: source.legacyServiceHome,
        userHome: user,
        configHome: user,
        config,
      },
      process.env,
    );
    session.client.desktopCoreEvent = () => {};
    const { attachmentId } = await session.client.request("desktop.core.subscribe", {
      sourceId: session.sourceId,
      options: launch.options,
      environmentCredentials: launch.environmentCredentials,
    });
    assert(attachmentId);
    return session;
  } catch (error) {
    session.close();
    throw error;
  }
}

export async function ensureFixtureProject(client, projectId) {
  const requestId = randomUUID();
  const result = await client.request("project.ensure", {
    requestId,
    expectedGeneration: client.generation,
    projectId,
  });
  assert.equal(result.project.registration.projectId, projectId);
  assert.equal(result.project.state, "ready");
  assert(result.service?.generation, "running Core generation required");
  return { requestId, generation: result.service.generation };
}
