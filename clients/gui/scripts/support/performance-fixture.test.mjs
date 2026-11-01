import assert from "node:assert/strict";
import { test } from "node:test";
import { deltaCount, performanceServers, streamText } from "./performance-fixture.mjs";

test("auxiliary requests with a stream marker do not start another performance stream", async () => {
  const server = await performanceServers();
  try {
    const send = async (system) => {
      const response = await fetch(server.modelUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: [
            { role: "system", content: system },
            { role: "user", content: "PERFORMANCE_STREAM" },
          ],
        }),
      });
      assert.equal(response.status, 200);
      const raw = await response.text();
      const events = raw
        .trim()
        .split("\n\n")
        .map((event) => event.slice(6));
      assert.equal(events.pop(), "[DONE]");
      return events.map((event) => JSON.parse(event).choices[0]);
    };
    for (const system of [
      "Generate a concise semantic session title",
      "Predict the next user prompt from the conversation data",
    ]) {
      const events = await send(system);
      assert.equal(events.map((event) => event.delta.content ?? "").join(""), "Fixture");
      assert.equal(events.at(-1).finish_reason, "stop");
    }
    const events = await send("Main task");
    assert.equal(events.filter((event) => event.delta.content).length, deltaCount);
    assert.equal(events.map((event) => event.delta.content ?? "").join(""), streamText);
    assert.equal(events.at(-1).finish_reason, "stop");
    assert.deepEqual(
      server.state.requests.map((request) => request.kind),
      ["auxiliary", "auxiliary", "stream"],
    );
    assert.deepEqual(
      server.state.requests.map((request) => request.success),
      [true, true, true],
    );
    assert.equal(server.state.requests[2].deltas, deltaCount);
    assert.deepEqual(server.state.failures, []);
  } finally {
    await server.close();
  }
});
