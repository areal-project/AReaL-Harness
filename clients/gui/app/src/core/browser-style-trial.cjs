'use strict';

// This is a Main-owned, human-only edit vocabulary. No selector, CSS text,
// script, or object id crosses the Renderer IPC boundary.
const properties = new Set(['text', 'color', 'background-color', 'font-size', 'font-weight',
  'font-family', 'letter-spacing', 'line-height', 'margin', 'margin-top', 'margin-right',
  'margin-bottom', 'margin-left', 'padding', 'padding-top', 'padding-right',
  'padding-bottom', 'padding-left', 'width', 'height']);
const color = /^(?:#[0-9a-fA-F]{3,8}|(?:rgb|rgba|hsl|hsla)\([0-9.,%\s]+\))$/;
const length = /^(?:0|(?:0|[1-9]\d{0,3})(?:\.\d{1,2})?(?:px|rem|em|%|vh|vw))(?:\s+(?:0|(?:0|[1-9]\d{0,3})(?:\.\d{1,2})?(?:px|rem|em|%|vh|vw))){0,3}$/;
function validateEdit(property, value) {
  if (!properties.has(property) || typeof value !== 'string' || value.length > 500) throw new Error('不支持此页面试改');
  if (property === 'text') {
    if (value.length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new Error('无效文本');
  } else if (property === 'color' || property === 'background-color') {
    if (!color.test(value)) throw new Error('无效颜色');
  } else if (property === 'font-family') {
    if (!/^[a-zA-Z][a-zA-Z\d -]{0,79}$/.test(value)) throw new Error('无效字体');
  } else if (property === 'font-weight') {
    if (!/^(?:normal|bold|[1-9]00)$/.test(value)) throw new Error('无效字重');
  } else if (property === 'line-height') {
    if (!length.test(value) && !/^(?:normal|[1-9](?:\.\d{1,2})?)$/.test(value)) throw new Error('无效行高');
  } else if (!length.test(value)) throw new Error('无效尺寸或间距');
  // Text is assigned to an existing text node, never parsed as CSS or HTML.
  if (property !== 'text' && /(?:url\s*\(|@import|expression\s*\(|javascript:|[;{}\\])/i.test(value))
    throw new Error('页面试改不能包含脚本或外部资源');
}

// Fixed trusted code runs in a Chromium isolated world against a node resolved
// by the private backend id selected by the native human inspect overlay.
const inspect = `function(property, checks, replacement) {
  if (!(this instanceof Element) || !this.isConnected || this.ownerDocument !== document)
    return { stale: true };
  if (property === 'text' && (this.matches('input,textarea,select') || this.isContentEditable
    || this.childNodes.length !== 1 || this.firstChild.nodeType !== Node.TEXT_NODE)) return { stale: true };
  for (const check of checks) {
    const actual = check.property === 'text'
      ? { value: this.textContent ?? '', priority: '' }
      : { value: this.style.getPropertyValue(check.property), priority: this.style.getPropertyPriority(check.property) };
    if (actual.value !== check.expected.value || actual.priority !== check.expected.priority) return { stale: true };
  }
  const current = property === 'text'
    ? { value: this.textContent ?? '', priority: '' }
    : { value: this.style.getPropertyValue(property), priority: this.style.getPropertyPriority(property) };
  if (current.value.length > 500) return { stale: true };
  if (replacement !== null) {
    if (property === 'text') this.firstChild.nodeValue = replacement.value;
    else if (replacement.value === '') this.style.removeProperty(property);
    else this.style.setProperty(property, replacement.value, replacement.priority);
  }
  const after = property === 'text'
    ? { value: this.textContent ?? '', priority: '' }
    : { value: this.style.getPropertyValue(property), priority: this.style.getPropertyPriority(property) };
  return { stale: false, before: current, after };
}`;

async function mutate(c, backendNodeId, property, checks, replacement, bounded) {
  if (c.debugger.isAttached()) throw new Error('页面正由其他原生操作占用');
  c.debugger.attach('1.3');
  try {
    const send = (method, params = {}) => bounded(c.debugger.sendCommand(method, params));
    const frames = await send('Page.getFrameTree');
    const frameId = frames.frameTree?.frame?.id;
    if (!frameId) throw new Error('页面文档不可用');
    const world = await send('Page.createIsolatedWorld', { frameId, worldName: 'areal-human-style-trial' });
    const resolved = await send('DOM.resolveNode', { backendNodeId, executionContextId: world.executionContextId });
    if (!resolved.object?.objectId) return { stale: true };
    const result = await send('Runtime.callFunctionOn', { objectId: resolved.object.objectId,
      functionDeclaration: inspect, arguments: [property, checks, replacement].map(value => ({ value })),
      returnByValue: true, silent: true });
    if (result.exceptionDetails || !result.result?.value) return { stale: true };
    return result.result.value;
  } catch { return { stale: true }; }
  finally { if (!c.isDestroyed() && c.debugger.isAttached()) c.debugger.detach(); }
}

module.exports = { validateEdit, mutate };
