"use strict";
const { randomUUID, randomBytes } = require("node:crypto");
const { authorizeFile, fileRequest } = require("./mcp-apps-files.cjs");
const { validateMcpPageDeclaration, validateMcpPageCall, validateMcpPageReply } = require("@areal/workbench/desktop-contract");
const { openGenUi, genUiRequest, genUiVisibility, genUiResource } = require("./gen-ui.cjs");
const METHODS = new Set([
    "tools/call",
    "tools/list",
    "resources/read",
    "resources/list",
    "resources/templates/list",
    "resources/subscribe",
    "resources/unsubscribe",
    "ui/update-model-context",
    "ui/host-authorize",
    "openai/resources/write",
    "openai/files/open",
]);
function object(value) {
    return value && typeof value === "object" && !Array.isArray(value);
}
function text(value) {
    return typeof value === "string" && value.length > 0 && value.length <= 4096;
}
function domains(value) {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 64) throw Error("Invalid app CSP");
    return value.map((domain) => {
        if (
            typeof domain !== "string" ||
            !/^https?:\/\/(?:\*\.)?[a-z0-9.-]+(?::\d{1,5})?$|^wss:\/\/[a-z0-9.-]+(?::\d{1,5})?$/i.test(
                domain,
            )
        )
            throw Error("Invalid app CSP domain");
        return domain;
    });
}
function appCsp(csp = {}) {
    if (!object(csp)) throw Error("Invalid app CSP");
    const network = domains(csp.connectDomains),
        assets = domains(csp.resourceDomains),
        frames = domains(csp.frameDomains),
        base = domains(csp.baseUriDomains);
    return `default-src 'none'; script-src 'unsafe-inline' ${assets.join(" ")}; style-src 'unsafe-inline' ${assets.join(" ")}; img-src data: blob: ${assets.join(" ")}; font-src data: ${assets.join(" ")}; media-src blob: data: ${assets.join(" ")}; connect-src ${network.join(" ") || "'none'"}; frame-src ${frames.join(" ") || "'none'"}; base-uri ${base.join(" ") || "'none'"}; object-src 'none'; form-action 'none'; worker-src 'none'`;
}
function parseDeepLink(raw) {
    const url = new URL(raw);
    if (
        !["codex:", "areal:"].includes(url.protocol) ||
        url.host !== "plugins" ||
        url.hash ||
        url.username ||
        url.password
    )
        throw Error("Invalid app deep link");
    const parts = url.pathname.split("/");
    if (parts.length !== 4 || parts[2] !== "app" || !parts[1] || !parts[3])
        throw Error("Invalid app deep link");
    const path = url.searchParams.get("path") ?? "/";
    if (
        !path.startsWith("/") ||
        path.startsWith("//") ||
        path.includes("#") ||
        path.includes("\\") ||
        /[\x00-\x1f]/.test(path)
    )
        throw Error("Invalid app-relative URL");
    const split = parts[1].lastIndexOf("@");
    const pluginId = decodeURIComponent(split < 0 ? parts[1] : parts[1].slice(0, split));
    const marketplace = split < 0 ? undefined : decodeURIComponent(parts[1].slice(split + 1));
    if (!pluginId || marketplace === "") throw Error("Invalid app deep link");
    return {
        pluginId,
        ...(marketplace ? { marketplace } : {}),
        toolName: decodeURIComponent(parts[3]),
        path,
    };
}
function proxyHtml(observeErrors = false) {
    return `<!doctype html><html><head><meta charset="utf-8"><style>html,body,iframe{margin:0;border:0;width:100%;height:100%;display:block}</style></head><body><iframe id="view" sandbox="allow-scripts allow-same-origin" referrerpolicy="no-referrer"></iframe><script>
const view=document.getElementById('view'); let loaded=false;
${observeErrors ? `view.addEventListener('load',()=>{try{const failed=()=>parent.postMessage({jsonrpc:'2.0',method:'areal/notifications/page-error'},'areal-ui://app');view.contentWindow.addEventListener('error',failed);view.contentWindow.addEventListener('unhandledrejection',failed);}catch{}});` : ''}
addEventListener('message',event=>{
 const message=event.data;
 if(!message||message.jsonrpc!=='2.0')return;
 if(event.source===parent){
  if(message.method==='ui/notifications/sandbox-resource-ready'){
   if(loaded)return; loaded=true;view.src='view';return;
  }
  if(!String(message.method||'').startsWith('ui/notifications/sandbox-'))view.contentWindow.postMessage(message,'*');
 }else if(event.source===view.contentWindow&&!String(message.method||'').startsWith('ui/notifications/sandbox-'))parent.postMessage(message,'areal-ui://app');
});
parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/sandbox-proxy-ready'},'areal-ui://app');
</script></body></html>`;
}
class McpAppsHost {
    constructor({ backend, ownerId, notify = () => {}, openFile }) {
        this.backend = backend;
        this.ownerId = ownerId;
        this.notify = notify;
        this.openFile = openFile;
        this.instances = new Map();
        this.epoch = 0;
        this.pendingOpens = 0;
        this.resultOpens = new Map();
        this.instanceTokens = new Map();
        this.pageToolCalls = new Map();
    }
    openGenUi(params, ownerId) { return openGenUi(this, params, ownerId); }
    genUiVisibility(params, ownerId) { return genUiVisibility(this, params, ownerId); }
    currentOwner() {
        try { return typeof this.ownerId === "function" ? this.ownerId() : this.ownerId; }
        catch { return undefined; }
    }
    get(token, ownerId) {
        const app = this.instances.get(token);
        if (
            ownerId !== this.currentOwner() ||
            !app ||
            ownerId !== app.ownerId ||
            app.closed ||
            !this.backend.ownsThread(app.projectId, app.threadId)
        )
            throw Error("App is closed or stale");
        return app;
    }
    async open(params, ownerId) {
        if (
            ownerId !== this.currentOwner() ||
            !object(params) ||
            !["projectId", "threadId", "serverId", "toolName"].every((k) => text(params[k])) ||
            !["string", "number"].includes(typeof params.expectedGeneration) ||
            !this.backend.ownsThread(params.projectId, params.threadId)
        )
            throw Error("Invalid app owner");
        if (this.instances.size + this.pendingOpens >= 8) throw Error("App page limit reached (8)");
        this.pendingOpens++;
        try {
            const epoch = this.epoch;
            const file =
                params.filePath === undefined
                    ? null
                    : await authorizeFile(this.backend, params.projectId, params.filePath);
            const initialArguments = file
                ? { file: { name: file.name, resourceUri: file.uri } }
                : (params.arguments ?? {});
            if (!object(initialArguments)) throw Error("Invalid app arguments");
            const result = await this.backend.command("manage", {
                operation: "mcpAppOpen",
                projectId: params.projectId,
                threadId: params.threadId,
                serverId: params.serverId,
                expectedGeneration: params.expectedGeneration,
                toolName: params.toolName,
                arguments: initialArguments,
                requestId: randomUUID(),
                ...(file ? { fileResource: { uri: file.uri, path: file.path } } : {}),
            });
            return await this.adopt(result, params, ownerId, epoch, initialArguments, file, false);
        } finally { this.pendingOpens--; }
    }
    async adopt(result, params, ownerId, epoch, initialArguments, file, fromResult) {
        const resultSourceKey = fromResult ? JSON.stringify([ownerId, epoch, params.projectId, params.threadId, params.turnId, params.itemId]) : undefined;
        const closeInvalid = async () => {
            if (fromResult && text(result?.instanceId)) {
                const instanceKey = JSON.stringify([ownerId, epoch, params.projectId, result.instanceId]);
                const retained = this.instances.get(this.instanceTokens.get(instanceKey));
                const token = retained?.token ?? randomBytes(24).toString("hex");
                if (!retained) {
                    this.instances.set(token, { token, instanceKey, ownerId, projectId: params.projectId, threadId: params.threadId,
                        instanceId: result.instanceId, generation: result.generation, closed: true, invalidResource: true,
                        resultSourceKey });
                    this.instanceTokens.set(instanceKey, token);
                }
                await this.close(token, ownerId).catch(() => {});
                return;
            }
            if (result?.instanceId)
                await this.backend
                .command("manage", {
                    operation: "mcpAppClose",
                    projectId: params.projectId,
                    threadId: params.threadId,
                    instanceId: result.instanceId,
                    generation: result.generation,
                })
                .catch(() => {});
        };
        if (
            epoch !== this.epoch ||
            ownerId !== this.currentOwner() ||
            !this.backend.ownsThread(params.projectId, params.threadId) ||
            !text(result?.instanceId) ||
            (!fromResult && (result.serverId !== params.serverId || result.generation !== params.expectedGeneration)) ||
            !text(result.serverId) ||
            typeof result.resource?.html !== "string" ||
            (fromResult ? Buffer.byteLength(result.resource.html, "utf8") > 2 * 1024 * 1024 : result.resource.html.length > 8 * 1024 * 1024) ||
            !(fromResult ? ["text/html;profile=mcp-app", "text/html"] : ["text/html;profile=mcp-app"]).includes(result.resource.mimeType)
        ) {
            await closeInvalid();
            throw Error("App resource is invalid or stale");
        }
        let csp;
        try {
            csp = appCsp(result.resource._meta?.ui?.csp ?? {});
        } catch (error) {
            await closeInvalid();
            throw error;
        }
        const instanceKey = JSON.stringify([ownerId, epoch, params.projectId, result.instanceId]);
        const retained = this.instances.get(this.instanceTokens.get(instanceKey));
        const closedInstances = this.resultOpens.get(resultSourceKey)?.closedInstances;
        if (fromResult && (closedInstances === null || closedInstances?.has(JSON.stringify([result.instanceId, result.generation]))
            || (this.instanceTokens.has(instanceKey) && (!retained || retained.closed)))) {
            await closeInvalid();
            throw Error("App instance was closed");
        }
        if (retained && !retained.closed) return retained.descriptor;
        const token = randomBytes(24).toString("hex");
        const app = {
            ...result,
            instanceKey,
            resultSourceKey,
            ownerId,
            projectId: params.projectId,
            threadId: params.threadId,
            token,
            csp,
            file,
            closed: false,
            hostEpoch: epoch,
            pageTools: { state: "uninitialized" },
            requests: new Map(),
            abort: new AbortController(),
        };
        this.instances.set(token, app);
        this.instanceTokens.set(instanceKey, token);
        const declared = result.resource._meta?.["openai/ui"]?.availableDisplayModes;
        if (
            declared !== undefined &&
            (!Array.isArray(declared) ||
                declared.some((mode) => !["inline", "fullscreen", "pip"].includes(mode)))
        ) {
            await this.close(token, ownerId);
            throw Error("Invalid app display modes");
        }
        const availableDisplayModes = ["inline", "fullscreen"].filter(
            (mode) => declared === undefined || declared.includes(mode),
        );
        if (!availableDisplayModes.length) {
            await this.close(token, ownerId);
            throw Error("No supported app display mode");
        }
        const hostContext = {
            ...result.hostContext,
            displayMode: availableDisplayModes[0],
            availableDisplayModes,
        };
        if (params.deepLink !== undefined) {
            if (
                !text(params.deepLink) ||
                !params.deepLink.startsWith("/") ||
                params.deepLink.startsWith("//") ||
                /[#\\\x00-\x1f]/.test(params.deepLink)
            ) {
                await this.close(token, ownerId);
                throw Error("Invalid deep link");
            }
            hostContext["openai/deepLink"] = { url: params.deepLink };
        }
        app.descriptor = {
            kind: "mcp",
            token,
            frameUrl: `areal-mcp://${token}/`,
            instanceId: app.instanceId,
            serverId: app.serverId,
            generation: app.generation,
            projectId: app.projectId,
            threadId: app.threadId,
            toolMetadata: app.toolMetadata,
            initialArguments: app.initialArguments ?? initialArguments,
            initialResult: app.initialResult,
            hostContext,
            resourceMeta: result.resource._meta ?? {},
            fileResource: !!file,
        };
        return app.descriptor;
    }
    async openFromResult(params, ownerId) {
        const allowed = ["operation", "projectId", "threadId", "turnId", "itemId", "requestId"];
        if (ownerId !== this.currentOwner() || !object(params)
            || Object.keys(params).some(key => !allowed.includes(key))
            || !["projectId", "threadId", "turnId", "itemId", "requestId"].every(key => text(params[key]) && params[key].length <= 128)
            || !this.backend.ownsThread(params.projectId, params.threadId)) throw Error("Invalid result app owner or input");
        const epoch = this.epoch;
        const sourceKey = JSON.stringify([ownerId, epoch, params.projectId, params.threadId, params.turnId, params.itemId]);
        const owned = [...this.instances.values()].find(app => app.resultSourceKey === sourceKey);
        if (owned?.closed) {
            if (!owned.invalidResource) throw Error("App closing outcome unknown; reconcile the original close first");
            await this.close(owned.token, ownerId);
        }
        const pending = this.resultOpens.get(sourceKey);
        if (pending) return pending.requestId === params.requestId ? pending.promise : pending.promise.then(() => this.openFromResult(params, ownerId));
        if (!owned && this.instances.size + this.pendingOpens >= 8) throw Error("App page limit reached (8)");
        this.pendingOpens++;
        const promise = (async () => {
            const response = await this.backend.command("manage", {
                operation: "mcpAppOpenFromResult", projectId: params.projectId,
                threadId: params.threadId, turnId: params.turnId, itemId: params.itemId, requestId: params.requestId,
            });
            if (response?.status === "closed") return { status: "closed" };
            if (response?.status === "unavailable") return { status: "unavailable", reason: response.reason };
            if (response?.status !== "open") throw Error("Invalid result open reply");
            try {
                const app = await this.adopt(response.instance, params, ownerId, epoch, undefined, null, true);
                return { status: "open", app };
            } catch (error) {
                return { status: "unavailable", reason: epoch !== this.epoch || ownerId !== this.currentOwner() ? "sourceUnavailable" : "resourceRejected" };
            }
        })().finally(() => {
            this.pendingOpens--;
            this.resultOpens.delete(sourceKey);
        });
        this.resultOpens.set(sourceKey, { requestId: params.requestId, promise, ownerId, epoch,
            projectId: params.projectId, threadId: params.threadId, closedInstances: new Set() });
        return promise;
    }
    pageToolBinding(app) {
        return { projectId: app.projectId, threadId: app.threadId, instanceId: app.instanceId, generation: app.generation };
    }
    async pageToolsReady(token, mountId, declaration, ownerId) {
        validateMcpPageDeclaration(declaration);
        const app = this.get(token, ownerId), tools = app.pageTools;
        if (!text(mountId) || mountId.length > 128) throw Error("Invalid page tool mount");
        if (tools.state === "revoked") throw Error("Page tool lease was revoked; reopen the app");
        const fingerprint = JSON.stringify(declaration);
        if (tools.mountId && (tools.mountId !== mountId || tools.declaration !== fingerprint)) throw Error("Page tool mount or declaration changed");
        if (tools.ready) return tools.ready;
        tools.mountId = mountId;
        tools.declaration = fingerprint;
        tools.state = "registering";
        tools.pendingNotices = [];
        tools.ready = (async () => {
            const registration = await this.backend.mcpPageTools({ operation: "register", ...this.pageToolBinding(app), declaration });
            tools.registration = registration;
            if (!this.pageToolsCurrent(app, mountId) || tools.state !== "registering") throw Error("Page tool mount was revoked");
            tools.state = "ready";
            const notices = tools.pendingNotices;
            tools.pendingNotices = undefined;
            for (const notice of notices ?? []) void this.pageToolNotice(notice);
            return registration;
        })().catch(error => { this.revokePageTools(app); throw error; });
        return tools.ready;
    }
    pageToolsCurrent(app, mountId) {
        return this.instances.get(app.token) === app && !app.closed && app.ownerId === this.currentOwner()
            && app.hostEpoch === this.epoch && app.pageTools.mountId === mountId
            && app.pageTools.state !== "revoked" && this.backend.ownsThread(app.projectId, app.threadId);
    }
    pageToolsUnmount(token, mountId, ownerId) {
        const app = this.instances.get(token);
        if (!app || app.ownerId !== ownerId || ownerId !== this.currentOwner()) throw Error("Invalid page tool owner");
        if (app.pageTools.mountId && app.pageTools.mountId !== mountId) throw Error("Invalid page tool mount");
        this.revokePageTools(app);
        return {};
    }
    revokePageTools(app) {
        const tools = app.pageTools;
        if (!tools) return;
        tools.state = "revoked";
        tools.pendingNotices = undefined;
        for (const call of this.pageToolCalls.values()) if (call.app === app) {
            call.cancelled = app.closed ? "closed" : "unavailable";
            if (call.phase === "dispatched") this.cancelPageTool(call);
        }
        if (tools.registration) void this.backend.mcpPageTools({ operation: "revoke", ...this.pageToolBinding(app),
            registrationId: tools.registration.registrationId }).catch(() => {});
    }
    pageToolsDisconnected(event) {
        for (const app of this.instances.values()) {
            if (event && (event.projectId !== app.projectId || event.instanceId !== app.instanceId || event.generation !== app.generation)) continue;
            this.revokePageTools(app);
        }
    }
    async pageToolNotice(event) {
        if (!object(event) || !object(event.params)
            || !["areal/mcp/app/tools/pending", "areal/mcp/app/tools/cancelled"].includes(event.method)) return;
        const params = event.params;
        const coordinateKeys = ["threadId", "turnId", "callId", "registrationId", "ownerId", "schemaDigest"];
        if (!coordinateKeys.every(key => text(params[key]) && params[key].length <= 256)
            || Object.keys(params).some(key => !coordinateKeys.includes(key) && key !== "claimId")
            || params.claimId !== undefined && (!text(params.claimId) || params.claimId.length > 256)) return;
        const app = [...this.instances.values()].find(candidate => candidate.projectId === event.projectId
            && candidate.threadId === params.threadId && candidate.instanceId === event.instanceId
            && candidate.generation === event.generation);
        if (app?.pageTools.state === "registering" && this.pageToolsCurrent(app, app.pageTools.mountId)) {
            const notices = app.pageTools.pendingNotices;
            if (notices.length < 4 && !notices.some(notice => notice.method === event.method
                && coordinateKeys.every(key => notice.params[key] === params[key]) && notice.params.claimId === params.claimId))
                notices.push({ projectId: event.projectId, instanceId: event.instanceId, generation: event.generation,
                    method: event.method, params: { ...params } });
            return;
        }
        const existing = [...this.pageToolCalls.values()].find(call => call.app.projectId === event.projectId
            && call.app.instanceId === event.instanceId && call.app.generation === event.generation
            && ["threadId", "turnId", "callId", "registrationId", "ownerId", "schemaDigest"].every(key => call.coordinates[key] === params[key]));
        if (event.method.endsWith("/cancelled")) {
            if (existing && (params.claimId === undefined || !existing.claimId || params.claimId === existing.claimId)) {
                existing.cancelled = "cancelled";
                if (existing.phase === "dispatched") this.cancelPageTool(existing);
            }
            return;
        }
        if (!app || existing || app.pageTools.state !== "ready" || !this.pageToolsCurrent(app, app.pageTools.mountId)
            || app.pageTools.registration.registrationId !== params.registrationId
            || !app.pageTools.registration.tools.some(tool => tool.schemaDigest === params.schemaDigest)
            || [...this.pageToolCalls.values()].filter(call => call.app === app).length >= 2) return;
        const coordinates = Object.fromEntries(coordinateKeys.map(key => [key, params[key]]));
        const key = JSON.stringify([app.token, params.callId]);
        if (this.pageToolCalls.has(key)) return;
        const call = { key, app, coordinates, mountId: app.pageTools.mountId, phase: "claiming" };
        this.pageToolCalls.set(key, call);
        try {
            const grant = await this.backend.mcpPageTools({ operation: "claim", ...this.pageToolBinding(app), ...coordinates });
            if (grant?.status !== "granted") { this.pageToolCalls.delete(key); return; }
            call.claimId = grant.claimId;
            if (call.cancelled || !this.pageToolsCurrent(app, call.mountId)) {
                await this.settlePageTool(call, { status: "noEffect", reason: call.cancelled ?? "closed" });
                return;
            }
            const request = { callId: coordinates.callId, kind: grant.kind, documentId: grant.documentId, arguments: grant.arguments };
            validateMcpPageCall(request);
            if (!text(grant.claimId) || grant.documentId !== app.pageTools.registration.documentId
                || !app.pageTools.registration.tools.some(tool => tool.kind === grant.kind && tool.schemaDigest === coordinates.schemaDigest)) throw Error("Invalid page tool grant");
            call.phase = "dispatched";
            call.timer = setTimeout(() => { void this.settlePageTool(call, { status: "unknown" }).catch(() => {}); }, 32_000);
            call.timer.unref?.();
            this.notify({ token: app.token, notification: { jsonrpc: "2.0", method: "areal/notifications/page-tool-call",
                params: { mountId: call.mountId, ...request } } });
        } catch {
            if (call.phase === "dispatched") this.cancelPageTool(call);
            else if (call.claimId) await this.settlePageTool(call, { status: "noEffect", reason: "unavailable" }).catch(() => {});
            else this.pageToolCalls.delete(key);
        }
    }
    cancelPageTool(call) {
        this.notify({ token: call.app.token, notification: { jsonrpc: "2.0", method: "areal/notifications/page-tool-cancelled",
            params: { mountId: call.mountId, callId: call.coordinates.callId } } });
        if (call.drain) return;
        call.drain = setTimeout(() => { void this.settlePageTool(call, { status: "unknown" }).catch(() => {}); }, 1000);
        call.drain.unref?.();
    }
    async pageToolResult(token, mountId, callId, reply, ownerId) {
        validateMcpPageReply(reply);
        const call = this.pageToolCalls.get(JSON.stringify([token, callId]));
        if (!call || call.mountId !== mountId || call.app.ownerId !== ownerId || ownerId !== this.currentOwner()
            || call.app.hostEpoch !== this.epoch || !["dispatched", "resolving"].includes(call.phase)) throw Error("Page tool result is stale or has another mount");
        return this.settlePageTool(call, reply);
    }
    async settlePageTool(call, reply) {
        const fingerprint = JSON.stringify(reply);
        if (call.settlement) {
            if (call.reply !== fingerprint) throw Error("Conflicting page tool result");
            return call.settlement;
        }
        call.phase = "resolving";
        call.reply = fingerprint;
        clearTimeout(call.timer);
        clearTimeout(call.drain);
        call.settlement = this.backend.mcpPageTools({ operation: "resolve", ...this.pageToolBinding(call.app), ...call.coordinates,
            ...(call.claimId ? { claimId: call.claimId } : {}), reply }).finally(() => this.pageToolCalls.delete(call.key));
        return call.settlement;
    }
    async request(token, request, ownerId) {
        const app = this.get(token, ownerId);
        if (app.kind === "genUi") return genUiRequest(this, app, request, ownerId);
        if (
            !object(request) ||
            request.jsonrpc !== "2.0" ||
            !METHODS.has(request.method) ||
            !["string", "number"].includes(typeof request.id) ||
            (request.params !== undefined && !object(request.params)) ||
            JSON.stringify(request).length > 12 * 1024 * 1024
        )
            throw Error("Invalid or unsupported app request");
        const key = JSON.stringify(request.id),
            fingerprint = JSON.stringify(request),
            previous = app.requests.get(key);
        if (previous) {
            if (previous.fingerprint !== fingerprint)
                throw Error("App request ID was reused with different content");
            return previous.promise;
        }
        if (app.requests.size >= 512) throw Error("App request budget exhausted; reopen this app");
        let rejectClosed;
        const closed = new Promise((_resolve, reject) => {
            rejectClosed = () => reject(Error("App is closed or stale"));
            app.abort.signal.addEventListener("abort", rejectClosed, { once: true });
        });
        const promise = Promise.race([
            this.performRequest(token, request, ownerId),
            closed,
        ]).finally(() => app.abort.signal.removeEventListener("abort", rejectClosed));
        app.requests.set(key, { fingerprint, promise });
        return promise;
    }
    async performRequest(token, request, ownerId) {
        const app = this.get(token, ownerId);
        if (
            !object(request) ||
            request.jsonrpc !== "2.0" ||
            !METHODS.has(request.method) ||
            !["string", "number"].includes(typeof request.id) ||
            (request.params !== undefined && !object(request.params)) ||
            JSON.stringify(request).length > 12 * 1024 * 1024
        )
            throw Error("Invalid or unsupported app request");
        const current = () => {
            if (this.get(token, ownerId) !== app) throw Error("App is stale");
        };
        const local =
            request.method === "openai/files/open" ||
            request.method === "openai/resources/write" ||
            (typeof request.params?.uri === "string" &&
                request.params.uri.startsWith("areal-file:"));
        if (local) {
            const authorization = await this.backend.command("manage", {
                operation: "mcpAppRequest",
                projectId: app.projectId,
                threadId: app.threadId,
                instanceId: app.instanceId,
                generation: app.generation,
                request: {
                    jsonrpc: "2.0",
                    id: request.id,
                    method: "ui/host-authorize",
                    params: { method: request.method },
                },
                requestId: randomUUID(),
            });
            current();
            if (!authorization || authorization.error || !Object.hasOwn(authorization, "result"))
                throw Error("App authorization is stale or unavailable");
        }
        let result;
        if (request.method === "openai/files/open") {
            if (!this.openFile || !text(request.params?.path))
                throw Error("File opening unavailable");
            await this.openFile(
                { projectId: app.projectId, path: request.params.path, operation: "open" },
                current,
            );
            result = {};
        } else if (
            request.params?.uri?.startsWith("areal-file:") ||
            request.method === "openai/resources/write"
        ) {
            // This ID is created once inside the request receipt cache, so repeated
            // app JSON-RPC IDs observe the original Core effect rather than replaying it.
            const fileRequestId = randomUUID();
            result = await fileRequest(
                app.file, request, current,
                (notification) => this.notify({ token, notification }),
                (originalRequest) => this.backend.command("manage", {
                    operation: "mcpAppRequest",
                    projectId: app.projectId,
                    threadId: app.threadId,
                    instanceId: app.instanceId,
                    generation: app.generation,
                    request: {
                        jsonrpc: "2.0",
                        id: originalRequest.id,
                        method: "ui/host-file",
                        params: { request: originalRequest },
                    },
                    requestId: fileRequestId,
                }),
            );
        } else {
            const value = await this.backend.command("manage", {
                operation: "mcpAppRequest",
                projectId: app.projectId,
                threadId: app.threadId,
                instanceId: app.instanceId,
                generation: app.generation,
                request,
                requestId: randomUUID(),
            });
            current();
            return value;
        }
        current();
        return { jsonrpc: "2.0", id: request.id, result };
    }
    async close(token, ownerId) {
        const app = this.instances.get(token);
        if (!app) return {};
        if (ownerId !== app.ownerId) throw Error("Invalid app owner");
        if (app.kind === "genUi") {
            app.closed = true; app.abort.abort(); app.stateSubscription.dispose();
            this.instances.delete(token);
            if (ownerId === this.currentOwner()) this.notify({ token, notification: { jsonrpc: "2.0", method: "ui/notifications/closed" } });
            return {};
        }
        if (app.closePromise) return app.closePromise;
        if (!app.closed) {
            app.closed = true;
            this.revokePageTools(app);
            app.abort.abort();
            if (ownerId === this.currentOwner()) this.notify({ token, notification: { jsonrpc: "2.0", method: "ui/notifications/closed" } });
            app.file?.watcher?.close();
            app.requests.clear();
        }
        app.closePromise = this.backend.command("manage", {
            operation: "mcpAppClose", projectId: app.projectId, threadId: app.threadId,
            instanceId: app.instanceId, generation: app.generation,
        }).then(reply => {
            this.instances.delete(token);
            if (!app.resultSourceKey && this.instanceTokens.get(app.instanceKey) === token) this.instanceTokens.delete(app.instanceKey);
            return reply;
        }).finally(() => { app.closePromise = undefined; });
        return app.closePromise;
    }
    notification(event) {
        if (
            !object(event) ||
            !object(event.notification) ||
            event.notification.jsonrpc !== "2.0" ||
            event.notification.id !== undefined ||
            ![
                "notifications/resources/updated",
                "notifications/tools/list_changed",
                "notifications/resources/list_changed",
                "ui/notifications/host-context-changed",
                "ui/notifications/closed",
            ].includes(event.notification.method)
        )
            return false;
        for (const [token, app] of this.instances) {
            if (
                app.projectId === event.projectId &&
                app.threadId === event.threadId &&
                app.instanceId === event.instanceId &&
                app.generation === event.generation &&
                !app.closed &&
                (event.notification.method === "ui/notifications/closed" || this.backend.ownsThread(app.projectId, app.threadId))
            ) {
                if (event.notification.method === "ui/notifications/closed")
                    void this.close(token, app.ownerId).catch(() => {});
                else this.notify({ token, notification: event.notification });
                return true;
            }
        }
        if (event.notification.method === "ui/notifications/closed") {
            let handled = false;
            for (const pending of this.resultOpens.values()) {
                if (pending.ownerId !== this.currentOwner() || pending.epoch !== this.epoch
                    || pending.projectId !== event.projectId || pending.threadId !== event.threadId) continue;
                const identity = JSON.stringify([event.instanceId, event.generation]);
                if (pending.closedInstances && !pending.closedInstances.has(identity)) {
                    if (pending.closedInstances.size === 8) pending.closedInstances = null;
                    else pending.closedInstances.add(identity);
                }
                handled = true;
            }
            return handled;
        }
        return false;
    }
    revokeInvalid() {
        const snapshot = this.backend.snapshot();
        if (snapshot.connection?.state && snapshot.connection.state !== "ready") return;
        for (const [token, app] of this.instances) {
            if (this.backend.ownsThread(app.projectId, app.threadId) || this.backend.retainsThreadResources(app.projectId, app.threadId)) continue;
            const owner = snapshot.projects.find(project => project.id === app.projectId);
            if (owner && !owner.state?.connected) continue;
            void this.close(token, app.ownerId).catch(() => {});
        }
    }
    dispose() {
        this.epoch++;
        for (const [token, app] of this.instances)
            void this.close(token, app.ownerId).catch(() => {});
    }
    async resource(request) {
        const url = new URL(request.url),
            app = this.instances.get(url.host);
        if (
            request.method !== "GET" ||
            !app ||
            app.closed ||
            !(app.kind === "genUi" ? genUiResource(app, url.pathname) : ["/", "/view"].includes(url.pathname)) ||
            url.search ||
            url.hash ||
            !this.backend.ownsThread(app.projectId, app.threadId)
        )
            return new Response("Not found", { status: 404 });
        if (app.kind === "genUi" && !["/", "/view"].includes(url.pathname)) return genUiResource(app, url.pathname, true);
        const proxy = url.pathname === "/";
        return new Response(proxy ? proxyHtml(!!app.resultSourceKey) : app.resource.html, {
            headers: {
                "Content-Type": "text/html; charset=utf-8",
                "Cache-Control": "no-store",
                "Referrer-Policy": "no-referrer",
                "Permissions-Policy":
                    "camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=()",
                "Content-Security-Policy": proxy
                    ? "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src 'self'; base-uri 'none'; object-src 'none'; form-action 'none'"
                    : app.csp,
            },
        });
    }
}
module.exports = { McpAppsHost, appCsp, parseDeepLink };
