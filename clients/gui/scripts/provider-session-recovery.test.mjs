import test from "node:test";
import assert from "node:assert/strict";
import { OpenAIAccount } from "../packages/chatgpt-provider/openai.js";

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
