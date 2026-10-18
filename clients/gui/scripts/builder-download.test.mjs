import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import test from "node:test";
delete process.env.ELECTRON_GET_USE_PROXY;
const nonce = randomUUID();
const require = createRequire(new URL("../app/package.json", import.meta.url));
const electronBuilder = createRequire(require.resolve("electron-builder/package.json"));
const builder = createRequire(electronBuilder.resolve("app-builder-lib/package.json"));
const { downloadElectronArtifactZip } = builder("./out/util/electronGet.js");
async function download(url, output, checksum, deadline = 1000) {
  const filename = basename(new URL(url).pathname);
  const file = await downloadElectronArtifactZip({
    version: "9.9.9",
    platformName: process.platform,
    arch: process.arch,
    artifactName: filename,
    cacheDir: join(tmpdir(), "areal-builder-fixture-" + nonce),
    electronDownload: {
      mirrorOptions: { customFilename: filename, resolveAssetURL: async () => url },
      checksums: {
        [filename + "-v9.9.9-" + process.platform + "-" + process.arch + ".zip"]: checksum,
      },
      downloadOptions: { timeout: { request: deadline }, retry: { limit: 0 } },
    },
  });
  await copyFile(file, output);
}
test("actual electron-builder download API retains checked bytes with upgraded official downloader and rejects tampering", async () => {
  const root = await mkdtemp(join(tmpdir(), "areal-builder-download-"));
  const body = Buffer.from("task-owned artifact fixture");
  const checksum = createHash("sha256").update(body).digest("hex");
  const server = createServer((request, response) => {
    response.end(body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const output = join(root, "verified.bin");
    await download(`${base}/task-owned-checked-${nonce}.bin`, output, checksum);
    assert.deepEqual(await readFile(output), body);
    await assert.rejects(
      download(
        `${base}/task-owned-tampered-${nonce}.bin`,
        join(root, "rejected.bin"),
        "0".repeat(64),
      ),
      /checksum|digest|hash/i,
    );
  } finally {
    server.close();
    await once(server, "close");
    await rm(root, { recursive: true, force: true });
  }
});
test("upgraded builder downloader still honors standard HTTP proxy configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "areal-builder-proxy-"));
  const body = Buffer.from("proxy-owned artifact fixture");
  const checksum = createHash("sha256").update(body).digest("hex");
  const requests = [];
  const proxy = createServer((request, response) => {
    requests.push(`${request.headers.host}${request.url}`);
    response.end(body);
  });
  const tunnels = new Set();
  proxy.on("connect", (request, socket, head) => {
    requests.push(request.url);
    tunnels.add(socket);
    socket.on("close", () => tunnels.delete(socket));
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) socket.unshift(head);
    proxy.emit("connection", socket);
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  const previousProxy = process.env.HTTP_PROXY,
    previousNoProxy = process.env.NO_PROXY;
  process.env.HTTP_PROXY = `http://127.0.0.1:${proxy.address().port}`;
  process.env.NO_PROXY = "";
  try {
    await download(
      "http://areal-proxy-fixture.invalid/task-owned-proxy-" + nonce + ".bin",
      join(root, "verified.bin"),
      checksum,
    );
    assert.deepEqual(await readFile(join(root, "verified.bin")), body);
    assert.ok(requests.some((url) => url.includes("areal-proxy-fixture.invalid")));
  } finally {
    if (previousProxy === undefined) delete process.env.HTTP_PROXY;
    else process.env.HTTP_PROXY = previousProxy;
    if (previousNoProxy === undefined) delete process.env.NO_PROXY;
    else process.env.NO_PROXY = previousNoProxy;
    for (const socket of tunnels) socket.destroy();
    proxy.closeAllConnections();
    proxy.close();
    await once(proxy, "close");
    await rm(root, { recursive: true, force: true });
  }
});
test("official downloader preserves HTTPS CONNECT, custom CA, NO_PROXY and proxy failure without silent direct fallback", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { writeFile } = await import("node:fs/promises");
  const { createServer: createHttpsServer } = await import("node:https");
  const { connect } = await import("node:net");
  const execute = promisify(execFile);
  const root = await mkdtemp(join(tmpdir(), "areal-builder-tls-"));
  const key = join(root, "owned-key.pem"),
    certificate = join(root, "owned-ca.pem");
  await execute("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    key,
    "-out",
    certificate,
    "-days",
    "1",
    "-subj",
    "/CN=areal-secure-fixture.invalid",
    "-addext",
    "subjectAltName=DNS:localhost,DNS:areal-secure-fixture.invalid",
  ]);
  const body = Buffer.from("tls task-owned bytes");
  let tlsRequests = 0,
    connects = 0;
  const tls = createHttpsServer(
    { key: await readFile(key), cert: await readFile(certificate) },
    (_request, response) => {
      tlsRequests++;
      response.end(body);
    },
  );
  tls.listen(0, "127.0.0.1");
  await once(tls, "listening");
  const proxy = createServer();
  const sockets = new Set();
  proxy.on("connect", (request, socket, head) => {
    connects++;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    const upstream = connect(tls.address().port, "127.0.0.1", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    sockets.add(upstream);
    upstream.on("close", () => sockets.delete(upstream));
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  const child = join(root, "check.cjs");
  await writeFile(
    child,
    [
      "const assert=require('node:assert/strict');const {createRequire}=require('node:module');",
      "const builder=createRequire(process.argv[2]);const {downloadElectronArtifactZip}=builder('./out/util/electronGet.js');const {copyFile}=require('node:fs/promises');const {basename,join}=require('node:path');async function download(url,output,checksum){const filename=basename(new URL(url).pathname);const file=await downloadElectronArtifactZip({version:'9.9.9',platformName:process.platform,arch:process.arch,artifactName:filename,cacheDir:join(process.argv[3],'cache'),electronDownload:{mirrorOptions:{customFilename:filename,resolveAssetURL:async()=>url},checksums:{[filename+'-v9.9.9-'+process.platform+'-'+process.arch+'.zip']:checksum},downloadOptions:{timeout:{request:1000},retry:{limit:0}}}});await copyFile(file,output);}",
      "const root=process.argv[3],port=process.argv[4],proxy=process.argv[5],checksum=process.argv[6];",
      "async function run(){process.env.HTTPS_PROXY='http://127.0.0.1:1';process.env.NO_PROXY='localhost';await download('https://localhost:'+port+'/direct.bin',root+'/direct.bin',checksum);",
      "process.env.HTTPS_PROXY=proxy;process.env.NO_PROXY='';await download('https://areal-secure-fixture.invalid:'+port+'/connect.bin',root+'/connect.bin',checksum);",
      "process.env.HTTPS_PROXY='http://127.0.0.1:1';await assert.rejects(download('https://localhost:'+port+'/no-fallback.bin',root+'/no-fallback.bin',checksum));}",
      "run().catch(error=>{console.error(error);process.exitCode=1});",
    ].join("\n"),
  );
  try {
    await execute(
      process.execPath,
      [
        child,
        electronBuilder.resolve("app-builder-lib/package.json"),
        root,
        String(tls.address().port),
        "http://127.0.0.1:" + proxy.address().port,
        createHash("sha256").update(body).digest("hex"),
      ],
      {
        timeout: 15000,
        env: {
          ...process.env,
          NODE_EXTRA_CA_CERTS: certificate,
          NODE_TLS_REJECT_UNAUTHORIZED: "1",
          ELECTRON_BUILDER_CACHE: join(root, "cache"),
        },
      },
    );
    assert.equal(tlsRequests, 2, "failed proxy must not silently fall back to direct TLS");
    assert.equal(connects, 1, "HTTPS artifact must traverse CONNECT");
  } finally {
    for (const socket of sockets) socket.destroy();
    proxy.closeAllConnections();
    proxy.close();
    await once(proxy, "close");
    tls.closeAllConnections();
    tls.close();
    await once(tls, "close");
    await rm(root, { recursive: true, force: true });
  }
});
test("real builder cold download enforces the configured production request deadline while body is stalled", async () => {
  const root = await mkdtemp(join(tmpdir(), "areal-builder-deadline-"));
  const closed = [];
  const server = createServer((request, response) => {
    const started = Date.now();
    response.writeHead(200, { "content-length": "100" });
    response.write("partial");
    const watchdog = setTimeout(() => response.destroy(), 2000);
    response.on("close", () => {
      clearTimeout(watchdog);
      closed.push(Date.now() - started);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await assert.rejects(
      download(
        "http://127.0.0.1:" + server.address().port + "/deadline-" + nonce + ".bin",
        join(root, "not-complete.bin"),
        "0".repeat(64),
        100,
      ),
      (error) => error.code === "ETIMEDOUT" && /Timeout/i.test(error.message),
    );
    assert.ok(closed.length > 0);
    assert.ok(
      closed.every((duration) => duration < 1000),
      "Got request deadline must abort before fixture watchdog",
    );
  } finally {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
    await rm(root, { recursive: true, force: true });
  }
});
test("real builder toolset cold path verifies and extracts a task-owned archive", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { writeFile, mkdir } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "areal-builder-toolset-"));
  const archive = join(root, "toolset.tar.gz");
  await promisify(execFile)("/usr/bin/python3", [
    "-I",
    "-S",
    "-c",
    "import io,sys,tarfile; data=b'owned toolset'; t=tarfile.open(sys.argv[1],'w:gz'); f=tarfile.TarInfo('fixture/owned.txt'); f.size=len(data); t.addfile(f,io.BytesIO(data)); t.close()",
    archive,
  ]);
  const body = await readFile(archive),
    checksum = createHash("sha256").update(body).digest("hex");
  const server = createServer((_request, response) => response.end(body));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const { downloadBuilderToolset } = builder("./out/util/electronGet.js");
    const path = await downloadBuilderToolset({
      releaseName: "task-owned-" + nonce,
      filenameWithExt: "toolset-" + nonce + ".tar.gz",
      checksums: { ["toolset-" + nonce + ".tar.gz"]: checksum },
      overrideUrl: "http://127.0.0.1:" + server.address().port,
    });
    assert.equal(await readFile(join(path, "owned.txt"), "utf8"), "owned toolset");
  } finally {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
    await rm(root, { recursive: true, force: true });
  }
});
