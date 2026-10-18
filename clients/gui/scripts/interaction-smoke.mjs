import { captureSmokeFailure, resizeConversation } from "./smoke-navigation.mjs";
import assert from "node:assert/strict";

import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile, readFile, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktop = join(gui, "app");
const require = createRequire(join(desktop, "package.json"));
const { _electron: electron } = require("playwright-core");
const root = resolve(gui, "../..");
const binary = process.env.AREAL_GUI_EXECUTABLE
  ? resolve(dirname(process.env.AREAL_GUI_EXECUTABLE), "../Resources/areal-core/bin/areal")
  : process.env.AREAL_CORE_BIN || join(root, "target/debug/areal");
assert.ok(binary, "AREAL_CORE_BIN must point to the actual built Core");
const scratch = await mkdtemp("/private/tmp/areal-gui-");
const workspace = join(scratch, "workspace");
await mkdir(workspace);
await mkdir(join(scratch, "user-home"));
execFileSync("git", ["init", "-b", "main"], {
  cwd: workspace,
  stdio: "ignore",
});
await writeFile(join(workspace, "hello.ts"), 'export const hello = "world";\n');
execFileSync("git", ["add", "."], { cwd: workspace });
execFileSync(
  "git",
  ["-c", "user.name=Smoke", "-c", "user.email=smoke@example.invalid", "commit", "-m", "fixture"],
  { cwd: workspace, stdio: "ignore" },
);
await writeFile(join(workspace, "hello.ts"), 'export const hello = "AReaL";\n');
const skill = join(scratch, "skill");
await mkdir(skill);
await writeFile(
  join(skill, "SKILL.md"),
  "---\nname: fixture-skill\ndescription: Deterministic test skill\n---\nExplain the fixture project.\n",
);
const secondSkill = join(scratch, "skill-two");
await mkdir(secondSkill);
await writeFile(
  join(secondSkill, "SKILL.md"),
  "---\nname: fixture-skill\ndescription: Second source\n---\nSECOND_SKILL_CONTENT\n",
);
const pagedContent = "分页正文".repeat(2400) + "\nPAGED_SKILL_END";
await writeFile(
  join(skill, "SKILL.md"),
  "---\nname: fixture-skill\ndescription: Deterministic test skill\n---\n" + pagedContent,
);
const deployment = join(scratch, "desktop.json");
await writeFile(
  deployment,
  JSON.stringify({
    skills: [
      { id: "fixture-skill", revision: "v1", root: skill },
      { id: "fixture-two", revision: "v2", root: secondSkill },
    ],
    profiles: [
      {
        id: "standard",
        revision: "v1",
        displayName: "标准",
        instructions: "Complete the task",
        allowThreadProcesses: true,

        skills: [
          { id: "fixture-skill", revision: "v1" },
          { id: "fixture-two", revision: "v2" },
        ],
      },
    ],
  }),
);
const received = [];
let releaseWrite;
const binarySha256AtStart = createHash("sha256").update(await readFile(binary)).digest("hex");
const server = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  received.push(body);
  const messages = body.messages ?? [];
  const index = messages.findLastIndex(m => m.role === "user" && /(?:write:|question:|browser:)/.test(
    typeof m.content === "string" ? m.content : (m.content ?? []).map(p => p.text ?? "").join("\n")));
  const content = messages[index]?.content;
  const text = typeof content === "string" ? content : (content ?? []).map(p => p.text ?? "").join("\n");
  const responded = messages.slice(index + 1).some(m => m.role === "tool");
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const send = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id:"fixture", choices:[{ index:0, delta, finish_reason }] })}\n\n`);
  if (!responded && text.includes("write:")) {
    const path = text.match(/write:([a-z.-]+)/)[1];
    if (path === "draft.txt") await new Promise(resolve => { releaseWrite = resolve; });
    send({tool_calls:[{index:0,id:"write",type:"function",function:{name:"fs_create",arguments:JSON.stringify({path,text:"approved by user"})}}]});
    send({},"tool_calls");
  } else if (!responded && text.includes("question:")) {
    const mode = text.match(/question:([a-z]+)/)[1];
    const questions = mode === "multi" ? [
      {id:"choice",title:"选择实现方式",options:["最小修改","重构"],allowFreeText:false},
      {id:"note",title:"补充设计要求",allowFreeText:true},
    ] : [{id:"choice",title:mode === "text" ? "补充设计要求" : "选择实现方式",options:mode === "text" ? [] : ["最小修改","重构"],allowFreeText:mode !== "option"}];
    send({tool_calls:[{index:0,id:"question",type:"function",function:{name:"ask_user_question",arguments:JSON.stringify({questions})}}]});
    send({},"tool_calls");
  } else if (!responded && text.includes("browser:describe")) {
    send({tool_calls:[{index:0,id:"browser",type:"function",function:{name:"browser_v1",arguments:JSON.stringify({operation:"describe",parameters:{}})}}]});
    send({},"tool_calls");
  } else {send({content:"INTERACTION_OK"});send({},"stop");}
  res.end("data: [DONE]\n\n");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const endpoint = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
const config = join(scratch, "config.toml");
await writeFile(
  config,
  `schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[permissions]\nmode="ASK_PERMISSIONS"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint=${JSON.stringify(endpoint)}\n`,
);
const env = {
  ...process.env,
  AREAL_GUI: "workbench",
  AREAL_BACKEND: "areal",
  AREAL_CORE_BIN: binary,
  AREAL_CORE_HOME: join(scratch, "core"),
  AREAL_CORE_USER_HOME: join(scratch, "user-home"),
  AREAL_HARNESS_HOME: join(scratch, "runtime"),
  AREAL_CORE_CONFIG: config,
  AREAL_CORE_DESKTOP_CONFIG: deployment,
  AREAL_GUI_USER_DATA: join(scratch, "electron"),
};
delete env.AREAL_CORE_WORKSPACE;
if (process.env.AREAL_GUI_EXECUTABLE) delete env.AREAL_CORE_BIN;
let app,
  page,
  passed = false;
const errors = [],
  frames = [],
  checks = [];
const button = (name) => page.getByRole("button", { name, exact: true });
const state = () => page.evaluate(() => window.arealDesktop.snapshot());
async function call(name, params) {
  const result = await page.evaluate(
    async ({ name, params }) => window.arealDesktop.command(name, params),
    { name, params },
  );
  if (!result.ok) throw Error(result.error.message);
  return result.value;
}
async function until(predicate, label) {
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    const s = await state();
    if (predicate(s)) return s;
    await new Promise((r) => setTimeout(r, 80));
  }
  throw Error("Timeout: " + label);
}
async function shot(name) {
  const clip = await page.evaluate(() => {
    const boxes = [
      ...document.querySelectorAll(
        '.composer-dock, [data-slot="popover-content"], [data-testid="composer-catalog"]',
      ),
    ]
      .map((element) => element.getBoundingClientRect())
      .filter((box) => box.width > 0 && box.height > 0);
    if (!boxes.length) return undefined;
    const x = Math.max(0, Math.min(...boxes.map((box) => box.left)) - 8);
    const y = Math.max(0, Math.min(...boxes.map((box) => box.top)) - 8);
    return {
      x,
      y,
      width: Math.min(innerWidth, Math.max(...boxes.map((box) => box.right)) + 8) - x,
      height: Math.min(innerHeight, Math.max(...boxes.map((box) => box.bottom)) + 8) - y,
    };
  });
  await page.screenshot({
    clip,
    path: join(scratch, name + ".png"),
    scale: "css",
    animations: "disabled",
  });
  frames.push(name + ".png");
}
async function launch() {
  app = await electron.launch({
    executablePath: process.env.AREAL_GUI_EXECUTABLE || require("electron"),
    args: process.env.AREAL_GUI_EXECUTABLE ? [] : [desktop],
    env,
    timeout: 120000,
  });
  app.process().stderr.on("data", (d) => {
    if (String(d).includes("Error")) process.stderr.write(d);
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (e) => errors.push(e.message));
  await page.locator("[data-testid=areal-workbench]").waitFor({ timeout: 120000 });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 960));
}
async function quit() {
  if (!app) return;
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1 });
  });
  await app.close();
  app = null;
}
console.log("Interaction evidence:", scratch);
let pid, tid;
const interaction = (snapshot, kind) => snapshot.projects[0].state.interactions[tid]?.data.findLast(i => i.status === "pending" && i.kind === kind);
const current = snapshot => snapshot.projects[0].state.threads[tid];
try {
  await launch();
  await page.evaluate(() => localStorage.setItem("areal-gui:theme", "data-dense"));
  await page.reload();
  await page.getByTestId("areal-workbench").waitFor();
  await app.evaluate(({ dialog }, workspace) => { dialog.showOpenDialog = async () => ({canceled:false,filePaths:[workspace]}); }, workspace);
  await button("不在项目中工作").click();
  await page.getByRole("menuitem",{name:"新建项目",exact:true}).click();
  await until(s => s.projects[0]?.state?.connected,"project ready");
  pid=(await state()).projects[0].id;
  const input=()=>page.getByTestId("chat-input");
  const send=async text=>{
    await input().fill(text);
    await page.getByTestId("chat-send-button").click();
    await until(s=>Object.values(s.projects[0].state.threads).some(t=>t.turns?.at(-1)?.status==="inProgress"),"admitted turn");
    tid=Object.values((await state()).projects[0].state.threads).find(t=>t.turns?.length)?.id;
    assert.ok(tid,"Core thread created");
  };
  const done=()=>until(s=>current(s)?.turns.at(-1)?.status==="completed","same turn completed");
  const approval=()=>page.getByRole("region",{name:"工具审批",exact:true});
  const question=()=>page.getByRole("region",{name:"需要你的回答",exact:true});
  await send("write:denied.txt");
  await until(s=>interaction(s,"approval"),"approval request");
  const denial=interaction(await state(),"approval");
  await approval().waitFor();
  await shot("01-approval-pending");
  assert.equal(await input().isVisible(),false,"approval replaces ordinary input");
  assert.equal(await approval().locator(".decision-card-label").innerText(),"工具");
  await button("拒绝").click();
  await done();
  await assert.rejects(readFile(join(workspace,"denied.txt")),{code:"ENOENT"});
  assert.equal((await state()).projects[0].state.interactions[tid].data.find(i=>i.requestId===denial.requestId).response.decision,"deny");
  checks.push("deny resumes the original turn without writing the file");

  await send("write:allowed.txt");
  await until(s=>interaction(s,"approval"),"once request");
  // The hidden Lexical editor is mounted, preserving draft ownership.
  await page.evaluate(()=>{const el=document.querySelector('[data-testid="chat-input"]');if(!el)throw Error("missing retained editor")});
  await button("更多授权范围").click();
  await page.getByRole("menuitem",{name:/本任务允许此操作/}).waitFor();
  await shot("02-approval-scope-menu");
  await page.keyboard.press("Escape");
  await button("允许一次").click();
  await done();
  assert.equal(await readFile(join(workspace,"allowed.txt"),"utf8"),"approved by user");
  await approval().waitFor({state:"hidden"});
  checks.push("allowOnce writes the requested file and restores the normal composer");

  await send("write:session.txt");
  await until(s=>interaction(s,"approval"),"session request");
  await button("更多授权范围").click();
  await page.getByRole("menuitem",{name:/本任务允许此操作/}).click();
  await done();
  assert.equal(await readFile(join(workspace,"session.txt"),"utf8"),"approved by user");
  assert.equal((await state()).projects[0].state.interactions[tid].data.at(-1).response.decision,"allowSession");
  checks.push("task scope reaches the original Core approval response");

  await send("write:project.txt");
  await until(s=>interaction(s,"approval"),"project request");
  await button("更多授权范围").click();
  await page.getByRole("menuitem",{name:/本项目允许此操作/}).click();
  await done();
  assert.equal(await readFile(join(workspace,"project.txt"),"utf8"),"approved by user");
  assert.equal((await state()).projects[0].state.interactions[tid].data.at(-1).response.decision,"allowProject");
  checks.push("project scope reaches the original Core approval response");

  const configBefore = (await state()).projects[0].configurations[tid];
  await call("configure", {projectId:pid,threadId:tid,options:{...configBefore.options,approvalTools:["fs_create"]}});
  await send("write:forced.txt");
  await until(s=>interaction(s,"approval"),"forced approval");
  assert.equal(interaction(await state(),"approval").effectivePermissions.rememberAllowed,false);
  assert.equal(await button("更多授权范围").count(),0,"Core forced approval offers no remembered scope");
  await button("允许一次").click();
  await done();
  assert.equal(await readFile(join(workspace,"forced.txt"),"utf8"),"approved by user");
  await call("configure",{projectId:pid,threadId:tid,options:configBefore.options});
  checks.push("Core forced approval retains allowOnce and hides remembered scopes");

  await send("write:draft.txt");
  await input().fill("保留的后续草稿");
  await until(()=>!!releaseWrite,"model holds approval for the user draft");
  releaseWrite();
  await until(s=>interaction(s,"approval"),"draft approval");
  assert.equal(await input().isVisible(),false);
  await button("允许一次").click();
  await done();
  assert.equal(await input().innerText(),"保留的后续草稿");
  await input().fill("");
  checks.push("ordinary composer draft survives approval replacement without remounting");

  await send("question:option");
  await until(s=>interaction(s,"question"),"option request");
  const optionRequest=interaction(await state(),"question");
  await question().waitFor();
  assert.equal(interaction(await state(),"question").requestId,optionRequest.requestId,"initial screen never submits");
  assert.equal(await page.locator('.interaction-composer-compact').isVisible(),true);
  assert.equal(await question().locator(".decision-card-body").evaluate(el=>el.scrollWidth<=el.clientWidth),true,"question options have no horizontal overflow");
  assert.equal(await question().getByRole("button",{name:"发送",exact:true}).isEnabled(),false,"unanswered question cannot submit a default");
  await shot("03-question-pending");
  await page.getByRole("radio",{name:/重构/}).click();
  await done();
  assert.equal((await state()).projects[0].state.interactions[tid].data.find(i=>i.requestId===optionRequest.requestId).response.answers.choice,"重构");
  await page.locator('[data-question-answer]').last().getByText("重构",{exact:true}).waitFor();
  await page.screenshot({path:join(scratch,"04-question-answer-full.png"),scale:"css",animations:"disabled"});
  frames.push("04-question-answer-full.png");
  await shot("04-question-answer");
  checks.push("explicit option responds to the same Core request and replays its authoritative answer");

  await send("question:text");
  await until(s=>interaction(s,"question"),"free text request");
  const reply=page.getByLabel("自定义回答：补充设计要求",{exact:true});
  await reply.fill("保留原有审批逻辑");
  await button("收起问题").click();
  assert.ok(interaction(await state(),"question"),"close never completes Core request");
  await button("展开待回答问题").click();
  assert.equal(await reply.inputValue(),"保留原有审批逻辑");
  await button("跳过").click();
  await button("展开待回答问题").click();
  assert.equal(await reply.inputValue(),"保留原有审批逻辑");
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(800,700));
  await shot("05-question-narrow");
  const bounds=await question().boundingBox();
  const viewportWidth = await page.evaluate(()=>innerWidth);
  assert.ok(bounds.x>=0&&bounds.x+bounds.width<=viewportWidth,"card remains within the actual native minimum window");
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1440,960));
  await reply.press("Meta+Enter");
  await done();
  await page.locator('[data-question-answer]').last().getByText("保留原有审批逻辑",{exact:true}).waitFor();
  checks.push("close/skip retain custom draft and pending Core question; explicit submit resumes");

  await send("question:multi");
  await until(s=>interaction(s,"question"),"multi request");
  await page.getByRole("radio",{name:/最小修改/}).click();
  assert.ok(interaction(await state(),"question"),"multi option does not submit early");
  await question().getByRole("button",{name:"下一题",exact:true}).click();
  await page.getByLabel("自定义回答：补充设计要求",{exact:true}).fill("统一卡片样式");
  await question().getByRole("button",{name:"上一题",exact:true}).click();
  assert.equal(await page.getByRole("radio",{name:/最小修改/}).isChecked(),true);
  await question().getByRole("button",{name:"下一题",exact:true}).click();
  await question().getByRole("button",{name:"发送",exact:true}).click();
  await done();
  assert.deepEqual((await state()).projects[0].state.interactions[tid].data.at(-1).response.answers,{choice:"最小修改",note:"统一卡片样式"});
  await shot("06-multi-answer");
  checks.push("multiple answers preserve per-question drafts and submit atomically to Core");

  await page.reload();
  await page.getByTestId("areal-workbench").waitFor();
  await page.locator('[data-question-answer]').last().getByText("统一卡片样式",{exact:true}).waitFor();
  checks.push("answer bubbles restore from authoritative tool history after renderer reload");
  await send("browser:describe");
  await until(s=>interaction(s,"approval"),"native browser approval");
  assert.equal(interaction(await state(),"approval").tool,"browser_v1");
  assert.equal(await approval().locator(".decision-card-label").innerText(),"浏览器");
  await shot("07-browser-approval");
  await button("允许一次").click();
  await done();
  const browserCall = current(await state()).turns.at(-1).items.find(i=>i.type==="dynamicToolCall"&&i.tool==="browser_v1");
  assert.equal(browserCall.success,true,"Core/browser host completes the approved description");
  checks.push("real Browser approval uses the shared card and retains the existing host/Core execution path");

  assert.equal(errors.length,0,"renderer has no page errors");
  await writeFile(join(scratch,"final-state.json"),JSON.stringify(await state(),null,2));
  assert.equal(createHash("sha256").update(await readFile(binary)).digest("hex"),binarySha256AtStart,"Core binary stayed frozen during acceptance");
  passed=true;
  console.log("PASS:",checks);
} catch(error){
  errors.push(error.stack||String(error));
  await writeFile(join(scratch,"received.json"),JSON.stringify(received,null,2));
  if(page) await writeFile(join(scratch,"failure-state.json"),JSON.stringify(await state(),null,2)).catch(()=>{});
  console.error(error);
  process.exitCode=1;
  if(page) await page.screenshot({path:join(scratch,"failure.png")}).catch(()=>{});
} finally {
  await quit();
  try {
    const { ServiceConnection } = require(join(desktop, "src/core/service-client.cjs"));
    const connection = new ServiceConnection();
    try {
      await connection.connect(
        JSON.parse(await readFile(join(scratch, "core/service.json"), "utf8")),
      );
      await connection.request("stopService", { protocol: "areal.desktop-service.v1" }, true);
      checks.push("explicit safe service stop completes");
    } finally {
      connection.close();
    }
  } catch (error) {
    console.error("Adapter fixture cleanup:", error.message);
    if (passed) {
      passed = false;
      process.exitCode = 1;
      errors.push(`Explicit safe stop failed: ${error.message}`);
    }
    // 仅清理本次隔离 home 中的服务；失败不遗留模型任务或后台进程。
    try {
      const instances = JSON.parse(
        execFileSync(binary, ["service", "list", "--json"], { env, encoding: "utf8" }),
      );
      for (const instance of instances)
        if (instance.workspace === workspace && instance.state !== "stopped") {
          execFileSync(
            binary,
            ["service", "stop", "--instance", instance.serviceId, "--cancel", "--json"],
            { env, timeout: 120000, stdio: "pipe" },
          );
        }
    } catch (failure) {
      console.error("Core fixture cleanup:", failure.message);
    }
    try {
      const metadata = JSON.parse(await readFile(join(scratch, "core/service.json"), "utf8"));
      process.kill(metadata.pid, "SIGTERM");
    } catch {}
  }
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  const sourceFiles = {};
  for (const path of execFileSync(
    "git",
    ["ls-files", "--modified", "--others", "--exclude-standard", "-z"],
    { cwd: root },
  )
    .toString()
    .split("\0")
    .filter(Boolean)) {
    sourceFiles[path] = createHash("sha256")
      .update(await readFile(join(root, path)))
      .digest("hex");
  }
  const diff = execFileSync("git", ["diff", "--binary", "HEAD"], { cwd: root });
  await writeFile(
    join(scratch, "manifest.json"),
    JSON.stringify(
      {
        passed,
        commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root }).toString().trim(),
        sourceFiles,
        binarySha256: createHash("sha256")
          .update(await readFile(binary))
          .digest("hex"),
        diffSha256: createHash("sha256").update(diff).digest("hex"),
        binary,
        platform: process.platform,
        arch: process.arch,
        runtime: "real Electron + real Rust Core/Runtime + deterministic local HTTP/SSE model",
        nativeDialogs: "project picker and archive/quit confirmations injected",
        scratch,
        frames,
        checks,
        errors,
      },
      null,
      2,
    ),
  );
}
