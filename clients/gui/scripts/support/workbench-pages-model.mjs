import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { respondToSessionName } from "../model-fixture.mjs";

export const pageHtml = `<main><h2>Host page isolation</h2><output id="isolation"></output>
<button id="save">Save state</button><output id="state"></output></main><script>
let parentBlocked=false,storageBlocked=false;
try{void parent.document.body;}catch{parentBlocked=true;}
try{void localStorage.length;}catch{storageBlocked=true;}
document.querySelector('#isolation').textContent=JSON.stringify({origin:self.origin,parentBlocked,storageBlocked});
document.querySelector('#save').onclick=async()=>{try{
await window.zcode.setWidgetState({modelContent:{saved:true},privateContent:{note:'fixture-private'}});
document.querySelector('#state').textContent='saved';
}catch{document.querySelector('#state').textContent='failed';}};
</script>`;
const sse = (delta, finish = "stop") =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n` +
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`;

/** 合成模型仅生成固定页面，经真实工具发布；调用方持有并关闭本次 HTTP server。 */
export async function startPagesModel() {
  const errors = [];
  const messages = [];
  const server = createServer(async (request, response) => {
    try {
      let raw = "";
      for await (const chunk of request) {
        raw += chunk;
        if (raw.length > 8 * 1024 * 1024) throw Error("Fixture request too large");
      }
      const body = JSON.parse(raw);
      if (respondToSessionName(body, response)) return;
      messages.push(body.messages);
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      const user = body.messages.findLastIndex(
        (item) =>
          item.role === "user" &&
          !(typeof item.content === "string" && item.content.startsWith("AReaL runtime context")),
      );
      if (
        body.messages.some(
          (item) =>
            item.role === "system" &&
            typeof item.content === "string" &&
            item.content.startsWith("AReaL permission review."),
        )
      ) {
        const packet = JSON.parse(body.messages[user].content);
        if (packet.tool !== "gen_ui_publish" || packet.arguments.html !== pageHtml)
          throw Error("Unexpected fixture permission request");
        response.end(
          sse({
            content: JSON.stringify({
              decision: "allow",
              digest: packet.digest,
              reason: "Publish the fixed isolated page requested by this fixture.",
            }),
          }),
        );
        return;
      }
      if (!body.tools?.some((tool) => tool.function?.name === "gen_ui_publish")) {
        response.end(sse({ content: "Fixture response" }));
        return;
      }
      const result = body.messages.slice(user + 1).findLast((item) => item.role === "tool");
      if (!result) {
        response.end(
          sse(
            {
              tool_calls: [
                {
                  index: 0,
                  id: randomUUID(),
                  type: "function",
                  function: {
                    name: "gen_ui_publish",
                    arguments: JSON.stringify({ name: "host-isolation", html: pageHtml }),
                  },
                },
              ],
            },
            "tool_calls",
          ),
        );
        return;
      }
      const artifact = JSON.parse(result.content);
      if (typeof artifact.path !== "string") throw Error("Fixture publication failed");
      response.end(
        sse({
          content: `::visualize${JSON.stringify({ path: artifact.path, title: "Host page isolation" })}`,
        }),
      );
    } catch (error) {
      errors.push(error);
      response.destroy();
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    errors,
    messages,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
