const { createHash, randomUUID } = require("node:crypto");
const { execFileSync, spawn } = require("node:child_process");
const { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } = require("node:fs");
const { join, relative, resolve } = require("node:path");
const os = require("node:os");
const { performance } = require("node:perf_hooks");

const root = resolve(__dirname, "../../../../..");
const args = process.argv.slice(2);
const output = resolve(
  args.includes("--output")
    ? args[args.lastIndexOf("--output") + 1]
    : ".scratch/browser-navigation-recovery",
);
mkdirSync(output, { recursive: true });
const resultPath = join(output, "RESULT.json");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const errorRecord = (error) => ({
  message: error.message,
  code: error.code,
  stack: error.stack,
  cause: error.cause && errorRecord(error.cause),
});

if (!process.versions.electron) {
  writeFileSync(
    resultPath,
    JSON.stringify(
      { runStatus: "blocked", error: { message: "Electron has not started" }, cases: [] },
      null,
      2,
    ),
  );
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(
    process.env.ELECTRON_EXECUTABLE || require("electron"),
    [__filename, ...args],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  const stdout = [],
    stderr = [];
  child.stdout.on("data", (data) => {
    stdout.push(data);
    process.stdout.write(data);
  });
  child.stderr.on("data", (data) => {
    stderr.push(data);
    process.stderr.write(data);
  });
  const deadline = setTimeout(() => child.kill("SIGKILL"), 120000);
  const finish = (code, signal, error) => {
    clearTimeout(deadline);
    writeFileSync(join(output, "stdout.log"), Buffer.concat(stdout));
    writeFileSync(join(output, "stderr.log"), Buffer.concat(stderr));
    const result = JSON.parse(readFileSync(resultPath, "utf8"));
    result.launcher = { code, signal, error: error?.message };
    if (code !== 0 || result.runStatus !== "completed") {
      result.runStatus = "failed";
      result.error ??= { message: error?.message || `Electron exited with ${code ?? signal}` };
    }
    writeFileSync(resultPath, JSON.stringify(result, null, 2));
    process.exitCode = result.runStatus === "completed" ? 0 : 1;
  };
  child.once("error", (error) => finish(1, null, error));
  child.once("exit", (code, signal) => finish(code, signal));
} else {
  const { app, BrowserWindow, WebContentsView, nativeImage } = require("electron");
  const { createServer } = require("node:http");
  const started = performance.now();
  const now = () => performance.now() - started;
  const result = {
    schemaVersion: 1,
    runStatus: "running",
    startedAt: new Date().toISOString(),
    provenance: {},
    cases: [],
    requests: [],
  };
  const save = () => writeFileSync(resultPath, JSON.stringify(result, null, 2));
  const sockets = new Set();
  let window, preview, server, watchdog;
  save();
  const until = async (predicate, message, budget = 5000) => {
    const deadline = now() + budget;
    while (!predicate()) {
      if (now() >= deadline) throw new Error(message);
      await new Promise((done) => setTimeout(done, 10));
    }
  };
  const sourceHashes = (directory) =>
    Object.fromEntries(
      readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = join(directory, entry.name);
        return entry.isDirectory()
          ? Object.entries(sourceHashes(path))
          : [[relative(root, path), sha(readFileSync(path))]];
      }),
    );
  async function trial(id, origin) {
    const sample = { id, status: "running", attempts: [], checks: [], observations: {} };
    result.cases.push(sample);
    save();
    const key = JSON.stringify(["navigation-recovery", "project", "thread", id]);
    let page;
    const check = (assertion, passed) => {
      sample.checks.push({ assertion, passed: Boolean(passed) });
      if (!passed) throw new Error(assertion);
    };
    try {
      page = preview.lifecycle.create(key, "project", "thread", { id, origin: "agent" });
      const contents = page.view.webContents;
      page.view.setBounds({ x: 0, y: 0, width: 640, height: 480 });
      await contents.loadURL("about:blank");
      await preview.control.claim("project", "thread", id);
      const focusBefore = BrowserWindow.getFocusedWindow()?.id ?? null;
      const call = async (command) => {
        const attempt = { command, startedAtMs: now(), requestId: randomUUID() };
        sample.attempts.push(attempt);
        save();
        const request = {
          coreInstanceId: "navigation-recovery",
          coreGeneration: 1,
          projectId: "project",
          threadId: "thread",
          turnId: id,
          callId: randomUUID(),
          requestId: attempt.requestId,
          operation: "command",
          pageId: id,
          browserHostId: preview.browserHostId,
          hostGeneration: preview.hostGeneration,
          pageGeneration: page.pageGeneration,
          controlEpoch: page.controlEpoch,
          workspacePath: result.provenance.workspace,
          parameters: { pageId: id, command },
        };
        try {
          const prepared = await preview.prepare({ ...request, phase: "prepare" });
          const response = await preview.execute({
            ...request,
            phase: "execute",
            browserApproval: { plan: prepared.plan },
          });
          const value = response.commandResult;
          attempt.result = {
            ...value,
            ...(value.image && {
              image: {
                mimeType: value.image.mimeType,
                bytes: Buffer.byteLength(value.image.base64, "base64"),
              },
            }),
          };
          return value;
        } catch (error) {
          attempt.error = errorRecord(error);
          throw error;
        } finally {
          attempt.finishedAtMs = now();
          save();
        }
      };
      const readDom = async () =>
        (
          await contents.debugger.sendCommand("Runtime.evaluate", {
            expression: `({url:location.href,title:document.title,marker:document.querySelector('#trial')?.textContent,readyState:document.readyState,draft:document.querySelector('#draft')?.value,clicks:window.clicks||0,imageComplete:document.querySelector('img')?.complete,viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio}})`,
            returnByValue: true,
          })
        ).result.value;
      const pendingDocument = id.startsWith("uncommitted");
      const kind = pendingDocument ? "never" : id === "redirect" ? "redirect" : "document";
      const target = `${origin}/${kind}/${id}`;
      const navigation = call({ method: "navigate", url: target }).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      if (id === "uncommitted-takeover") {
        await until(
          () => result.requests.some((item) => item.id === id && item.kind === "never"),
          "server did not observe dispatched navigation",
        );
        sample.observations.beforeRevoke = {
          url: contents.getURL(),
          loading: contents.isLoading(),
          dispatched: page.activeAction?.dispatched,
          heldKeys: page.heldKeys.size,
          heldButtons: page.heldButtons.size,
        };
        check(
          "navigation was dispatched before takeover",
          sample.observations.beforeRevoke.dispatched,
        );
        preview.control.revoke(page);
      }
      const outcome = await navigation;
      sample.observations.navigationReturnedAtMs = now();
      sample.observations.loadingAtReturn = contents.isLoading();
      if (pendingDocument) {
        check(
          "uncommitted navigation rejects with outcome_unknown",
          outcome.error?.message === "outcome_unknown",
        );
        check("uncommitted navigation never reports success", !outcome.value?.ok);
        check("uncommitted target never replaced about:blank", contents.getURL() === "about:blank");
        if (id === "uncommitted-timeout") {
          sample.observations.timeoutMs =
            sample.attempts[0].finishedAtMs - sample.attempts[0].startedAtMs;
          check(
            "default navigation timeout elapsed",
            sample.observations.timeoutMs >= 9500 && sample.observations.timeoutMs < 20000,
          );
          preview.control.revoke(page);
        }
        sample.observations.beforeStop = {
          control: page.control,
          transferError: page.transferError,
          pendingInput: page.inputPending.size,
          activeAction: Boolean(page.activeAction),
        };
        check("revocation fences subsequent Agent work", page.control !== "agent");
        await preview.command({
          operation: "stop",
          projectId: "project",
          threadId: "thread",
          pageId: id,
        });
        await until(() => page.control === "human", "stop loading did not converge takeover");
        sample.observations.afterRevoke = {
          control: page.control,
          heldKeys: page.heldKeys.size,
          heldButtons: page.heldButtons.size,
          pendingInput: page.inputPending.size,
          activeAction: Boolean(page.activeAction),
        };
        check(
          "takeover releases inputs and action",
          !page.heldKeys.size &&
            !page.heldButtons.size &&
            !page.inputPending.size &&
            !page.activeAction,
        );
      } else {
        if (outcome.error) throw outcome.error;
        check("committed navigation reports confirmed success", outcome.value?.ok === true);
        check("navigation returns while image keeps page loading", contents.isLoading());
        sample.observations.domAtReturn = await readDom();
        check(
          "committed target DOM is readable",
          sample.observations.domAtReturn.marker === id &&
            sample.observations.domAtReturn.title === id &&
            sample.observations.domAtReturn.url === `${origin}/document/${id}` &&
            sample.observations.domAtReturn.readyState === "interactive" &&
            sample.observations.domAtReturn.imageComplete === false,
        );
        const fill = await call({
          method: "playwright",
          action: {
            name: "locator",
            selector: "#draft",
            operation: "fill",
            value: "Recovery truth",
          },
        });
        check("locator fill succeeds after navigation", fill.ok);
        const click = await call({
          method: "playwright",
          action: { name: "locator", selector: "#action", operation: "click" },
        });
        check("locator click succeeds after navigation", click.ok);
        sample.observations.domAfterActions = await readDom();
        check(
          "independent DOM confirms fill and one click",
          sample.observations.domAfterActions.draft === "Recovery truth" &&
            sample.observations.domAfterActions.clicks === 1,
        );
        const capture = await call({ method: "screenshot" });
        check("production screenshot succeeds", capture.ok && Boolean(capture.image?.base64));
        const image = nativeImage.createFromBuffer(Buffer.from(capture.image.base64, "base64"));
        writeFileSync(join(output, `${id}.png`), image.toPNG());
        const size = image.getSize(),
          bitmap = image.toBitmap();
        const viewport = sample.observations.domAfterActions.viewport;
        const expectedSize = {
          width: Math.round(viewport.width * viewport.dpr),
          height: Math.round(viewport.height * viewport.dpr),
        };
        const pixelOffset =
          (size.width * Math.round(400 * viewport.dpr) + Math.round(500 * viewport.dpr)) * 4;
        const pixel = [...bitmap.subarray(pixelOffset, pixelOffset + 4)];
        sample.observations.screenshot = {
          path: join(output, `${id}.png`),
          size,
          viewport,
          expectedSize,
          backgroundBGRA: pixel,
        };
        check(
          "screenshot contains fixture background",
          viewport.width === 640 &&
            viewport.height === 480 &&
            size.width === expectedSize.width &&
            size.height === expectedSize.height &&
            [80, 180, 30].every((expected, index) => Math.abs(pixel[index] - expected) <= 2) &&
            pixel[3] === 255,
        );
        check("permanent image remains unfinished after actions", contents.isLoading());
      }
      check(
        "owner stays hidden and focus does not change",
        !window.isVisible() && (BrowserWindow.getFocusedWindow()?.id ?? null) === focusBefore,
      );
      const requests = result.requests.filter((item) => item.id === id);
      sample.observations.requestsAtCompletion = requests.map((item) => ({ ...item }));
      check(
        "exactly one navigation attempt",
        sample.attempts.filter((item) => item.command.method === "navigate").length === 1,
      );
      check(
        "exactly one target document GET without replay",
        requests.filter((item) => item.kind === (pendingDocument ? "never" : "document")).length ===
          1 && requests.every((item) => item.method === "GET"),
      );
      if (!pendingDocument) {
        check(
          "exactly one unfinished image GET",
          requests.filter((item) => item.kind === "image").length === 1 &&
            requests.find((item) => item.kind === "image").finishedAtMs === null,
        );
        check(
          "redirect count matches scenario",
          requests.filter((item) => item.kind === "redirect").length === Number(id === "redirect"),
        );
      }
      sample.status = "passed";
    } catch (error) {
      sample.status = "failed";
      sample.error = errorRecord(error);
      if (page)
        sample.observations.failureControl = {
          control: page.control,
          transferError: page.transferError,
          pendingInput: page.inputPending.size,
          heldKeys: page.heldKeys.size,
          heldButtons: page.heldButtons.size,
          activeAction: Boolean(page.activeAction),
        };
    } finally {
      if (page) preview.lifecycle.release(key);
      sample.finishedAtMs = now();
      save();
      console.log(`${sample.status} ${id}`);
    }
  }
  async function main() {
    const scratch = mkdtempSync(join(os.tmpdir(), "areal-navigation-recovery-"));
    const workspace = join(scratch, "workspace");
    mkdirSync(workspace);
    app.setPath("userData", join(scratch, "user"));
    const hashes = {
      ...sourceHashes(join(root, "clients/gui/app/src/core/preview-native")),
      ...sourceHashes(join(root, "clients/gui/app/src/core/preview")),
      ...sourceHashes(join(root, "clients/gui/packages/browser-automation/dist")),
    };
    for (const path of [
      __filename,
      join(root, "clients/gui/app/src/core/preview.cjs"),
      join(root, "clients/gui/app/src/core/browser-navigation.cjs"),
    ])
      hashes[relative(root, path)] = sha(readFileSync(path));
    result.provenance = {
      workspace,
      scratch,
      sourceHead: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root }).toString().trim(),
      diffSHA256: sha(execFileSync("git", ["diff", "HEAD", "--binary"], { cwd: root })),
      sourceHashes: hashes,
      scriptSHA256: sha(readFileSync(__filename)),
      electron: process.versions.electron,
      chromium: process.versions.chrome,
      node: process.versions.node,
      os: `${os.platform()} ${os.release()}`,
      arch: process.arch,
      argv: args,
    };
    save();
    await app.whenReady();
    watchdog = setTimeout(() => {
      result.runStatus = "failed";
      result.error = { message: "recovery fixture deadline" };
      save();
      app.exit(1);
    }, 110000);
    server = createServer((request, response) => {
      const match = /^\/(document|redirect|image|never)\/([a-z-]+)$/.exec(
        new URL(request.url, "http://fixture").pathname,
      );
      if (!match) {
        response.writeHead(204);
        response.end();
        return;
      }
      const [, kind, id] = match;
      const fact = {
        id,
        kind,
        method: request.method,
        requestedAtMs: now(),
        finishedAtMs: null,
        aborted: false,
      };
      result.requests.push(fact);
      response.on("finish", () => {
        fact.finishedAtMs = now();
      });
      response.on("close", () => {
        if (fact.finishedAtMs === null) fact.aborted = true;
      });
      response.setHeader("cache-control", "no-store");
      if (kind === "never" || kind === "image") return;
      if (kind === "redirect") {
        response.writeHead(302, { location: `/document/${id}` });
        response.end();
        return;
      }
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(
        `<!doctype html><title>${id}</title><style>body{margin:16px;background:rgb(30,180,80)}input,button{padding:8px;margin:8px}</style><p id="trial">${id}</p><label>Draft<input id="draft"></label><button id="action" onclick="window.clicks=(window.clicks||0)+1;this.textContent='Clicked '+window.clicks">Run action</button><img src="/image/${id}"><link rel="icon" href="data:,">`,
      );
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    window = new BrowserWindow({
      show: false,
      width: 900,
      height: 700,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    await window.loadURL("data:text/html,<title>Navigation recovery owner</title>");
    const { CorePreview } = require("../../../app/src/core/preview.cjs");
    preview = new CorePreview(
      window,
      WebContentsView,
      () => true,
      () => ({}),
      () => "navigation-recovery",
    );
    const origin = `http://browser-fixture.localhost:${server.address().port}`;
    for (const id of ["committed", "redirect", "uncommitted-takeover", "uncommitted-timeout"])
      await trial(id, origin);
    result.runStatus = result.cases.every((sample) => sample.status === "passed")
      ? "completed"
      : "failed";
  }
  main()
    .catch((error) => {
      result.runStatus = "failed";
      result.error = errorRecord(error);
    })
    .finally(async () => {
      try {
        await preview?.dispose();
      } catch (error) {
        result.cleanupError = errorRecord(error);
        result.runStatus = "failed";
      }
      if (window && !window.isDestroyed()) window.destroy();
      for (const socket of sockets) socket.destroy();
      if (server?.listening) await new Promise((done) => server.close(done));
      clearTimeout(watchdog);
      result.provenance.changedInputs = Object.entries(result.provenance.sourceHashes ?? {})
        .filter(([path, hash]) => sha(readFileSync(join(root, path))) !== hash)
        .map(([path]) => path);
      if (result.provenance.changedInputs.length) result.runStatus = "failed";
      result.finishedAt = new Date().toISOString();
      save();
      console.log(`${result.runStatus} ${resultPath}`);
      app.exit(result.runStatus === "completed" ? 0 : 1);
    });
}
