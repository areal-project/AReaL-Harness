'use strict';

// 普通浏览沿用 Chromium 的代理、DNS 和站点策略；这里只隔离产品控制端点。
function httpUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url : null;
  } catch { return null; }
}
function loopback(host) {
  return host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || /^127\./.test(host);
}
function networkUrl(value, resourceType) {
  const url = httpUrl(value);
  if (url) return url;
  try {
    const socket = new URL(value);
    return resourceType === 'webSocket' && ['ws:', 'wss:'].includes(socket.protocol)
      && !socket.username && !socket.password ? socket : null;
  } catch { return null; }
}
function port(url) {
  return url.port || (['https:', 'wss:'].includes(url.protocol) ? '443' : '80');
}

class WorkspaceNetworkPolicy {
  constructor(controlEndpoint = () => null, ownsDevTools = () => false, ownsRequest = () => true) {
    this.controlEndpoint = controlEndpoint;
    this.ownsDevTools = ownsDevTools;
    this.ownsRequest = ownsRequest;
    this.frameGrants = new Map();
    this.active = true;
  }
  isControl(url) {
    const endpoints = this.controlEndpoint();
    for (const value of Array.isArray(endpoints) ? endpoints : [endpoints]) {
      let endpoint;
      try { endpoint = new URL(value); } catch { continue; }
      // 活动控制端口专用，防止 DNS 别名、重绑定及系统代理 fake-IP 绕过。
      // 同端口的其他站点也会拒绝；不对其他端口施加公网/私网地址分类。
      if (port(url) === port(endpoint)) return true;
    }
    return false;
  }
  allowHumanNavigation(value) { return this.authorize(value); }
  allowApprovedNavigation(value) { return this.authorize(value); }
  canAuthorize(value) {
    const url = httpUrl(value);
    return this.active && !!url && !this.isControl(url);
  }
  authorize(value) { return this.canAuthorize(value); }
  permitsDevTools(details) {
    let url;
    try { url = new URL(details.url); } catch { return false; }
    return this.active && url.protocol === 'devtools:' && url.hostname === 'devtools'
      && url.pathname.startsWith('/bundled/') && this.ownsDevTools(details.webContentsId);
  }
  bindFrameGrant(grant) {
    if (!this.canAuthorize(grant.origin)) throw new Error('嵌入站点被网络策略拒绝');
    this.frameGrants.set(grant.contents.id, grant);
  }
  revokeFrameGrant(contentsId) { this.frameGrants.delete(contentsId); }
  frameGrant(details) {
    const grant = this.frameGrants.get(details.webContentsId);
    return grant && grant.valid() ? grant : null;
  }
  permitsFrame(grant, details, url) {
    // Origin 许可不能被父页面的图片、fetch 或其他页面借用。
    const c = grant.contents, frame = details.frame;
    if (details.resourceType === 'mainFrame')
      return grant.status === 'reloading' && url.href === grant.parentURL;
    if (!frame || frame.isDestroyed()) return false;
    if (url.origin === new URL(grant.parentURL).origin)
      return frame.origin === url.origin;
    if (url.origin !== grant.origin || frame.parent !== c.mainFrame
      || frame.parent.url !== grant.parentURL) return false;
    if (details.resourceType === 'subFrame') return true;
    return frame.origin === grant.origin
      && ['script', 'stylesheet', 'image', 'font', 'xhr', 'media'].includes(details.resourceType);
  }
  permits(details) {
    if (this.permitsDevTools(details)) return true;
    const url = networkUrl(details.url, details.resourceType);
    if (!this.active || !url || this.isControl(url)) return false;
    if (!this.frameGrants.has(details.webContentsId)) return true;
    // Chromium 可在回调期间销毁 Frame；无法读取身份时拒绝，不能从权限检查抛出。
    try {
      const grant = this.frameGrant(details);
      return !!grant && this.permitsFrame(grant, details, url);
    } catch { return false; }
  }
  async permitsResolved(details) {
    // DNS 和代理由 Chromium 决定，不把 fake-IP 或本地网络当成权限判断。
    return this.permits(details);
  }
  install(session) {
    session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, respond) => {
      if (!this.ownsRequest(details)) { respond({ cancel: true }); return; }
      void this.permitsResolved(details, session).then(allowed => respond({ cancel: !allowed }),
        () => respond({ cancel: true }));
    });
    session.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, (details, respond) => {
      if (!this.ownsRequest(details)) { respond({ cancel: true }); return; }
      if (this.permitsDevTools(details)) { respond({}); return; }
      if (!this.permits(details)) { respond({ cancel: true }); return; }
      // 不增删站点 CSP、Connection-Allowlist 或下载响应头。
      respond({});
    });
  }
  close() { this.active = false; this.frameGrants.clear(); }
}

module.exports = { WorkspaceNetworkPolicy, loopback };
