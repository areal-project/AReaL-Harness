"use strict";
const { contextBridge, ipcRenderer } = require("electron");

// 仅测试夹具加载；真实预览仍无 preload 或产品 bridge。
contextBridge.exposeInMainWorld("feasibility", {
    takeover: () => ipcRenderer.invoke("browser-feasibility-takeover"),
    unfreeze: () => ipcRenderer.invoke("browser-feasibility-unfreeze"),
});
