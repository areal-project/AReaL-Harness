'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('arealDesktop', {
  presentReady: () => ipcRenderer.invoke('areal-core:present-ready'),
  updateState: () => ipcRenderer.invoke('areal-core:update-state'),
  downloadUpdate: () => ipcRenderer.invoke('areal-core:update-download'),
  recoverUpdateResources: () => ipcRenderer.invoke('areal-core:update-recover-resources'),
  onUpdate: listener => {
    const handler = (_event, value) => listener(value);
    ipcRenderer.on('areal-core:update-changed', handler);
    return () => ipcRenderer.removeListener('areal-core:update-changed', handler);
  },
  preview: request => ipcRenderer.invoke('areal-core:preview', request),
  onPreviewEvent: listener => {
    const handler = (_event, value) => listener(value);
    ipcRenderer.on('areal-core:preview-event', handler);
    return () => ipcRenderer.removeListener('areal-core:preview-event', handler);
  },
  snapshot: () => ipcRenderer.invoke('areal-core:snapshot'),
  chooseProject: () => ipcRenderer.invoke('areal-core:choose-project'),
  chooseProjectlessDirectory: () => ipcRenderer.invoke('areal-core:choose-projectless-directory'),
  fileOpen: request => ipcRenderer.invoke('areal-core:file-open', request),
  command: (name, params) => ipcRenderer.invoke('areal-core:command', name, params),
  theme: id => ipcRenderer.invoke('areal-core:theme', id),
  onNotificationOpen: listener => {
    let active = true, delivered = null;
    const handler = () => { void ipcRenderer.invoke('areal-core:notification-target').then(target => {
      if (!active || !target || delivered === target.id) return;
      delivered = target.id;
      listener(target.taskId
        ? { projectId: target.projectId, taskId: target.taskId, runId: target.runId, questionId: target.questionId }
        : { projectId: target.projectId, threadId: target.threadId });
      return ipcRenderer.invoke('areal-core:notification-consumed', target.id);
    }).catch(() => {}); };
    ipcRenderer.on('areal-core:notification-open', handler);
    handler(); // A click while the renderer was loading stays pending in Main.
    return () => { active = false; ipcRenderer.removeListener('areal-core:notification-open', handler); };
  },
  onState: listener => {
    const handler = (_event, value) => listener(value);
    ipcRenderer.on('areal-core:state', handler);
    return () => ipcRenderer.removeListener('areal-core:state', handler);
  },
  onTheme: listener => {
    const handler = (_event, value) => listener(value);
    ipcRenderer.on('areal-core:theme-changed', handler);
    return () => ipcRenderer.removeListener('areal-core:theme-changed', handler);
  },
});
