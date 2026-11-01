// @ts-check
"use strict";
const { webUrl } = require("../preview/urls.cjs");
const { safeText } = require("../preview/diagnostics.cjs");
const { randomUUID } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const { readViewport } = require("./read-session.cjs");

const nativeControlReader = `function (key) {
  if (!Object.prototype.hasOwnProperty.call(globalThis, key)) {
    const get = (prototype, name) => Object.getOwnPropertyDescriptor(prototype, name).get;
    const tag = get(Element.prototype, 'tagName'), connected = get(Node.prototype, 'isConnected');
    const owner = get(Node.prototype, 'ownerDocument'), parent = get(Node.prototype, 'parentNode');
    const attr = Element.prototype.getAttribute, matches = Element.prototype.matches;
    const inputType = get(HTMLInputElement.prototype, 'type'), checked = get(HTMLInputElement.prototype, 'checked');
    const options = get(HTMLSelectElement.prototype, 'options'), multiple = get(HTMLSelectElement.prototype, 'multiple');
    const selectedIndex = get(HTMLSelectElement.prototype, 'selectedIndex');
    const optionValue = get(HTMLOptionElement.prototype, 'value'), label = get(HTMLOptionElement.prototype, 'label');
    const disabled = get(HTMLOptionElement.prototype, 'disabled'), selected = get(HTMLOptionElement.prototype, 'selected');
    const setIndex = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex').set;
    const dispatch = EventTarget.prototype.dispatchEvent, EventConstructor = Event;
    const identities = new WeakMap(); let next = 0;
    const identity = node => { if (!identities.has(node)) identities.set(node, ++next); return identities.get(node); };
    const isSensitive = node => /password|passcode|secret|token|api.?key|credit.?card|cc-|cvv|authorization|one.?time.?code|credential|file/i
      .test(['type', 'name', 'id', 'autocomplete', 'aria-label'].map(name => attr.call(node, name) || '').join(' '));
    const optionDisabled = option => {
      if (disabled.call(option)) return true;
      for (let node = parent.call(option); node; node = parent.call(node))
        if (node.nodeType === 1 && tag.call(node) === 'OPTGROUP' && attr.call(node, 'disabled') !== null) return true;
      return false;
    };
    const read = node => {
      if (!connected.call(node) || owner.call(node) !== document) return null;
      const name = tag.call(node);
      if (!['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(name)) return null;
      if (isSensitive(node)) return { kind: 'redacted', identity: identity(node) };
      const enabled = !matches.call(node, ':disabled'), base = { identity: identity(node), enabled };
      if (name === 'INPUT') {
        const type = inputType.call(node);
        return type === 'checkbox' ? { ...base, kind: 'checkbox', checked: checked.call(node) } : { ...base, kind: 'input', type };
      }
      if (name !== 'SELECT') return { ...base, kind: name.toLowerCase() };
      const collection = options.call(node), list = collection.length <= 64 ? Array.from(collection) : []; let bytes = 0;
      const complete = collection.length <= 64 && list.every(option => {
        const value = optionValue.call(option), text = label.call(option);
        bytes += new TextEncoder().encode(value + text).length;
        return owner.call(option) === document && connected.call(option) && value.length <= 256 && text.length <= 256 && bytes <= 8192
          && !/password|passcode|secret|token|api.?key|credit.?card|cvv|authorization|one.?time.?code|credential/i.test(value + ' ' + text);
      });
      return { ...base, kind: 'select', multiple: multiple.call(node), selectedIndex: selectedIndex.call(node),
        optionsComplete: complete, options: complete ? list.map(option => ({ identity: identity(option),
          value: optionValue.call(option), label: label.call(option), disabled: optionDisabled(option), selected: selected.call(option) })) : [] };
    };
    const select = (node, expected, value) => {
      const current = read(node);
      if (!current || current.kind !== 'select' || !current.enabled || current.multiple || !current.optionsComplete
        || !['identity', 'enabled', 'kind', 'multiple', 'selectedIndex', 'optionsComplete'].every(field => current[field] === expected[field])
        || current.options.length !== expected.options.length || current.options.some((option, index) =>
          !['identity', 'value', 'label', 'disabled', 'selected'].every(field => option[field] === expected.options[index][field])))
        return { accepted: false };
      const candidates = current.options.filter(option => option.value === value);
      if (candidates.length !== 1 || candidates[0].disabled) return { accepted: false };
      const index = current.options.indexOf(candidates[0]), list = options.call(node), option = list[index];
      if (!option || identity(option) !== candidates[0].identity) return { accepted: false };
      const noOp = selectedIndex.call(node) === index;
      if (!noOp) {
        setIndex.call(node, index);
        dispatch.call(node, new EventConstructor('input', { bubbles: true }));
        dispatch.call(node, new EventConstructor('change', { bubbles: true }));
      }
      return { accepted: true, noOp, control: read(node) };
    };
    Object.defineProperty(globalThis, key, { value: Object.freeze({ read, select }) });
  }
  return globalThis[key].read(this);
}`;
/** @param {import("./model.js").Page} page @param {import("./model.js").NativeControl|null|undefined} record */
function publicNativeControl(page, record) {
  if (!record || record.kind === "redacted") return undefined;
  const { identity: _identity, ...base } = record;
  if (base.kind !== "select") return base;
  const { selectedIndex, options, ...facts } = base;
  if (!options) return facts;
  return {
    ...facts,
    value: options[selectedIndex ?? -1]?.value ?? "",
    options: options.map(({ identity, ...option }) => {
      const key = `${record.identity}:${identity}`;
      if (!page.optionIds.has(key)) page.optionIds.set(key, randomUUID());
      return { optionId: page.optionIds.get(key), ...option };
    }),
  };
}
/**
 * @param {import("./model.js").Page} page
 * @param {string} url
 * @returns {Extract<import("./model.js").PublicSemantics,{kind:"link_navigation"}>}
 */
function linkNavigationIntent(page, url) {
  let destination;
  try {
    destination = new URL(webUrl(url));
  } catch {
    throw new Error("human_takeover_required");
  }
  if (!page.networkPolicy.canAuthorize(destination.href))
    throw new Error("human_takeover_required");
  return {
    kind: "link_navigation",
    method: "GET",
    targetOrigin: destination.origin,
    targetPath: destination.pathname,
    targetUrl: destination.href,
  };
}

class NativePageTargets {
  /**
   */
  constructor() {}
  /**
   * @param {import('./model.js').Page} page
   * @param {string|undefined} ref
   */
  refNode(page, ref) {
    const identity = [...page.refs].find(([, value]) => value === ref)?.[0];
    if (!identity) throw new Error("stale_ref");
    /** @type {[number,number,number,string,number]} */
    const [generation, documentEpoch, controlEpoch, frameId, backendNodeId] = JSON.parse(identity);
    if (
      generation !== page.pageGeneration ||
      documentEpoch !== page.documentGeneration ||
      controlEpoch !== page.controlEpoch ||
      frameId !== "main"
    )
      throw new Error("stale_ref");
    return { identity, backendNodeId };
  }

  /**
   * @param {import('./model.js').Page} page
   * @param {import('./model.js').WebContents} c
   * @param {string|undefined|{identity:string;backendNodeId:number}} ref
   * @returns {Promise<{identity:string;backendNodeId:number;control:import("./model.js").NativeControl|null}>}
   */
  async nativeControl(page, c, ref) {
    const node = typeof ref === "object" ? ref : this.refNode(page, ref);
    const frames = await c.debugger.sendCommand("Page.getFrameTree");
    const world = await c.debugger.sendCommand("Page.createIsolatedWorld", {
      frameId: frames.frameTree.frame.id,
      worldName: "areal-browser-native-controls",
    });
    const resolved = await c.debugger.sendCommand("DOM.resolveNode", {
      backendNodeId: node.backendNodeId,
      executionContextId: world.executionContextId,
    });
    const objectId = resolved.object?.objectId;
    if (!objectId) throw new Error("stale_ref");
    try {
      const result = await c.debugger.sendCommand("Runtime.callFunctionOn", {
        objectId,
        returnByValue: true,
        arguments: [{ value: page.nativeControlKey }],
        functionDeclaration: nativeControlReader,
      });
      if (result.exceptionDetails) throw new Error("target_unavailable");
      return { ...node, control: result.result?.value ?? null };
    } finally {
      await c.debugger.sendCommand("Runtime.releaseObject", { objectId }).catch(() => {});
    }
  }

  /**
   * @param {import('./model.js').Page} page
   * @param {import('./model.js').WebContents} c
   * @param {import('./model.js').NativeTarget} target
   * @param {import('./model.js').NativeControl} expected
   * @param {string} value
   * @param {(parameters:Record<string,unknown>) => Promise<import("./model.js").CdpResult<"Runtime.callFunctionOn">>} dispatch
   */
  async selectNativeOption(page, c, target, expected, value, dispatch) {
    const frames = await c.debugger.sendCommand("Page.getFrameTree");
    const world = await c.debugger.sendCommand("Page.createIsolatedWorld", {
      frameId: frames.frameTree.frame.id,
      worldName: "areal-browser-native-controls",
    });
    const resolved = await c.debugger.sendCommand("DOM.resolveNode", {
      backendNodeId: target.backendNodeId,
      executionContextId: world.executionContextId,
    });
    const objectId = resolved.object?.objectId;
    if (!objectId) throw new Error("stale_ref");
    try {
      return await dispatch({
        objectId,
        returnByValue: true,
        arguments: [{ value: expected }, { value }],
        functionDeclaration: `function (expected, value) {
          const registry = globalThis[${JSON.stringify(page.nativeControlKey)}];
          return registry ? registry.select(this, expected, value) : { accepted: false };
        }`,
      });
    } finally {
      await c.debugger.sendCommand("Runtime.releaseObject", { objectId }).catch(() => {});
    }
  }

  /**
   * @param {import('./model.js').Page} page
   * @param {import('./model.js').WebContents} c
   * @param {string|undefined} ref
   */
  async actionTarget(page, c, ref) {
    const { identity, backendNodeId } = this.refNode(page, ref);
    /** @type {import("./model.js").CdpResult<"Accessibility.getPartialAXTree">} */
    const ax = await c.debugger.sendCommand("Accessibility.getPartialAXTree", { backendNodeId });
    /** @type {import("./model.js").CdpResult<"DOM.describeNode">} */
    const dom = await c.debugger.sendCommand("DOM.describeNode", { backendNodeId, depth: 2 });
    /** @param {import("./model.js").DomNode|undefined} value */
    const isFileInput = (value) =>
      value?.nodeName?.toUpperCase() === "INPUT" &&
      value.attributes?.some(
        (attribute, index, attributes) =>
          index % 2 === 0 &&
          attribute.toLowerCase() === "type" &&
          attributes[index + 1]?.toLowerCase() === "file",
      );
    if (isFileInput(dom.node) || dom.node?.children?.some(isFileInput))
      throw new Error("human_takeover_required");
    const node = ax.nodes?.find((value) => value.backendDOMNodeId === backendNodeId);
    if (
      !node ||
      node.ignored ||
      node.properties?.some(
        (property) => property.name === "disabled" && property.value?.value === true,
      )
    )
      throw new Error("target_unavailable");
    /** @type {import("./model.js").CdpResult<"DOM.getContentQuads">} */
    const { quads = [] } = await c.debugger.sendCommand("DOM.getContentQuads", { backendNodeId });
    const viewport = await readViewport(c);
    for (const quad of quads) {
      if (quad.length !== 8) continue;
      const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
      const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
      if (
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        x < 0 ||
        y < 0 ||
        x >= viewport.width ||
        y >= viewport.height
      )
        continue;
      const hit = await c.debugger.sendCommand("DOM.getNodeForLocation", {
        x: Math.round(x),
        y: Math.round(y),
        includeUserAgentShadowDOM: false,
      });
      if (hit.backendNodeId !== backendNodeId) continue;
      return {
        identity,
        backendNodeId,
        x,
        y,
        viewport,
        role: safeText(node.role?.value, 80),
        name: safeText(node.name?.value, 256),
      };
    }
    throw new Error("target_unavailable");
  }

  /**
   * @param {import('./model.js').WebContents} c
   * @param {Pick<import('./model.js').NativeTarget,'backendNodeId'>} target
   * @param {Pick<import('./model.js').Action,'kind'|'key'>} action
   */
  async actionFacts(c, target, action) {
    const frames = await c.debugger.sendCommand("Page.getFrameTree");
    const world = await c.debugger.sendCommand("Page.createIsolatedWorld", {
      frameId: frames.frameTree.frame.id,
      worldName: "areal-browser-action-semantics",
    });
    const resolved = await c.debugger.sendCommand("DOM.resolveNode", {
      backendNodeId: target.backendNodeId,
      executionContextId: world.executionContextId,
    });
    const objectId = resolved.object?.objectId;
    if (!objectId) throw new Error("target_unavailable");
    let facts;
    try {
      const result = await c.debugger.sendCommand("Runtime.callFunctionOn", {
        objectId,
        returnByValue: true,
        arguments: [{ value: action.kind }, { value: action.key ?? null }],
        functionDeclaration: `function (kind, key) {
          const el = this, form = el.form || el.closest('form');
          const field = /^(INPUT|TEXTAREA)$/.test(el.tagName);
          const tokens = [el.type, el.name, el.id, el.autocomplete, el.getAttribute('aria-label')].join(' ');
          const sensitive = /password|passcode|secret|token|api.?key|credit.?card|cc-|cvv|authorization|one.?time.?code|credential|file/i;
          const search = !!form && (form.getAttribute('role') === 'search' || el.type === 'search'
            || Array.from(form.elements).some(item => /^(q|query|search|search_query)$/i.test(item.name)));
          const controls = form ? Array.from(form.elements) : [];
          // 空的无名文件辅助控件不参与表单提交；按钮文案不能把相邻搜索字段变成文件操作。
          const privateForm = sensitive.test(tokens) || controls.some(item => item.type !== 'button'
            && !(item.type === 'file' && !item.name && item.files?.length === 0)
            && sensitive.test([item.type, item.name, item.id, item.autocomplete, item.getAttribute('aria-label')].join(' ')));
          const submits = kind === 'click' && /^(submit|image)$/.test(el.type) || kind === 'press' && key === 'Enter' && field;
          const submitter = kind === 'click' ? el : controls.find(item => /^(submit|image)$/.test(item.type));
          let submittedFields = null, query = null, queryName = null, isQueryField = false;
          if (search && submits && !privateForm && controls.length <= 128) {
            const fields = [];
            const target = submitter?.getAttribute('formtarget') || form.target;
            const charset = (form.acceptCharset || document.characterSet).toLowerCase().replace(/-/g, '');
            let valid = (!target || target === '_self') && charset === 'utf8'
              && (!submitter || (submitter.type !== 'image' && !submitter.matches(':disabled')));
            // 不构造 FormData(form)：该 API 会触发网页 formdata 事件，审批读取不能改变页面。
            for (const item of controls) {
              if (!/^(INPUT|TEXTAREA|SELECT|BUTTON|FIELDSET|OUTPUT)$/.test(item.tagName)) { valid = false; break; }
              if (!item.name || item.matches(':disabled') || /^(FIELDSET|OUTPUT)$/.test(item.tagName)) continue;
              if (item.hasAttribute('dirname')) { valid = false; break; }
              if (/^(button|reset)$/.test(item.type) || /^(submit|image)$/.test(item.type) && item !== submitter) continue;
              if (/^(checkbox|radio)$/.test(item.type) && !item.checked) continue;
              if (item.type === 'image' || item.type === 'file') { valid = false; break; }
              const values = item.tagName === 'SELECT'
                ? Array.from(item.selectedOptions).filter(option => !option.disabled && !option.closest('optgroup[disabled]')).map(option => option.value)
                : [item.name === '_charset_' && item.type === 'hidden' ? 'UTF-8' : item.value];
              for (const value of values) {
                if (typeof value !== 'string' || item.name.length > 128 || value.length > 4096 || fields.length >= 64) { valid = false; break; }
                fields.push([item.name.replace(/\\r?\\n|\\r/g, '\\r\\n'), value.replace(/\\r?\\n|\\r/g, '\\r\\n')]);
              }
              if (!valid) break;
            }
            const queryControls = controls.filter(item => /^(INPUT|TEXTAREA)$/.test(item.tagName)
              && /^(text|search|textarea)$/.test(item.type)
              && (/^(q|query|search|search_query)$/i.test(item.name) || item.type === 'search'));
            const queryControl = queryControls.includes(el) ? el : queryControls.length === 1 ? queryControls[0] : null;
            queryName = queryControl?.name ?? null;
            isQueryField = queryControl === el;
            const queryField = fields.find(entry => entry[0] === queryName);
            if (valid && queryField && new TextEncoder().encode(JSON.stringify(fields)).length <= 8192) {
              submittedFields = fields; query = queryField[1];
            }
          }
          return { field, sensitive: privateForm, submittedFields, query, queryName, queryField: isQueryField,
            search, method: form ? (submits && submitter?.getAttribute('formmethod') || form.method || 'get').toLowerCase() : null,
            destination: el.closest('a[href]')?.href || (form ? submits && submitter?.hasAttribute('formaction') ? submitter.formAction : form.action : null),
            link: !!el.closest('a[href]'), download: !!el.closest('a[download]'),
            submit: !!form && /^(submit|image)$/.test(el.type),
            type: el.type || '', role: el.getAttribute('role') || '' };
        }`,
      });
      facts = result.result?.value;
    } finally {
      await c.debugger.sendCommand("Runtime.releaseObject", { objectId }).catch(() => {});
    }
    return facts;
  }

  /**
   * @param {import('./model.js').Page} page
   * @param {import('./model.js').WebContents} c
   * @param {Pick<import('./model.js').NativeTarget,'backendNodeId'>} target
   * @param {Pick<import('./model.js').Action,'kind'|'key'>} action
   * @returns {Promise<Extract<import("./model.js").PublicSemantics,{kind:"link_navigation"}>|null>}
   */
  async linkNavigationSemantics(page, c, target, action) {
    if (action.kind !== "click") return null;
    const facts = await this.actionFacts(c, target, action);
    if (!facts?.link || facts.download) return null;
    return linkNavigationIntent(page, facts.destination);
  }

  /**
   * @param {import('./model.js').Page} page
   * @param {import('./model.js').WebContents} c
   * @param {Pick<import('./model.js').NativeTarget,'backendNodeId'>} target
   * @param {Pick<import('./model.js').Action,'kind'|'key'>} action
   * @param {boolean} requireQueryField
   * @returns {Promise<import("./model.js").PublicSemantics>}
   */
  async publicActionSemantics(page, c, target, action, requireQueryField = false) {
    const facts = await this.actionFacts(c, target, action);
    if (!facts || facts.sensitive || (requireQueryField && !facts.queryField))
      throw new Error("human_takeover_required");
    if (action.kind === "fill" && facts.field && /^(text|search|textarea)$/.test(facts.type))
      return { kind: "edit_field" };
    if (action.kind === "press" && action.key !== "Enter" && facts.field)
      return { kind: "field_key" };
    const searchSubmit =
      facts.search &&
      facts.method === "get" &&
      ((action.kind === "press" && action.key === "Enter" && facts.field) ||
        (action.kind === "click" && facts.submit));
    if (
      searchSubmit &&
      (!Array.isArray(facts.submittedFields) ||
        typeof facts.query !== "string" ||
        typeof facts.queryName !== "string")
    )
      throw new Error("human_takeover_required");
    if (!searchSubmit && action.kind === "click" && facts.link && !facts.download)
      return linkNavigationIntent(page, facts.destination);
    if (searchSubmit) {
      let destination;
      try {
        destination = new URL(webUrl(facts.destination));
      } catch {
        throw new Error("human_takeover_required");
      }
      if (!page.networkPolicy.canAuthorize(destination.href))
        throw new Error("human_takeover_required");
      return {
        kind: "public_search",
        method: "GET",
        targetOrigin: destination.origin,
        targetPath: destination.pathname,
        query: facts.query,
        queryName: facts.queryName,
        submittedFields: facts.submittedFields,
        encodedQuery: new URLSearchParams(facts.submittedFields).toString(),
      };
    }
    if (action.kind === "click" && facts.field) return { kind: "focus_field" };
    throw new Error("human_takeover_required");
  }

  /**
   * @param {import('./model.js').Page} page
   * @param {string} url
   */
  acceptActionNavigation(page, url) {
    const intent = page.approvedActionNavigation;
    page.approvedActionNavigation = null;
    if (!intent || page.control !== "agent" || intent.controlEpoch !== page.controlEpoch)
      return false;
    try {
      const destination = new URL(webUrl(url));
      if (destination.origin !== intent.targetOrigin || destination.pathname !== intent.targetPath)
        return false;
      if (intent.kind !== "public_search") return intent.targetUrl === destination.href;
      if (
        intent.pageGeneration !== page.pageGeneration ||
        (intent.expiresAt ?? Infinity) < Date.now()
      )
        return false;
      if (typeof intent.queryName !== "string" || !intent.queryName) return false;
      const values = new URLSearchParams(intent.submittedFields).getAll(intent.queryName);
      // 网站脚本可改写辅助参数；延续权限仅绑定已批准查询的完整值与重数。
      if (
        !values.length ||
        !isDeepStrictEqual(destination.searchParams.getAll(intent.queryName), values)
      )
        return false;
      // 保留一次搜索的短时跳转链；导航不续期，人工撤权或下一次动作会清除此意图。
      page.approvedActionNavigation = intent;
      return true;
    } catch {
      return false;
    }
  }
}

module.exports = { NativePageTargets, publicNativeControl };
