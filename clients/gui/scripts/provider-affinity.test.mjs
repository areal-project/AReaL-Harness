import test from "node:test";
import assert from "node:assert/strict";
import { ResponseAffinity } from "../packages/chatgpt-provider/affinity.js";
import { CoreSubscription } from "../packages/chatgpt-provider/core.js";

const owner = (thread = "thread-a", turn = "turn-a", purpose = "solve") => ({
  "x-areal-thread-id": thread,
  "x-areal-turn-id": turn,
  "x-areal-model-purpose": purpose,
});
const response = (state, status = 200) =>
  new Response(
    'data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n',
    {
      status,
      headers: {
        "Content-Type": "text/event-stream",
        ...(state ? { "x-codex-turn-state": state } : {}),
      },
    },
  );

test("routing state is once-only and scoped by account, model, thread, turn and purpose", () => {
  const pool = new ResponseAffinity();
  const first = pool.begin(owner(), "model-a", 1);
  assert.equal(first.headers["session-id"], "thread-a");
  assert.equal(first.headers["x-codex-turn-state"], undefined);
  first.capture(response("route-a"));
  pool.begin(owner(), "model-a", 1).capture(response("route-b"));
  assert.equal(pool.begin(owner(), "model-a", 1).headers["x-codex-turn-state"], "route-a");
  for (const [headers, model, account] of [
    [owner("thread-b"), "model-a", 1],
    [owner("thread-a", "turn-b"), "model-a", 1],
    [owner("thread-a", "turn-a", "summary"), "model-a", 1],
    [owner("thread-a", "turn-a", "permissionReview"), "model-a", 1],
    [owner(), "model-b", 1],
    [owner(), "model-a", 2],
  ])
    assert.equal(pool.begin(headers, model, account).headers["x-codex-turn-state"], undefined);
  assert.equal(pool.begin({}, "model-a", 1), null);
  assert.equal(pool.begin(owner("thread-a", "turn-a", "unknown"), "model-a", 1), null);
  assert.equal(pool.begin(owner("untrusted\r\nvalue"), "model-a", 1), null);
});

test("eviction, expiry and account reset reject late state without unbounded retention", () => {
  let now = 0;
  const pool = new ResponseAffinity({ now: () => now, maxEntries: 2, idleMs: 10 });
  const old = pool.begin(owner(), "model", 0);
  pool.begin(owner("b"), "model", 0);
  pool.begin(owner("c"), "model", 0);
  assert.equal(pool.entries.size, 2);
  old.capture(response("late-evicted"));
  const fresh = pool.begin(owner(), "model", 0);
  assert.equal(fresh.headers["x-codex-turn-state"], undefined);
  fresh.capture(response("failed", 503));
  assert.equal(pool.begin(owner(), "model", 0).headers["x-codex-turn-state"], undefined);
  fresh.capture(response("valid"));
  now = 10;
  assert.equal(pool.begin(owner(), "model", 0).headers["x-codex-turn-state"], undefined);
  const late = pool.begin(owner(), "model", 0);
  pool.clear();
  late.capture(response("late-reset"));
  assert.equal(pool.entries.size, 0);
});

async function relay(t, sendUpstream, kind = "codex") {
  const access =
    "e30." +
    Buffer.from(
      JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } }),
    ).toString("base64url") +
    ".fixture";
  const grant = {
    kind: "grant",
    payload: {
      type: "oauth",
      access,
      refresh: "fixture",
      expires: Date.now() + 3600000,
      ...(kind === "openai"
        ? {
            clientId: "fixture-client",
            subject: "fixture-subject",
            hostId: "urn:uuid:fixture",
            issuer: "https://auth.openai.com",
            scopes: ["resource.invoke", "chatgpt.tokens.use.direct"],
          }
        : {}),
    },
  };
  const audits = [];
  let record = grant;
  let chain = Promise.resolve();
  const service = new CoreSubscription({
    store: {
      readRecord: async () => structuredClone(record),
      modifyRecord: (_key, mutate) => {
        const work = chain.then(async () => {
          record = (await mutate(structuredClone(record))) ?? record;
          return structuredClone(record);
        });
        chain = work.catch(() => {});
        return work;
      },
    },
    kind,
    token: "fixture-loopback",
    models: [{ id: "fixture" }],
    fetch: sendUpstream,
    onRequest: (audit) => audits.push(audit),
  });
  // OpenAI 的正式目录来自独立发现；本地夹具只固定本次可用模型，不访问真实账号。
  if (kind === "openai") service.catalog.models = [{ id: "fixture" }];
  await service.ready();
  t.after(() => service.close());
  const send = async (headers = owner(), signal) => {
    const result = await fetch(service.endpoint, {
      method: "POST",
      signal,
      headers: {
        Authorization: "Bearer fixture-loopback",
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify({
        model: "fixture",
        input: [{ role: "user", content: "unchanged" }],
        stream: true,
      }),
    });
    await result.text();
    return result.status;
  };
  return { service, audits, send };
}

test("OpenAI direct relay scopes routing state and records presence without replay", async (t) => {
  const sent = [];
  const f = await relay(
    t,
    async (url, options) => {
      assert.equal(url, "https://api.openai.com/v1/responses");
      sent.push(options);
      return response("direct-route-" + sent.length);
    },
    "openai",
  );
  assert.equal(await f.send(), 200);
  assert.equal(await f.send(), 200);
  assert.equal(await f.send(owner("thread-a", "turn-b")), 200);
  assert.deepEqual(
    sent.map((x) => x.headers["x-codex-turn-state"]),
    [undefined, "direct-route-1", undefined],
  );
  assert(sent.every((x) => x.headers["session-id"] === "thread-a"));
  assert(sent.every((x) => x.body === sent[0].body));
  assert.equal(f.audits[1].sessionIdentitySent, true);
  assert.equal(f.audits[1].turnStateSent, true);
  assert.equal(f.audits[1].turnStateReceived, true);
  assert(!JSON.stringify(f.audits).includes("direct-route-"));
  assert.equal(sent.length, 3);
});

test("SIWC HTTP relay requests priority for Fast and preserves the actual default tier", async (t) => {
  const sent = [];
  const terminal =
    'data: {"type":"response.completed","response":{"status":"completed","service_tier":"default","output":[]}}\n\n';
  const f = await relay(
    t,
    async (url, options) => {
      assert.equal(url, "https://api.openai.com/v1/responses");
      sent.push(JSON.parse(options.body));
      return new Response(terminal, { headers: { "Content-Type": "text/event-stream" } });
    },
    "openai",
  );
  for (const tier of ["fast", "default", undefined]) {
    const result = await fetch(f.service.endpoint, {
      method: "POST",
      headers: {
        Authorization: "Bearer fixture-loopback",
        "Content-Type": "application/json",
        ...owner(),
      },
      body: JSON.stringify({
        model: "fixture",
        input: [{ role: "user", content: "unchanged" }],
        stream: true,
        service_tier: tier,
        reasoning: { effort: "high" },
      }),
    });
    assert.equal(result.status, 200);
    assert.equal(await result.text(), terminal);
  }
  assert.deepEqual(
    sent.map((body) => body.service_tier),
    ["priority", "default", undefined],
  );
  assert.equal(Object.hasOwn(sent[2], "service_tier"), false);
  assert(sent.every((body) => body.reasoning.effort === "high"));
  assert.equal(sent.length, 3);
});

test("production relay preserves body, routes continuations and clears state on account change", async (t) => {
  const sent = [];
  const f = await relay(t, async (_url, options) => {
    sent.push(options);
    return response("opaque-route-" + sent.length);
  });
  await f.send();
  await f.send();
  await f.send();
  await f.send(owner("thread-a", "turn-b"));
  f.service.account.changed();
  await f.send();
  assert.deepEqual(
    sent.map((x) => x.headers["x-codex-turn-state"]),
    [undefined, "opaque-route-1", "opaque-route-1", undefined, undefined],
  );
  assert(sent.every((x) => x.headers["session-id"] === "thread-a"));
  assert(sent.every((x) => x.body === sent[0].body));
  assert(!JSON.stringify(f.audits).includes("opaque-route"));
  assert.equal(sent.length, 5, "no inference replay");
});

test("late response to a cancelled request cannot poison a later continuation", async (t) => {
  let release, started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const sent = [];
  const f = await relay(t, async (_url, options) => {
    sent.push(options);
    if (sent.length === 1) {
      started();
      await held;
      return response("late-cancelled");
    }
    return response("current");
  });
  const controller = new AbortController();
  const pending = f.send(owner(), controller.signal);
  const settled = assert.rejects(pending, { name: "AbortError" });
  await ready;
  controller.abort();
  await settled;
  await f.send();
  release();
  await new Promise((resolve) => setImmediate(resolve));
  await f.send();
  assert.equal(sent[1].headers["x-codex-turn-state"], undefined);
  assert.equal(sent[2].headers["x-codex-turn-state"], "current");
  assert.equal(sent.length, 3);
});
