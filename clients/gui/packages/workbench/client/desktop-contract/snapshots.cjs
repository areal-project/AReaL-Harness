// @ts-check
"use strict";
/** @typedef {'shift'|'meta'|'control'|'alt'} SnapShotModifier */
/** @typedef {{key:string,metaKey:boolean,ctrlKey:boolean,shiftKey:boolean,altKey:boolean,modKey:boolean}} SnapShotKeyChord */
/** @typedef {{kind:'both-shift-keys'}|{kind:'modifier-pair',modifier:SnapShotModifier}|SnapShotKeyChord} SnapShotShortcut */
/** @typedef {{snapShotEnabled:boolean,snapShotIncludeAccessibility:boolean,snapShotShortcut:SnapShotShortcut,snapShotPlaySound:boolean,snapShotSound:'soft-pop'|'camera-shutter',snapShotFlash:boolean,snapShotAnimations:boolean,setupStep?:'access'|'shortcut'|'complete'}} SnapShotSettings */
/** @typedef {{x:number,y:number,width:number,height:number}} SnapShotBounds */
/** @typedef {{active?:boolean,busy?:boolean,checked?:'on'|'off'|'mixed',editable?:boolean,enabled?:boolean,expanded?:boolean,focused?:boolean,selected?:boolean,visible?:boolean}} SnapShotAccessibilityState */
/** @typedef {{role:string,name?:string,value?:string,description?:string,bounds:SnapShotBounds|null,state?:SnapShotAccessibilityState,actions?:string[],children:SnapShotAccessibilityNode[]}} SnapShotAccessibilityNode */
/** @typedef {{format:'flat-text',text:string,truncated:boolean}|{format:'element-tree',coordinateSpace:'captured-image',imageSize:{width:number,height:number},truncated:boolean,root:SnapShotAccessibilityNode}} SnapShotAccessibility */
/** @typedef {{kind:'snap-shot',capturedAt:string,appName:string,windowTitle:string,accessibleText?:string,accessibility?:SnapShotAccessibility,appIdentifier?:string,appIconDataUrl?:string}} SnapShotSource */
/** @typedef {{id:string,name:string,mimeType:'image/png',sizeBytes:number,source:SnapShotSource}} DesktopPendingSnapShot */
/** @typedef {DesktopPendingSnapShot & {dataUrl:string}} DesktopSnapShot */
/** @typedef {{mode:'direct'|'unavailable',settings:SnapShotSettings,shortcut:SnapShotShortcut,shortcutRegistered:boolean,shortcutPending?:boolean,shortcutCanRetry?:boolean,shortcutLabel?:string,shortcutMessage:string|null,macPermissions?:{screenRecording:boolean,accessibility:boolean},shortcutVerified?:boolean,message:string|null}} DesktopSnapShotState */
/** @typedef {{type:'requested'|'started'|'ready',id:string}|{type:'failed',id?:string,message?:string}|{type:'shortcut-changed'}} DesktopSnapShotEvent */
/** @typedef {{id:string,viewportFrame:SnapShotBounds,backgroundColor:string,borderColor:string,borderWidth:number,cornerRadius:number,details?:Pick<SnapShotSource,'appName'|'windowTitle'|'appIconDataUrl'>}} DesktopSnapShotAnimationDestination */
/** @typedef {'test-mac-capture'|'allow-screen-recording'|'allow-accessibility'|'retry-shortcut'} DesktopSnapShotSetupAction */
/** @typedef {{available:boolean,message:string|null}} DesktopSnapShotShortcutAvailability */
/** @typedef {{getSnapShotState:()=>Promise<DesktopSnapShotState>,requestSnapShotPermissions:(includeAccessibility:boolean)=>Promise<void>,setupSnapShot:(action:DesktopSnapShotSetupAction)=>Promise<void>,captureSnapShot:()=>Promise<void>,checkSnapShotShortcut:(shortcut:SnapShotShortcut)=>Promise<DesktopSnapShotShortcutAvailability>,setSnapShotShortcutSuppressed:(suppressed:boolean)=>Promise<void>,listPendingSnapShots:()=>Promise<readonly DesktopPendingSnapShot[]>,readSnapShot:(id:string)=>Promise<DesktopSnapShot>,setSnapShotAnimationDestination:(destination:DesktopSnapShotAnimationDestination)=>Promise<void>,dismissSnapShotAnimation:(id:string)=>Promise<void>,acknowledgeSnapShot:(id:string)=>Promise<void>,onSnapShotEvent:(listener:(event:DesktopSnapShotEvent)=>void)=>()=>void}} SnapShotServices */
const SNAP_SHOT_ACCESSIBLE_TEXT_MAX_CHARS = 32000;
const SNAP_SHOT_ACCESSIBILITY_MAX_SERIALIZED_CHARS = 32000;
const SNAP_SHOT_ACCESSIBILITY_MAX_NODES = 10000;
/** @type {SnapShotSettings} */
const DEFAULT_SNAP_SHOT_SETTINGS = Object.freeze({
  snapShotEnabled: false,
  snapShotIncludeAccessibility: true,
  snapShotShortcut: /** @type {SnapShotShortcut} */ ({ kind: "both-shift-keys" }),
  snapShotPlaySound: true,
  snapShotSound: "soft-pop",
  snapShotFlash: true,
  snapShotAnimations: true,
});
/** @param {unknown} value @returns {value is Record<string,unknown>} */
const record = (value) => !!value && typeof value === "object" && !Array.isArray(value);
/** @param {unknown} value @returns {value is SnapShotShortcut} */
function isSnapShotShortcut(value) {
  if (!record(value)) return false;
  if (value.kind === "both-shift-keys") return true;
  if (value.kind === "modifier-pair")
    return ["shift", "meta", "control", "alt"].includes(String(value.modifier));
  return (
    typeof value.key === "string" &&
    value.key.length > 0 &&
    value.key.length <= 64 &&
    [...value.key].every((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127;
    }) &&
    ["metaKey", "ctrlKey", "shiftKey", "altKey", "modKey"].every(
      (key) => typeof value[key] === "boolean",
    ) &&
    ["metaKey", "ctrlKey", "shiftKey", "altKey", "modKey"].some((key) => value[key] === true)
  );
}
/** @param {unknown} value @returns {SnapShotShortcut} */
function readSnapShotShortcut(value) {
  if (!isSnapShotShortcut(value)) throw new Error("Invalid SnapShot shortcut");
  return value;
}
/** @param {unknown} value @returns {value is SnapShotSettings} */
function isSnapShotSettings(value) {
  return (
    record(value) &&
    [
      "snapShotEnabled",
      "snapShotIncludeAccessibility",
      "snapShotPlaySound",
      "snapShotFlash",
      "snapShotAnimations",
    ].every((key) => typeof value[key] === "boolean") &&
    isSnapShotShortcut(value.snapShotShortcut) &&
    ["soft-pop", "camera-shutter"].includes(String(value.snapShotSound)) &&
    (value.setupStep === undefined ||
      ["access", "shortcut", "complete"].includes(String(value.setupStep)))
  );
}
/** @param {unknown} value @returns {SnapShotSettings} */
function readSnapShotSettings(value) {
  if (value === undefined || value === null) return { ...DEFAULT_SNAP_SHOT_SETTINGS };
  if (!isSnapShotSettings(value)) throw new Error("Invalid SnapShot settings");
  return value;
}
/** @param {SnapShotShortcut} shortcut @returns {shortcut is Extract<SnapShotShortcut,{kind:string}>} */
function isModifierPairShortcut(shortcut) {
  return "kind" in shortcut;
}
/** @param {Extract<SnapShotShortcut,{kind:string}>} shortcut @returns {SnapShotModifier} */
function snapShotShortcutModifierPair(shortcut) {
  return shortcut.kind === "both-shift-keys" ? "shift" : shortcut.modifier;
}
/** @param {SnapShotModifier} modifier @param {boolean} apple */
function snapShotModifierPairLabel(modifier, apple) {
  return (
    "Both " +
    {
      shift: "Shift",
      meta: apple ? "Command" : "Super",
      control: "Control",
      alt: apple ? "Option" : "Alt",
    }[modifier] +
    " Keys"
  );
}
/** @param {unknown} value @returns {string} */
function readSnapShotId(value) {
  if (typeof value !== "string" || !/^[a-f0-9-]{1,64}$/i.test(value))
    throw new Error("Invalid SnapShot id");
  return value;
}
/** @param {unknown} value @returns {value is SnapShotBounds} */
function bounds(value) {
  return (
    record(value) &&
    ["x", "y", "width", "height"].every(
      (key) => typeof value[key] === "number" && Number.isFinite(value[key]),
    ) &&
    Number(value.width) > 0 &&
    Number(value.height) > 0
  );
}
/** @param {unknown} value @returns {value is SnapShotAccessibility} */
function accessibility(value) {
  if (!record(value) || typeof value.truncated !== "boolean") return false;
  if (value.format === "flat-text")
    return typeof value.text === "string" && value.text.length <= 32000;
  if (
    value.format !== "element-tree" ||
    value.coordinateSpace !== "captured-image" ||
    !record(value.imageSize) ||
    !(Number(value.imageSize.width) > 0 && Number(value.imageSize.height) > 0)
  )
    return false;
  const stack = [value.root];
  let count = 0;
  while (stack.length) {
    const node = stack.pop();
    if (
      ++count > 10000 ||
      !record(node) ||
      typeof node.role !== "string" ||
      !Array.isArray(node.children) ||
      !(node.bounds === null || bounds(node.bounds))
    )
      return false;
    stack.push(...node.children);
  }
  return JSON.stringify(value).length <= 32000;
}
/** @param {unknown} value @returns {value is SnapShotSource} */
function isSnapShotSource(value) {
  return (
    record(value) &&
    value.kind === "snap-shot" &&
    typeof value.capturedAt === "string" &&
    Number.isFinite(Date.parse(value.capturedAt)) &&
    typeof value.appName === "string" &&
    value.appName.length > 0 &&
    value.appName.length <= 255 &&
    typeof value.windowTitle === "string" &&
    value.windowTitle.length <= 1000 &&
    (value.accessibleText === undefined ||
      (typeof value.accessibleText === "string" && value.accessibleText.length <= 32000)) &&
    (value.accessibility === undefined || accessibility(value.accessibility)) &&
    (value.appIdentifier === undefined ||
      (typeof value.appIdentifier === "string" && value.appIdentifier.length <= 255)) &&
    (value.appIconDataUrl === undefined ||
      (typeof value.appIconDataUrl === "string" &&
        value.appIconDataUrl.length <= 100000 &&
        /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(value.appIconDataUrl)))
  );
}
/** @param {unknown} value @returns {DesktopPendingSnapShot} */
function readPendingSnapShot(value) {
  if (
    !record(value) ||
    typeof value.name !== "string" ||
    value.mimeType !== "image/png" ||
    !Number.isSafeInteger(value.sizeBytes) ||
    Number(value.sizeBytes) <= 0 ||
    Number(value.sizeBytes) > 16 * 1024 * 1024 ||
    !isSnapShotSource(value.source)
  )
    throw new Error("Invalid pending SnapShot");
  readSnapShotId(value.id);
  return /** @type {DesktopPendingSnapShot} */ (value);
}
/** @param {unknown} value @returns {DesktopSnapShot} */
function readSnapShot(value) {
  const pending = readPendingSnapShot(value);
  if (
    !record(value) ||
    typeof value.dataUrl !== "string" ||
    !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(value.dataUrl) ||
    value.dataUrl.length > 24 * 1024 * 1024
  )
    throw new Error("Invalid SnapShot image");
  return { ...pending, dataUrl: value.dataUrl };
}
/** @param {unknown} value @returns {DesktopSnapShotState} */
function readSnapShotState(value) {
  if (
    !record(value) ||
    !["direct", "unavailable"].includes(String(value.mode)) ||
    typeof value.shortcutRegistered !== "boolean" ||
    !isSnapShotSettings(value.settings) ||
    !["shortcutPending", "shortcutCanRetry", "shortcutVerified"].every(
      (key) => value[key] === undefined || typeof value[key] === "boolean",
    ) ||
    !(value.shortcutLabel === undefined || typeof value.shortcutLabel === "string") ||
    !(
      value.macPermissions === undefined ||
      (record(value.macPermissions) &&
        typeof value.macPermissions.screenRecording === "boolean" &&
        typeof value.macPermissions.accessibility === "boolean")
    ) ||
    !(value.shortcutMessage === null || typeof value.shortcutMessage === "string") ||
    !(value.message === null || typeof value.message === "string")
  )
    throw new Error("Invalid SnapShot state");
  readSnapShotShortcut(value.shortcut);
  return /** @type {DesktopSnapShotState} */ (value);
}
/** @param {unknown} value @returns {DesktopSnapShotEvent} */
function readSnapShotEvent(value) {
  if (
    !record(value) ||
    !["requested", "started", "ready", "failed", "shortcut-changed"].includes(String(value.type)) ||
    !(value.message === undefined || typeof value.message === "string")
  )
    throw new Error("Invalid SnapShot event");
  if (value.type !== "shortcut-changed" && (value.type !== "failed" || value.id !== undefined))
    readSnapShotId(value.id);
  return /** @type {DesktopSnapShotEvent} */ (value);
}
/** @param {unknown} value @returns {DesktopSnapShotAnimationDestination} */
function readSnapShotAnimationDestination(value) {
  if (
    !record(value) ||
    !bounds(value.viewportFrame) ||
    !["backgroundColor", "borderColor"].every(
      (key) => typeof value[key] === "string" && String(value[key]).length <= 100,
    ) ||
    !["borderWidth", "cornerRadius"].every(
      (key) =>
        typeof value[key] === "number" &&
        Number.isFinite(value[key]) &&
        Number(value[key]) >= 0 &&
        Number(value[key]) <= 1000,
    )
  )
    throw new Error("Invalid SnapShot destination");
  readSnapShotId(value.id);
  if (
    value.details !== undefined &&
    (!record(value.details) ||
      typeof value.details.appName !== "string" ||
      value.details.appName.length > 255 ||
      typeof value.details.windowTitle !== "string" ||
      value.details.windowTitle.length > 1000 ||
      (value.details.appIconDataUrl !== undefined &&
        (typeof value.details.appIconDataUrl !== "string" ||
          value.details.appIconDataUrl.length > 100000 ||
          !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(value.details.appIconDataUrl))))
  )
    throw new Error("Invalid SnapShot details");
  return /** @type {DesktopSnapShotAnimationDestination} */ (value);
}
module.exports = {
  DEFAULT_SNAP_SHOT_SETTINGS,
  SNAP_SHOT_ACCESSIBLE_TEXT_MAX_CHARS,
  SNAP_SHOT_ACCESSIBILITY_MAX_SERIALIZED_CHARS,
  SNAP_SHOT_ACCESSIBILITY_MAX_NODES,
  isSnapShotShortcut,
  readSnapShotShortcut,
  isSnapShotSettings,
  readSnapShotSettings,
  isModifierPairShortcut,
  snapShotShortcutModifierPair,
  snapShotModifierPairLabel,
  readSnapShotId,
  isSnapShotSource,
  readPendingSnapShot,
  readSnapShot,
  readSnapShotState,
  readSnapShotEvent,
  readSnapShotAnimationDestination,
};
