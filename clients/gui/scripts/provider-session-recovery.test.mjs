import test from "node:test";
import assert from "node:assert/strict";
import { OpenAIAccount } from "../packages/chatgpt-provider/openai.js";
import { AppProviders } from "../app/src/core/providers.cjs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const grant = (id) => ({
  kind: "grant",
  payload: {
    type: "oauth",
    hostId: "urn:uuid:fixture",
    clientId: `client-${id}`,
    subject: id,
    accountId: id,
    issuer: "https://auth.openai.com",
    access: `access-${id}`,
    refresh: `refresh-${id}`,
    expires: Date.now() + 3600000,
    scopes: ["resource.invoke", "chatgpt.tokens.use.direct"],
  },
});

async function fixture({ terminal = false, held = false, failures = 1 } = {}) {
  let record = grant("old"),
    chain = Promise.resolve(),
    exchanges = 0;
  let release, started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const store = {
    readRecord: async () => structuredClone(record),
    modifyRecord(_key, mutate) {
      const work = chain.then(async () => {
        const next = await mutate(structuredClone(record));
        const old = next?.payload?.records?.primary?.record;
        if (
          old &&
          (old.kind === "registration" || old.payload.refresh === "rotated-refresh") &&
          failures > 0
        ) {
          failures--;
          throw Object.assign(new Error("fixture write failure"), { code: "storage_write_failed" });
        }
        if (next !== undefined) record = next;
        return structuredClone(record);
      });
      chain = work.catch(() => {});
      return work;
    },
  };
  const account = new OpenAIAccount(store, {
    fetch: async () => assert.fail("no external authorization"),
  });
  const second = await account.directory.add();
  await account.directory.view(second).modifyRecord("", () => grant("new"));
  account.auth.refresh = async (current) => {
    exchanges++;
    started();
    if (held) await gate;
    if (terminal)
      throw Object.assign(new Error("fixture terminal"), {
        code: "invalid_grant",
        phase: "refresh",
      });
    return {
      ...current,
      access: "rotated-access",
      refresh: "rotated-refresh",
      expires: Date.now() + 3600000,
    };
  };
  return { account, second, ready, release, exchanges: () => exchanges };
}

for (const terminal of [false, true]) {
  for (const held of [false, true]) {
    test(`${terminal ? "terminal cleanup" : "rotation"} write failure survives ${held ? "in-flight" : "settled"} saved-account switch`, async () => {
      const f = await fixture({ terminal, held });
      try {
        const refresh = f.account.accessToken(undefined, {
          force: true,
          rejectedToken: "access-old",
        });
        const result = Promise.allSettled([refresh]);
        await f.ready;
        if (!held) await result;
        const switched = f.account.selectAccount(f.second);
        f.release();
        await switched;
        assert.equal((await result)[0].status, "rejected");
        assert.equal(await f.account.accessToken(), "access-new");
        const old = await f.account.directory.view("primary").readRecord();
        if (terminal) {
          assert.equal(old.kind, "registration");
          assert.equal(old.payload.access, undefined);
          await assert.rejects(
            f.account.selectAccount("primary"),
            (e) => e.state === "reauth_required",
          );
          assert.equal((await f.account.directory.public()).activeAccountId, f.second);
        } else {
          assert.equal(old.payload.refresh, "rotated-refresh");
          await f.account.selectAccount("primary");
          assert.equal(await f.account.accessToken(), "rotated-access");
        }
        assert.equal(f.exchanges(), 1, "never reuse or exchange the retired refresh token");
      } finally {
        await f.account.close();
      }
    });
  }

  test(`${terminal ? "terminal cleanup" : "rotation"} write failure survives new-account automatic activation during refresh`, async () => {
    const f = await fixture({ terminal, held: true });
    try {
      const refresh = f.account.accessToken(undefined, {
        force: true,
        rejectedToken: "access-old",
      });
      const result = Promise.allSettled([refresh]);
      await f.ready;
      f.account.oauth = async (_action, { onAuth }) => {
        onAuth("https://auth.openai.com/fixture");
        return grant("added").payload;
      };
      const login = f.account.begin({ newAccount: true });
      f.release();
      await login;
      const completion = f.account.attempt?.done;
      await completion;
      await result;
      const selected = (await f.account.directory.public()).activeAccountId;
      assert.notEqual(selected, "primary");
      assert.equal(await f.account.accessToken(), "access-added");
      const old = await f.account.directory.view("primary").readRecord();
      if (terminal) {
        assert.equal(old.kind, "registration");
        await assert.rejects(
          f.account.selectAccount("primary"),
          (e) => e.state === "reauth_required",
        );
      } else {
        assert.equal(old.payload.refresh, "rotated-refresh");
        await f.account.selectAccount("primary");
        assert.equal(await f.account.accessToken(), "rotated-access");
      }
      assert.equal(f.exchanges(), 1);
    } finally {
      await f.account.close();
    }
  });
}

test("persistent storage failure blocks switching and retains the pending rotation", async () => {
  const f = await fixture({ failures: 2 });
  try {
    await assert.rejects(
      f.account.accessToken(undefined, { force: true, rejectedToken: "access-old" }),
    );
    await assert.rejects(
      f.account.selectAccount(f.second),
      (e) => e.code === "storage_write_failed",
    );
    assert.equal((await f.account.directory.public()).activeAccountId, "primary");
    assert.equal(f.account.pendingRotation.record.payload.refresh, "rotated-refresh");
    assert.equal(await f.account.accessToken(), "rotated-access");
    assert.equal(f.exchanges(), 1);
  } finally {
    await f.account.close();
  }
});

test("saved reauthorization of the active registration replaces its failed old rotation", async () => {
  const f = await fixture({ terminal: true });
  try {
    await assert.rejects(
      f.account.accessToken(undefined, { force: true, rejectedToken: "access-old" }),
    );
    f.account.oauth = async (_action, { onAuth }) => {
      onAuth("https://auth.openai.com/fixture");
      return grant("reauthorized").payload;
    };
    f.account.activateAuthorized = async () => false;
    await f.account.begin({ accountId: "primary" });
    await f.account.attempt?.done;
    assert.equal((await f.account.directory.public()).activeAccountId, "primary");
    assert.equal(f.account.pendingRotation, null);
    assert.equal(f.account.terminalFailure, null);
    assert.equal(await f.account.accessToken(), "access-reauthorized");
    assert.equal(f.exchanges(), 1);
  } finally {
    await f.account.close();
  }
});

test("new authorization saved during an old-account Core request never aborts that request", async () => {
  const home = await mkdtemp(join(tmpdir(), "provider-active-auth-"));
  let running = false,
    authorize,
    finishRequest,
    requestStarted,
    inferenceSignal;
  const authorized = new Promise((resolve) => {
    authorize = resolve;
  });
  const finished = new Promise((resolve) => {
    finishRequest = resolve;
  });
  const started = new Promise((resolve) => {
    requestStarted = resolve;
  });
  const backend = {
    home,
    hasWork: () => running,
    activeCommands: 0,
    providerUpdating: false,
    resourcesUpdating: false,
    starting: new Set(),
    projects: new Map(),
    onChange() {},
    save: async (name, value) => writeFile(join(home, name), JSON.stringify(value)),
  };
  // 该跨层 fixture 使用隔离测试记录；安全存储替身不代表真实钥匙串。
  const providers = new AppProviders(backend, {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value),
    decryptString: (value) => value.toString(),
  });
  providers.transport = { port: 0 };
  providers.openaiToken = "fixture-transport";
  const service = await providers.openai();
  try {
    await service.account.directory.view().modifyRecord("", () => grant("old"));
    service.account.oauth = async (_action, { onAuth }) => {
      onAuth("https://auth.openai.com/fixture");
      return authorized;
    };
    service.network.fetch = async (_url, { signal }) => {
      inferenceSignal = signal;
      running = true;
      requestStarted();
      await Promise.race([
        finished,
        new Promise((_, reject) =>
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("fixture abort", "AbortError")),
            { once: true },
          ),
        ),
      ]);
      return new Response(
        'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
        { headers: { "content-type": "text/event-stream" } },
      );
    };
    await service.account.begin({ newAccount: true });
    const completion = service.account.attempt.done;
    service.catalog.models = [{ id: "fixture-model" }];
    await service.ready();
    const response = fetch(service.endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${service.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "fixture-model", input: [], stream: true }),
    });
    const result = response.then(async (r) => ({ status: r.status, body: await r.text() }));
    await started;
    let changes = 0;
    service.account.on("changed", () => changes++);
    const revision = service.account.revision;
    authorize(grant("added").payload);
    await completion;
    assert.equal((await service.account.directory.public()).activeAccountId, "primary");
    assert.equal(
      inferenceSignal.aborted,
      false,
      "production CoreSubscription changed listener must not cancel the old request",
    );
    assert.equal(changes, 0, "saving an inactive account does not broadcast a session change");
    assert.equal(service.account.revision, revision);
    assert.equal(service.catalog.models[0].id, "fixture-model");
    assert.equal(
      (await service.account.directory.public()).accounts.find((a) => !a.active).state,
      "saved",
    );
    finishRequest();
    assert.equal((await result).status, 200);
    running = false;
  } finally {
    finishRequest();
    await providers.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("successful authorization publishes one session change inside activation admission", async () => {
  const f = await fixture({ failures: 0 });
  let locked = false;
  const changes = [];
  try {
    f.account.oauth = async (_action, { onAuth }) => {
      onAuth("https://auth.openai.com/fixture");
      return grant("added").payload;
    };
    f.account.activateAuthorized = async (_id, activate) => {
      locked = true;
      try {
        return await activate();
      } finally {
        locked = false;
      }
    };
    f.account.on("changed", () => changes.push(locked));
    await f.account.begin({ newAccount: true });
    await f.account.attempt?.done;
    assert.deepEqual(changes, [true], "no second invalidation after releasing host admission");
    assert.equal(await f.account.accessToken(), "access-added");
  } finally {
    await f.account.close();
  }
});

for (const operation of ["logout", "selectAccount"]) {
  for (const restartSafe of [true, false]) {
    test(`${operation} uses authoritative Core idle state despite stale desktop work`, async () => {
      const f = await fixture({ failures: 0 });
      const pending = [{ method: "areal/thread/start", params: { requestId: "unknown" } }];
      const backend = {
        hasWork: () => true,
        activeCommands: 0,
        starting: new Set(),
        onChange() {},
        projects: new Map([
          [
            "project",
            {
              id: "project",
              pending,
              service: { serviceId: "core", generation: "generation" },
              client: {
                ready: true,
                async request(method) {
                  assert.equal(method, "areal/server/status");
                  assert.equal(backend.providerUpdating, true);
                  return { restartSafe };
                },
              },
            },
          ],
        ]),
      };
      const providers = new AppProviders(backend, {});
      providers.openai = async () => ({ account: f.account, openaiAccount: f.account });
      providers.readSubscription = async () => {};
      providers.refreshSubscriptionStatus = async () => {};
      try {
        const result = providers.chatgpt({ operation, accountId: f.second });
        if (restartSafe) {
          await result;
          if (operation === "logout") assert.equal(await f.account.read(), null);
          else assert.equal((await f.account.directory.public()).activeAccountId, f.second);
        } else {
          await assert.rejects(result, /停止正在运行/);
          assert.equal((await f.account.directory.public()).activeAccountId, "primary");
        }
        assert.equal(backend.providerUpdating, false);
        assert.equal(backend.projects.get("project").pending, pending);
      } finally {
        await f.account.close();
      }
    });
  }
}
